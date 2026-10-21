import http from "node:http";

export function proxyHttp(req, res, options) {
  const fail = () => {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502);
    res.end("backend not ready");
  };
  const up = http.request(
    { ...options, path: req.url, method: req.method },
    (ur) => {
      ur.on("error", fail);
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  res.once("close", () => up.destroy());
  req.once("error", () => {
    up.destroy();
    res.destroy();
  });
  up.on("error", fail);
  req.pipe(up);
}
