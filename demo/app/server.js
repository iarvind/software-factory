// A tiny HTTP service: the smallest thing that still has routes, logic and tests.
import http from "node:http";
import { greet, slugify } from "./lib.js";

export function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") return json(res, 200, { service: "factory-demo", hello: greet(url.searchParams.get("name") ?? "world") });
  if (url.pathname === "/slug") return json(res, 200, { slug: slugify(url.searchParams.get("text") ?? "") });
  json(res, 404, { error: "not found" });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const port = Number(process.env.PORT || 4848);
  http.createServer(handle).listen(port, "127.0.0.1", () => console.log(`factory-demo on http://127.0.0.1:${port}`));
}
