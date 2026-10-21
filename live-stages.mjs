// Independent, editable component stages for the Shelley UI development proxy.
// This module deliberately owns no shared preview state: every stage is a folder,
// a chat draft, and a separate SSE client set.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".local/share/shelley-ui-dev/live");
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
};
const text = (res, status, value, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(value);
};
function body(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.setEncoding("utf8");
    req.on("data", (part) => value += part);
    req.on("end", () => resolve(value));
    req.on("error", reject);
  });
}
function safeName(name) {
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
function metadata(stage) {
  const { id, name, createdAt, chat } = stage.meta;
  return { id, name, createdAt, chat };
}

export function createLiveStages({ checkout, port, backend, user, render, builtStyles }) {
  mkdirSync(ROOT, { recursive: true });
  const stages = new Map();

  function broadcast(stage, event, value) {
    for (const client of stage.clients) client.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  function load(id) {
    const folder = join(ROOT, id);
    const metaFile = join(folder, "stage.json");
    if (!existsSync(metaFile)) return null;
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (meta.id !== id || !safeName(meta.name) || typeof meta.createdAt !== "string") throw new Error(`Invalid live stage metadata: ${metaFile}`);
    const stage = { id, folder, meta, clients: new Set(), watcher: null };
    stage.watcher = watch(folder, (_kind, file) => {
      if (file !== "stage.html" && file !== "stage.css") return;
      try { broadcast(stage, file === "stage.html" ? "stage" : "message", readFileSync(join(folder, file), "utf8")); }
      catch (error) { console.error(`[uidev] live stage ${id} changed but could not be read:`, error); }
    });
    stages.set(id, stage);
    return stage;
  }
  for (const name of readdirSync(ROOT, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    try { load(name.name); } catch (error) { console.error("[uidev] could not load live stage:", error); }
  }

  function stageFiles(stage) {
    return {
      ...metadata(stage),
      html: readFileSync(join(stage.folder, "stage.html"), "utf8"),
      css: readFileSync(join(stage.folder, "stage.css"), "utf8"),
    };
  }
  async function draft(req, folder) {
    const headers = { "Content-Type": "application/json" };
    const identity = req.headers["x-exedev-userid"] ?? user;
    if (identity) headers["X-Exedev-Userid"] = Array.isArray(identity) ? identity[0] : identity;
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: backend, path: "/api/conversations/draft", method: "POST", headers }, resolve);
      request.on("error", reject);
      request.end(JSON.stringify({ draft: "", cwd: folder }));
    });
    const responseBody = await new Promise((resolve, reject) => {
      let value = "";
      response.setEncoding("utf8");
      response.on("data", (part) => value += part);
      response.on("end", () => resolve(value));
      response.on("error", reject);
    });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Draft chat failed (${response.statusCode}): ${responseBody}`);
    const result = JSON.parse(responseBody);
    if (!result.conversation_id) throw new Error("Draft chat response did not include conversation_id");
    return result.conversation_id;
  }
  async function create(req, res) {
    const input = JSON.parse(await body(req));
    const name = safeName(input.name);
    if (!name || typeof input.html !== "string" || typeof input.css !== "string") return text(res, 400, "name, html, and css are required (name must be non-empty; html/css strings).\n");
    const id = randomUUID(), folder = join(ROOT, id), createdAt = new Date().toISOString();
    let css = input.css;
    const prefix = `${builtStyles()}\n`;
    if (css.startsWith(prefix)) css = css.slice(prefix.length);
    mkdirSync(folder);
    writeFileSync(join(folder, "stage.html"), input.html);
    writeFileSync(join(folder, "stage.css"), css);
    writeFileSync(join(folder, "AGENTS.md"), `# Live UI stage\n\nThis is exploratory stage **${name}**. Edit ONLY \`stage.html\` and \`stage.css\` in this directory; updates appear immediately.\n\nCheckout: \`${checkout}\`\nPreview: http://localhost:${port}/__stage__/live/${id}\n\nNever POST shared \`/__stage__/html\` or \`/__uidev__/css\`, and never alter other stages. No tests, builds, or commits unless explicitly requested or required to make the preview work. No screenshots unless the user asks or an image is specifically needed to discuss or diagnose an issue in chat. Use the live stage link for checkpoints. The chat’s first user message supplies the actual design task; do not infer one. No backend/schema changes.\n`);
    try {
      const chat = await draft(req, folder);
      const meta = { id, name, createdAt, chat };
      writeFileSync(join(folder, "stage.json"), JSON.stringify(meta, null, 2) + "\n");
      const stage = load(id);
      json(res, 201, metadata(stage));
    } catch (error) {
      console.error(`[uidev] live stage ${id} draft creation failed:`, error);
      text(res, 502, `${error.message}\n`);
    }
  }
  function find(url) {
    const pathname = new URL(url, "http://localhost").pathname;
    const match = pathname.match(/^\/__stage__\/live\/([a-f0-9-]{36})(?:\/(html|css|meta|events))?$/);
    return match ? { pathname, id: match[1], leaf: match[2] } : null;
  }
  function handle(req, res) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/__stage__/live") {
      if (req.method === "GET") {
        json(res, 200, [...stages.values()].map(metadata).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        return true;
      }
      if (req.method === "POST") {
        create(req, res).catch((error) => { console.error("[uidev] live stage creation failed:", error); text(res, 500, `${error.message}\n`); });
        return true;
      }
      text(res, 405, "Method not allowed\n");
      return true;
    }
    if (pathname === "/__stage__/live" || (pathname === "/__stage__/live/")) return false;
    const route = find(req.url);
    if (!route) return false;
    const stage = stages.get(route.id);
    if (!stage) { text(res, 404, "Live stage not found.\n"); return true; }
    if (!route.leaf) {
      if (req.method !== "GET") { text(res, 405, "Method not allowed\n"); return true; }
      text(res, 200, render(stageFiles(stage), req.url), "text/html; charset=utf-8");
      return true;
    }
    if (route.leaf === "meta") {
      if (req.method !== "GET") { text(res, 405, "Method not allowed\n"); return true; }
      json(res, 200, metadata(stage)); return true;
    }
    if (route.leaf === "events") {
      if (req.method !== "GET") { text(res, 405, "Method not allowed\n"); return true; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(readFileSync(join(stage.folder, "stage.css"), "utf8"))}\n\n`);
      res.write(`event: stage\ndata: ${JSON.stringify(readFileSync(join(stage.folder, "stage.html"), "utf8"))}\n\n`);
      stage.clients.add(res); req.on("close", () => stage.clients.delete(res)); return true;
    }
    const file = join(stage.folder, `stage.${route.leaf}`);
    if (req.method === "GET") { text(res, 200, readFileSync(file, "utf8"), route.leaf === "css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8"); return true; }
    if (req.method === "POST") { body(req).then((value) => { writeFileSync(file, value); text(res, 200, "ok\n"); }).catch((error) => { console.error(`[uidev] failed to write ${file}:`, error); text(res, 500, `${error.message}\n`); }); return true; }
    text(res, 405, "Method not allowed\n"); return true;
  }
  function notifyBuild() { for (const stage of stages.values()) broadcast(stage, "build", 1); }
  return { handle, notifyBuild };
}
