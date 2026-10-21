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
//        [--attach <port>] [--chat <conversation-id>]
// Default is --predictable-only with a scratch DB, so it cannot disturb
// real conversations and needs no model credentials. --real-models drops
// --predictable-only (requires --config). --attach <port> spawns NO backend
// and proxies to an already-running shelley on that port instead — e.g. the
// main instance — overlaying its UI with fresh assets from the checkout.

import { spawn, spawnSync } from "node:child_process";
import { watch, existsSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import http from "node:http";
import net from "node:net";
import { join, resolve, extname, normalize } from "node:path";
import { createLiveStages } from "./live-stages.mjs";
import { proxyHttp } from "./http-proxy.mjs";

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
const CHAT = opt("--chat", null);

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
const SAVED_DIR = join(homedir(), ".local/share/shelley-ui-dev/stages");
mkdirSync(SAVED_DIR, { recursive: true });

function builtStageStyles() {
  const index = readFileSync(join(distDir, "index.html"), "utf8");
  return (index.match(/<link[^>]*stylesheet[^>]*>/g) ?? []).map((link) => {
    const href = link.match(/href="([^"]+)"/)[1];
    const file = join(distDir, href);
    return existsSync(file) ? readFileSync(file, "utf8") : gunzipSync(readFileSync(file + ".gz")).toString();
  }).join("\n");
}

function stageStyles() {
  return builtStageStyles() + "\n" + injectedCSS;
}

// Notify stage pages when a build lands; they refresh styles without reloading.
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
  liveStages.notifyBuild();
}, 500);

function stagePage(url, frozenStyles = null, markup = stageHTML, workspace = null) {
  const chat = workspace ? workspace.chat : new URL(url, "http://localhost").searchParams.get("chat") ?? CHAT;
  const chatPath = chat ? `/c/${encodeURIComponent(chat)}` : null;
  const label = workspace ? workspace.name.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) : frozenStyles !== null ? "archived experiment" : "uidev stage — components · live preview";
  // Use the same stylesheets, in the same order, as the real app.
  let links = "";
  try {
    const idx = readFileSync(join(distDir, "index.html"), "utf8");
    links = (idx.match(/<link[^>]*stylesheet[^>]*>/g) ?? []).join("\n");
  } catch {}
  if (frozenStyles !== null) links = `<style data-stage-archive>${frozenStyles.replace(/<\/style/gi, "<\\/style")}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>uidev stage</title>
${links}
${workspace ? `<style id="uidev-css">${workspace.css.replace(/<\/style/gi, "<\\/style")}</style>` : ""}
<style>html,body{height:auto!important;min-height:100%!important;overflow:auto!important}body{padding:2rem;background:var(--gray-50,#f9fafb)}.uidev-stage-bar{position:fixed;top:0;left:0;right:0;font:11px monospace;background:#111;color:#7c7;padding:2px 8px;z-index:99999}#stage{margin-top:2rem}</style>
<style>
.uidev-stage-bar{display:flex;align-items:center;justify-content:space-between;min-height:36px;box-sizing:border-box;gap:12px}
.uidev-stage-tools{display:flex;align-items:center;gap:12px;font:13px system-ui}
.uidev-stage-tools a{color:inherit}
#uidev-library summary{cursor:pointer;padding:6px 10px}
#uidev-library-panel{position:absolute;top:36px;right:8px;width:min(360px,calc(100vw - 16px));padding:16px;box-sizing:border-box;background:white;color:#333;border:1px solid #ddd;box-shadow:0 8px 30px #0002;border-radius:0 0 8px 8px}
#uidev-library-panel input{width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;border:1px solid #ddd;border-radius:4px;font:13px system-ui}
#uidev-library-panel button{padding:6px 10px;cursor:pointer}
#uidev-saved-list{display:grid;gap:8px;margin-top:16px;max-height:50vh;overflow:auto}
#uidev-saved-list a{display:block;padding:8px;border:1px solid #eee;border-radius:4px;text-decoration:none}
#uidev-saved-list small{display:block;color:#888;margin-top:4px}
#uidev-save-status{font:12px system-ui;margin:8px 0 0}
</style>
${chatPath ? `<style>
.uidev-stage-bar{display:flex;align-items:center;justify-content:space-between;min-height:36px;box-sizing:border-box}
#uidev-chat-toggle{border:0;background:none;color:inherit;font:13px system-ui;cursor:pointer;padding:6px 10px}
#uidev-chat{position:fixed;z-index:99998;top:36px;right:0;bottom:0;width:min(420px,100vw);display:flex;flex-direction:column;background:#fff;border-left:1px solid #ddd;box-shadow:-8px 0 30px #0002}
#uidev-chat[hidden]{display:none}
#uidev-chat header{padding:10px 14px;display:flex;justify-content:space-between;font:13px system-ui;color:#333;border-bottom:1px solid #ddd}
#uidev-chat-close{border:0;background:none;cursor:pointer;font:18px system-ui;color:#333;margin-left:12px}
#uidev-chat iframe{width:100%;flex:1;min-height:0;border:0;background:#fff}
@media(min-width:701px){
  body:has(#uidev-chat:not([hidden])) #stage{margin-right:420px}
  #uidev-chat{box-shadow:none}
}
@media(max-width:700px){
  .uidev-stage-bar>span{max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .uidev-stage-bar{top:var(--uidev-viewport-top,0px)}
  body{padding:16px}
  #uidev-chat{top:calc(var(--uidev-viewport-top,0px) + var(--uidev-viewport-height,100dvh)*.5);bottom:auto;width:100%;height:calc(var(--uidev-viewport-height,100dvh)*.5);border-left:0;border-top:1px solid #ddd;border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 -6px 24px #0002}
  #uidev-chat header{padding:8px 12px}
  body:has(#uidev-chat:not([hidden])){height:var(--uidev-viewport-height,100dvh)!important;min-height:0!important;overflow:hidden!important;padding:0}
  body:has(#uidev-chat:not([hidden])) #stage{position:fixed;top:calc(var(--uidev-viewport-top,0px) + 36px);left:0;right:0;margin:0;padding:16px;box-sizing:border-box;height:calc(var(--uidev-viewport-height,100dvh)*.5 - 36px);overflow:auto;overscroll-behavior:contain}
}
</style>` : ""}
</head><body>
<div class="uidev-stage-bar"><span>${label}</span><div class="uidev-stage-tools">
${frozenStyles !== null ? '<a href="/__stage__">Live stage ↗</a>' : ""}
<details id="uidev-library"><summary>Stages</summary><div id="uidev-library-panel">
<input id="uidev-stage-name" aria-label="Stage name" placeholder="Name this stage"><button id="uidev-save" type="button">${workspace ? "Fork stage" : frozenStyles !== null ? "Make live stage" : "Keep as live stage"}</button><p id="uidev-save-status" role="status"></p>
<div id="uidev-saved-list"></div></div></details>
${chatPath ? `<button id="uidev-chat-toggle" type="button" aria-controls="uidev-chat" aria-expanded="false" aria-label="Open stage chat">☰ Chat</button>` : ""}</div></div>
<div id="stage">${markup}</div>
${chatPath ? `<aside id="uidev-chat" hidden aria-label="Stage chat"><header><span>Stage chat</span><span><a href="${chatPath}" target="_blank" rel="noopener">Open separately ↗</a><button id="uidev-chat-close" type="button" aria-label="Close stage chat">×</button></span></header><iframe title="Shelley stage chat" src="${chatPath}"></iframe></aside>` : ""}
<script>(function(){
var liveStage=${JSON.stringify(workspace ? { id: workspace.id, name: workspace.name } : null).replace(/</g, "\\u003c")};
var library=document.getElementById("uidev-library");
async function loadStages(){
  var responses=await Promise.all([fetch("/__stage__/live"),fetch("/__stage__/saved")]);
  if(responses.some(function(response){return !response.ok;}))throw new Error("Could not load stages");
  var stages=await responses[0].json(),archives=await responses[1].json();
  var list=document.getElementById("uidev-saved-list");
  list.replaceChildren();
  if(!stages.length)list.textContent="No live stages yet.";
  function stageLink(stage,path){
    var link=document.createElement("a");
    link.href=path+stage.id;
    link.target="_blank";link.rel="noopener";
    link.textContent=stage.name;
    var date=document.createElement("small");
    date.textContent=new Date(stage.createdAt).toLocaleString();
    link.appendChild(date);
    return link;
  }
  stages.forEach(function(stage){
    list.appendChild(stageLink(stage,"/__stage__/live/"));
  });
  if(archives.length){
    var details=document.createElement("details"),summary=document.createElement("summary");
    summary.textContent="Archived experiments";details.appendChild(summary);
    archives.forEach(function(stage){details.appendChild(stageLink(stage,"/__stage__/saved/"));});
    list.appendChild(details);
  }
}
library.addEventListener("toggle",function(){
  if(library.open)loadStages().catch(function(error){document.getElementById("uidev-saved-list").textContent=error.message;});
});
var save=document.getElementById("uidev-save");
if(save){
  var name=document.getElementById("uidev-stage-name");
  name.value=liveStage?liveStage.name:document.querySelector("#stage h1,#stage h2")?.textContent||"Component stage";
  save.onclick=async function(){
    save.disabled=true;
    var status=document.getElementById("uidev-save-status");
    try{
      status.textContent="Creating a live stage and its chat…";
      var style=document.querySelector("style[data-stage-archive]")||document.getElementById("uidev-css");
      var response=await fetch("/__stage__/live",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.value,html:document.getElementById("stage").innerHTML,css:style?style.textContent:""})});
      if(!response.ok)throw new Error(await response.text());
      var stage=await response.json();
      location.href="/__stage__/live/"+stage.id;
    }catch(error){status.textContent=error.message;}
    finally{save.disabled=false;}
  };
}
var chat=document.getElementById("uidev-chat");
if(chat){
  var toggle=document.getElementById("uidev-chat-toggle");
  function sizeViewport(){
    var viewport=window.visualViewport;
    document.documentElement.style.setProperty("--uidev-viewport-height",(viewport?viewport.height:window.innerHeight)+"px");
    document.documentElement.style.setProperty("--uidev-viewport-top",(viewport?viewport.offsetTop:0)+"px");
  }
  sizeViewport();
  window.addEventListener("resize",sizeViewport);
  if(window.visualViewport){
    window.visualViewport.addEventListener("resize",sizeViewport);
    window.visualViewport.addEventListener("scroll",sizeViewport);
  }
  function showChat(open){
    chat.hidden=!open;
    toggle.setAttribute("aria-expanded",String(open));
    toggle.setAttribute("aria-label",open?"Close stage chat":"Open stage chat");
    if(!open)toggle.focus();
  }
  toggle.onclick=function(){showChat(chat.hidden);};
  document.getElementById("uidev-chat-close").onclick=function(){showChat(false);};
  function escapeChat(e){if(e.key==="Escape"&&!chat.hidden)showChat(false);}
  document.addEventListener("keydown",escapeChat);
  chat.querySelector("iframe").addEventListener("load",function(){
    this.contentDocument.addEventListener("keydown",escapeChat);
  });
}
${frozenStyles !== null ? "return;" : ""}
var s=new EventSource(liveStage?"/__stage__/live/"+liveStage.id+"/events":"/__uidev__/events");
s.onmessage=function(e){
  var el=document.getElementById("uidev-css");
  if(!el){el=document.createElement("style");el.id="uidev-css";document.head.appendChild(el);}
  el.textContent=JSON.parse(e.data);
};
s.addEventListener("stage",function(e){document.getElementById("stage").innerHTML=JSON.parse(e.data);});
s.addEventListener("build",async function(){
  var response=await fetch(location.href);
  if(!response.ok)throw new Error("Stage refresh failed: "+response.status);
  var page=new DOMParser().parseFromString(await response.text(),"text/html");
  var links=Array.from(page.querySelectorAll('link[rel="stylesheet"]'));
  document.querySelectorAll('link[rel="stylesheet"]').forEach(function(el){el.remove();});
  links.forEach(function(el){
    var url=new URL(el.getAttribute("href"),location.href);
    url.searchParams.set("uidev-build",Date.now());
    el.href=url.href;
    document.head.insertBefore(el,document.head.querySelector("style"));
  });
});
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

const liveStages = createLiveStages({
  checkout, port: PORT, backend: BACKEND, user: USER,
  builtStyles: builtStageStyles,
  render: (workspace, url) => stagePage(url, null, workspace.html, workspace),
});

const server = http.createServer((req, res) => {
  if (liveStages.handle(req, res)) return;
  if (req.url === "/__stage__/saved" && req.method === "GET") {
    const stages = readdirSync(SAVED_DIR).filter((file) => file.endsWith(".json")).map((file) => {
      const { id, name, createdAt } = JSON.parse(readFileSync(join(SAVED_DIR, file), "utf8"));
      return { id, name, createdAt };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(stages));
  }
  if (req.url === "/__stage__/saved" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const name = JSON.parse(body).name?.trim();
        if (!name) { res.writeHead(400); return res.end("Name this stage before saving."); }
        const id = randomUUID();
        const snapshot = { id, name, createdAt: new Date().toISOString(), html: stageHTML, css: stageStyles() };
        writeFileSync(join(SAVED_DIR, id + ".json"), JSON.stringify(snapshot));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id, name, createdAt: snapshot.createdAt }));
      } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    return;
  }
  const saved = req.url.match(/^\/__stage__\/saved\/([a-f0-9-]{36})(?:\?.*)?$/);
  if (saved && req.method === "GET") {
    const file = join(SAVED_DIR, saved[1] + ".json");
    if (!existsSync(file)) { res.writeHead(404); return res.end("Saved stage not found."); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    return res.end(stagePage(req.url, snapshot.css, snapshot.html));
  }
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
    return res.end(stagePage(req.url));
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
  proxyHttp(req, res, { host: "127.0.0.1", port: BACKEND, headers });
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
