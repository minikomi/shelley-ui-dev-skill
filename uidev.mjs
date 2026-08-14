#!/usr/bin/env node
// Shelley UI dev loop, external to any checkout.
//
// Starts, from the CURRENT COMMIT of a shelley checkout:
//   1. an initial UI build, then a watch that rebuilds ui/dist on save
//   2. a stock shelley (go run, no patches) on the backend port
//   3. a proxy on the front port that serves UI assets fresh from ui/dist
//      and forwards everything else (API, SSE, WebSockets) to the backend
//
// Point a browser at the front port: edit ui/src, wait for "UI built",
// reload. CSS, JS, components — everything except Go code — updates live
// with no Go build and no restart. For instant CSS experiments without even
// a build, POST rules to /__uidev__/css (see the proxy section below).
//
// Usage: node uidev.mjs <checkout-dir> [--port 8004] [--backend-port 8003]
//        [--db /tmp/shelley-ui-dev.db] [--config <file>] [--real-models]
//        [--attach <port>]
// Default is --predictable-only with a scratch DB, so it cannot disturb
// real conversations and needs no model credentials. --real-models drops
// --predictable-only (requires --config). --attach <port> spawns NO backend
// and proxies to an already-running shelley on that port instead — e.g. the
// main instance — overlaying its UI with fresh assets from the checkout.

import { spawn, spawnSync } from "node:child_process";
import { watch, existsSync, statSync, createReadStream, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve, extname, normalize } from "node:path";

const args = process.argv.slice(2);
const checkout = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const PORT = Number(opt("--port", "8004"));
const ATTACH = opt("--attach", null);
const BACKEND = ATTACH ? Number(ATTACH) : Number(opt("--backend-port", "8003"));
const DB = opt("--db", "/tmp/shelley-ui-dev.db");
const CONFIG = opt("--config", null);
const REAL = args.includes("--real-models");
const USER = opt("--user", null); // inject X-Exedev-Userid for localhost callers when absent

const uiDir = join(checkout, "ui");
const distDir = join(uiDir, "dist");
const srcDir = join(uiDir, "src");
if (!existsSync(join(uiDir, "scripts/build.js"))) {
  console.error(`${checkout} does not look like a shelley checkout (no ui/scripts/build.js)`);
  process.exit(1);
}
if (REAL && !CONFIG) {
  console.error("--real-models requires --config");
  process.exit(1);
}

// ---- 1. initial build + watch ----------------------------------------

function buildOnce() {
  const r = spawnSync("node", ["scripts/build.js", "--watch"], { cwd: uiDir, stdio: "inherit" });
  return r.status === 0;
}

console.log("[uidev] installing UI deps…");
if (spawnSync("pnpm", ["install", "--frozen-lockfile", "--silent"], { cwd: uiDir, stdio: "inherit" }).status !== 0)
  process.exit(1);
console.log("[uidev] initial UI build…");
if (!buildOnce()) process.exit(1);

let building = false, queued = false;
function rebuild() {
  if (building) { queued = true; return; }
  building = true;
  const child = spawn("node", ["scripts/build.js", "--watch"], { cwd: uiDir, stdio: "inherit" });
  child.on("exit", (code) => {
    building = false;
    if (code !== 0) console.error("[uidev] build failed; waiting for the next change");
    if (queued) { queued = false; rebuild(); }
  });
}
let timer = null;
watch(srcDir, { recursive: true }, (_e, f) => {
  if (f && (f.includes("node_modules") || f.endsWith("~"))) return;
  clearTimeout(timer);
  timer = setTimeout(rebuild, 100);
});
console.log(`[uidev] watching ${srcDir}`);

// ---- 2. backend shelley (stock, current commit) -----------------------

if (ATTACH) {
  console.log(`[uidev] attach mode: proxying to existing shelley on :${BACKEND}, no backend spawned`);
} else {
  const serveArgs = ["run", "./cmd/shelley"];
  if (!REAL) serveArgs.push("--predictable-only");
  serveArgs.push("--db", DB);
  if (CONFIG) serveArgs.push("-config", CONFIG);
  serveArgs.push("serve", "-port", String(BACKEND));
  console.log(`[uidev] starting backend: go ${serveArgs.join(" ")}`);
  const backend = spawn("go", serveArgs, { cwd: checkout, stdio: "inherit" });
  backend.on("exit", (code) => {
    console.error(`[uidev] backend exited (${code}); shutting down`);
    process.exit(code ?? 1);
  });
  process.on("exit", () => backend.kill());
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

// ---- 3. proxy: dist/ overlay in front of the backend -------------------

// CSS injection: POST /__uidev__/css with a CSS body puts those rules in a
// <style id="uidev-css"> element on every open page, instantly — no build,
// no reload. POST an empty body to clear. Pages pick the current injection
// up on load too, so a manual reload keeps it until cleared.
//   curl -X POST --data-binary '.send-split-btn{background:green}' localhost:8004/__uidev__/css
const sseClients = new Set();
let injectedCSS = "";

// Component stage: POST markup to /__stage__/html and open /__stage__ — a
// minimal page that renders just that markup against the real built
// stylesheets. No Vue, no app, no state: stage pages auto-refresh on new
// markup, on CSS injection, and on every dist rebuild. Capture markup from
// the live page with browser eval:
//   document.querySelector('.some-component').outerHTML
// then POST it:
//   curl -X POST --data-binary '<button class="send-split-main">hi</button>' localhost:8004/__stage__/html
const STAGE_FILE = "/tmp/uidev-stage.html";
let stageHTML = existsSync(STAGE_FILE) ? readFileSync(STAGE_FILE, "utf8") : "<p>POST markup to /__stage__/html</p>";

// Notify stage pages when a build lands (they reload; the real app does not).
let lastBuildStamp = "";
function buildStamp() {
  try { return statSync(join(distDir, "build-info.json")).mtimeMs + ""; } catch { return lastBuildStamp; }
}
lastBuildStamp = buildStamp();
setInterval(() => {
  const s = buildStamp();
  if (s === lastBuildStamp) return;
  lastBuildStamp = s;
  for (const c of sseClients) c.write("event: build\ndata: 1\n\n");
}, 500);

function stagePage() {
  // Use the same stylesheets, in the same order, as the real app.
  let links = "";
  try {
    const idx = readFileSync(join(distDir, "index.html"), "utf8");
    links = (idx.match(/<link[^>]*stylesheet[^>]*>/g) ?? []).join("\n");
  } catch {}
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>uidev stage</title>
${links}
<style>body{padding:2rem;background:var(--gray-50,#f9fafb)}.uidev-stage-bar{position:fixed;top:0;left:0;right:0;font:11px monospace;background:#111;color:#7c7;padding:2px 8px;z-index:99999}#stage{margin-top:2rem}</style>
</head><body>
<div class="uidev-stage-bar">uidev stage — markup: POST /__stage__/html · css: POST /__uidev__/css · auto-refreshes on rebuild</div>
<div id="stage">${stageHTML}</div>
<script>(function(){
var s=new EventSource("/__uidev__/events");
s.onmessage=function(e){
  var el=document.getElementById("uidev-css");
  if(!el){el=document.createElement("style");el.id="uidev-css";document.head.appendChild(el);}
  el.textContent=JSON.parse(e.data);
};
s.addEventListener("stage",function(e){document.getElementById("stage").innerHTML=JSON.parse(e.data);});
s.addEventListener("build",function(){location.reload();});
})()</script>
</body></html>`;
}

const INJECT_SNIPPET = `<script>(function(){
function apply(css){
  var el=document.getElementById("uidev-css");
  if(!el){el=document.createElement("style");el.id="uidev-css";document.head.appendChild(el);}
  el.textContent=css;
}
var s=new EventSource("/__uidev__/events");
s.onmessage=function(e){apply(JSON.parse(e.data));};
})()</script>`;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".map": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2",
};

// Serve from dist when the file exists there (possibly as .gz); otherwise null.
function distFile(urlPath, accept) {
  let p = decodeURIComponent(urlPath.split("?")[0]);
  // SPA routes (browser navigations, e.g. /c/slug) get the app shell; API
  // paths are extension-less too but never Accept text/html first.
  if (p === "/" || (!extname(p) && /^text\/html/.test(accept ?? ""))) p = "/index.html";
  const file = normalize(join(distDir, p));
  if (!file.startsWith(distDir)) return null; // traversal
  if (existsSync(file) && statSync(file).isFile()) return { file, gzip: false };
  if (existsSync(file + ".gz")) return { file: file + ".gz", gzip: true };
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === "/__uidev__/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(injectedCSS)}\n\n`); // current injection on connect
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.url === "/__uidev__/css" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      injectedCSS = body;
      console.log(`[uidev] injected CSS ${body ? `(${body.length} bytes)` : "cleared"} → ${sseClients.size} page(s)`);
      for (const c of sseClients) c.write(`data: ${JSON.stringify(injectedCSS)}\n\n`);
      res.writeHead(200);
      res.end("ok\n");
    });
    return;
  }
  if (req.url === "/__stage__" || req.url.startsWith("/__stage__?")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(stagePage());
  }
  if (req.url === "/__stage__/html" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stageHTML = body || "<p>POST markup to /__stage__/html</p>";
      try { writeFileSync(STAGE_FILE, stageHTML); } catch {}
      console.log(`[uidev] stage markup set (${body.length} bytes) → ${sseClients.size} page(s)`);
      for (const c of sseClients) c.write(`event: stage\ndata: ${JSON.stringify(stageHTML)}\n\n`);
      res.writeHead(200);
      res.end("ok\n");
    });
    return;
  }
  const hit = (req.method === "GET" || req.method === "HEAD") && distFile(req.url, req.headers.accept);
  if (hit) {
    const ext = extname(hit.file.replace(/\.gz$/, ""));
    if (ext === ".html" && !hit.gzip) {
      // Inject the CSS-injection listener. HTML is small; read it whole.
      const html = readFileSync(hit.file, "utf8").replace("</body>", INJECT_SNIPPET + "</body>");
      res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "no-store" });
      return res.end(req.method === "HEAD" ? undefined : html);
    }
    res.writeHead(200, {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store", // always fresh; the whole point
      ...(hit.gzip ? { "Content-Encoding": "gzip" } : {}),
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(hit.file).pipe(res);
    return;
  }
  const headers = { ...req.headers };
  if (USER && !headers["x-exedev-userid"]) headers["x-exedev-userid"] = USER;
  const up = http.request(
    { host: "127.0.0.1", port: BACKEND, path: req.url, method: req.method, headers },
    (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); },
  );
  up.on("error", () => { res.writeHead(502); res.end("backend not ready"); });
  req.pipe(up);
});

// WebSocket (terminals) pass-through.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(BACKEND, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    if (USER && !req.headers["x-exedev-userid"]) raw += `X-Exedev-Userid: ${USER}\r\n`;
    up.write(raw + "\r\n");
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, () => {
  console.log(`[uidev] UI dev server on http://localhost:${PORT} (backend :${BACKEND}, assets live from ${distDir})`);
});
