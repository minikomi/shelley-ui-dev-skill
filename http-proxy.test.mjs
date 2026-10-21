import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { proxyHttp } from "./http-proxy.mjs";

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return server.address().port;
}

async function setup(t, handler) {
  const port = await listen(t, handler);
  const front = await listen(t, (req, res) => {
    proxyHttp(req, res, { host: "127.0.0.1", port, headers: req.headers });
  });
  return `http://127.0.0.1:${front}`;
}

async function readBody(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("each SSE disconnect releases its upstream stream", { timeout: 5000 }, async (t) => {
  let active = 0;
  let closed;
  const url = await setup(t, (_req, res) => {
    active++;
    res.once("close", () => {
      active--;
      closed.resolve();
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: hello\n\n");
  });
  for (let i = 0; i < 10; i++) {
    closed = Promise.withResolvers();
    const request = http.get(url);
    const [response] = await once(request, "response");
    const [chunk] = await once(response, "data");
    assert.equal(chunk.toString(), "data: hello\n\n");
    assert.equal(active, 1);
    request.destroy();
    await closed.promise;
    assert.equal(active, 0);
  }
});

test("disconnect before response headers cancels the upstream request", { timeout: 5000 }, async (t) => {
  const arrived = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const url = await setup(t, (_req, res) => {
    res.once("close", closed.resolve);
    arrived.resolve();
  });
  const request = http.get(url);
  const error = once(request, "error");
  await arrived.promise;
  request.destroy();
  await closed.promise;
  assert.equal((await error)[0].code, "ECONNRESET");
});

test("an aborted upload releases the upstream request", { timeout: 5000 }, async (t) => {
  const arrived = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const url = await setup(t, (req, res) => {
    req.once("data", arrived.resolve);
    res.once("close", closed.resolve);
  });
  const request = http.request(url, { method: "POST" });
  const error = once(request, "error");
  request.write("unfinished upload");
  await arrived.promise;
  request.destroy();
  await closed.promise;
  assert.equal((await error)[0].code, "ECONNRESET");
});

test("a completed upload preserves the response status, headers, and bytes", { timeout: 5000 }, async (t) => {
  const payload = gzipSync("compressed response");
  const url = await setup(t, (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/echo?value=1");
    assert.equal(req.headers["x-test"], "forwarded");
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(Buffer.concat(chunks).toString(), "upload");
      res.writeHead(201, { "Content-Encoding": "gzip" });
      res.end(payload);
    });
  });
  const request = http.request(`${url}/echo?value=1`, {
    method: "POST",
    headers: { "X-Test": "forwarded" },
  });
  const responseReady = once(request, "response");
  request.end("upload");
  const [response] = await responseReady;
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["content-encoding"], "gzip");
  assert.deepEqual(await readBody(response), payload);
});

test("backend failure before headers returns 502", { timeout: 5000 }, async (t) => {
  const url = await setup(t, (req) => req.socket.destroy());
  const request = http.get(url);
  const [response] = await once(request, "response");
  assert.equal(response.statusCode, 502);
  assert.equal((await readBody(response)).toString(), "backend not ready");
});

test("backend failure after headers closes the downstream stream", { timeout: 5000 }, async (t) => {
  let upstream;
  const url = await setup(t, (_req, res) => {
    upstream = res;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: hello\n\n");
  });
  const request = http.get(url);
  const [response] = await once(request, "response");
  await once(response, "data");
  const failed = once(response, "error");
  upstream.destroy();
  assert.equal((await failed)[0].code, "ECONNRESET");
  assert.equal(response.complete, false);
});
