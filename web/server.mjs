// The page, both engines' modules, and data/ laid out as the mirror lays it out, with range requests,
// CORS, and an injected round trip so a local run costs what a request to a bucket costs.
//   node web/server.mjs [port]      LATENCY_MS=40 (each response waits this long before its first byte)
// GET /_stats answers the requests and bytes served since the last /_stats?reset=1.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const port = Number(process.argv[2] ?? 8737);
const latency = Number(process.env.LATENCY_MS ?? 40);
const routes = [
  ["/data/", path.join(root, "data")],
  ["/pkg/", path.join(root, "pkg")],
  ["/duckdb/", path.join(root, "bench/duckdb/node_modules/@duckdb/duckdb-wasm/dist")],
  ["/npm/", path.join(root, "bench/duckdb/node_modules")],
  ["/", path.join(root, "web")],
];
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
  ".json": "application/json", ".sql": "text/plain", ".parquet": "application/octet-stream", ".css": "text/css" };
const stats = { requests: 0, bytes: 0, data_requests: 0, data_bytes: 0 };

function resolve(urlPath) {
  for (const [prefix, dir] of routes) {
    if (!urlPath.startsWith(prefix)) continue;
    const p = path.join(dir, decodeURIComponent(urlPath.slice(prefix.length)) || "index.html");
    if (p.startsWith(dir)) return { p, data: prefix === "/data/" };
  }
  return null;
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (url.pathname === "/_stats") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(stats));
    if (url.searchParams.get("reset")) Object.keys(stats).forEach((k) => (stats[k] = 0));
    return;
  }
  // Views are not in the mirror; the page asks for a nest's view files by listing.
  if (url.pathname.startsWith("/_views/")) {
    const dir = path.join(root, "data", url.pathname.slice(8), "views");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort() : [];
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(files));
  }
  const found = resolve(url.pathname);
  let st;
  try { st = found && fs.statSync(found.p); } catch { st = null; }
  if (!st || !st.isFile()) return res.writeHead(404).end();
  const type = types[path.extname(found.p)] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0, end = st.size - 1, status = 200;
  if (range) {
    if (range[1] === "") { start = Math.max(0, st.size - Number(range[2])); }
    else { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
    status = 206;
  }
  const len = Math.max(0, end - start + 1);
  stats.requests++; stats.bytes += req.method === "HEAD" ? 0 : len;
  if (found.data) { stats.data_requests++; stats.data_bytes += req.method === "HEAD" ? 0 : len; }
  const headers = { "Content-Type": type, "Content-Length": len, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  setTimeout(() => {
    res.writeHead(status, headers);
    if (req.method === "HEAD" || len === 0) return res.end();
    fs.createReadStream(found.p, { start, end }).pipe(res);
  }, found.data ? latency : 0);
}).listen(port, () => console.log(`http://localhost:${port}/  data latency ${latency} ms`));
