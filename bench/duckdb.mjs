// Every authored view of a mirrored nest through DuckDB-Wasm in Node, bound as nuthatch 4.0.2 bound
// it under DuckDB (web/duckbind.js), only the tables and views the statement reaches by burrmill-wasm's
// own rule, each view in a fresh database so the first statement is cold. The answer is DuckDB's own
// Arrow IPC (`runQuery`), timed as DuckDB hands it over, then put through burrmill-wasm's nuthatch
// encoder untimed: ours is timed with that encoding in it, so the comparison leans DuckDB's way.
// Usage: node bench/duckdb.mjs data/alloc [view]
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bindDdl, declaredColumns, viewStatements } from "../web/duckbind.js";

const require = createRequire(import.meta.url);
const io = { reads: 0, bytes: 0 };
const readSync = fs.readSync;
fs.readSync = function (...a) {
  const n = readSync.apply(this, a);
  io.reads++; io.bytes += n;
  return n;
};
const duck = require("./duckdb/node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
const { encodeIpcLines, Nest } = require("../pkg/node/burrmill_wasm.js");

const dist = path.resolve("bench/duckdb/node_modules/@duckdb/duckdb-wasm/dist");
const bundles = {
  mvp: { mainModule: path.join(dist, "duckdb-mvp.wasm"), mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs") },
  eh: { mainModule: path.join(dist, "duckdb-eh.wasm"), mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs") },
};

const dir = path.resolve(process.argv[2] ?? "data/alloc");
const only = process.argv[3];
const manifestText = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);
const schemaPath = path.join(dir, "schema.json");
const schemaText = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : undefined;
const declared = declaredColumns(schemaText ? JSON.parse(schemaText) : null);
const viewTexts = fs.existsSync(path.join(dir, "views"))
  ? fs.readdirSync(path.join(dir, "views")).filter((f) => f.endsWith(".sql")).sort()
      .map((f) => fs.readFileSync(path.join(dir, "views", f), "utf8"))
  : [];
const views = viewStatements(viewTexts);

const reacher = new Nest(async () => 0, async () => new Uint8Array(), "", manifestText, schemaText);
for (const t of viewTexts) reacher.addViews(t);

function bind(conn, sql) {
  const [tables, wanted] = reacher.reach(sql);
  for (const t of tables) {
    const files = (manifest.tables[t] ?? []).map((s) => path.join(dir, t, `${s.hash}.parquet`));
    const ddl = bindDdl(t, declared, files);
    if (ddl) conn.query(ddl);
  }
  for (const [n, stmt] of views) if (wanted.includes(n)) conn.query(stmt);
}

const NL = Buffer.from("\n");
function multiset(rowLines) {
  const lines = rowLines.map((l) => Buffer.from(l)).sort(Buffer.compare);
  return createHash("sha256").update(Buffer.concat(lines.flatMap((l, i) => (i ? [NL, l] : [l])))).digest("hex").slice(0, 16);
}

const out = [];
for (const [v] of views) {
  if (only && v !== only) continue;
  const db = await duck.createDuckDB(bundles, new duck.VoidLogger(), duck.NODE_RUNTIME);
  await db.instantiate();
  db.open({});
  const conn = db.connect();
  const sql = `SELECT * FROM "${v}"`;
  Object.assign(io, { reads: 0, bytes: 0 });
  let ipc, err;
  let t = performance.now();
  // A view into DuckDB's own memory: the next statement overwrites it, so it is copied out.
  try { bind(conn, sql); ipc = db.runQuery(conn._conn, sql).slice(); } catch (e) { err = String(e.message ?? e); }
  const cold = performance.now() - t;
  const coldIo = { ...io };
  let warm = null, rows = null, digest = null;
  if (!err) {
    t = performance.now(); db.runQuery(conn._conn, sql); warm = performance.now() - t;
    try {
      const lines = encodeIpcLines(ipc).split("\n").filter((l) => l.length);
      rows = lines.length; digest = multiset(lines);
    } catch (e) { err = "encode: " + String(e.message ?? e); }
  }
  out.push({ view: v, rows, cold_ms: Math.round(cold), warm_ms: warm && Math.round(warm), reads: coldIo.reads, mb: +(coldIo.bytes / 1e6).toFixed(1), digest, err: err?.slice(0, 300) });
  console.error(JSON.stringify(out.at(-1)));
  conn.close();
}
fs.writeFileSync(process.env.OUT ?? "/dev/stdout", JSON.stringify(out, null, 1));
