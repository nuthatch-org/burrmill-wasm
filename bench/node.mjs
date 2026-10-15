// Every authored view of a mirrored nest, through the wasm build in Node, each in a fresh Nest so the
// first statement pays for binding as a cold page would. Usage: node bench/node.mjs data/alloc
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const NL = Buffer.from("\n");
const { Nest, wasmMemory } = require("../pkg/node/burrmill_wasm.js");

const dir = path.resolve(process.argv[2] ?? "data/alloc");
const only = process.argv[3];
const manifest = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
const schemaPath = path.join(dir, "schema.json");
const schema = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : undefined;
const viewFiles = fs.existsSync(path.join(dir, "views"))
  ? fs.readdirSync(path.join(dir, "views")).filter((f) => f.endsWith(".sql")).sort()
  : [];

const io = { reads: 0, bytes: 0, sizes: 0 };
const fds = new Map();
const fd = (key) => {
  if (!fds.has(key)) fds.set(key, fs.openSync(path.join(dir, key), "r"));
  return fds.get(key);
};
const size = async (key) => { io.sizes++; return fs.fstatSync(fd(key)).size; };
const read = async (key, offset, length) => {
  io.reads++; io.bytes += length;
  const buf = Buffer.alloc(length);
  fs.readSync(fd(key), buf, 0, length, offset);
  return new Uint8Array(buf.buffer, buf.byteOffset, length);
};

function open() {
  const nest = new Nest(size, read, "", manifest, schema);
  for (const f of viewFiles) nest.addViews(fs.readFileSync(path.join(dir, "views", f), "utf8"));
  return nest;
}

const views = open().views().filter((v) => !only || v === only);
const out = [];
for (const v of views) {
  const nest = open();
  const sql = `SELECT * FROM "${v}"`;
  Object.assign(io, { reads: 0, bytes: 0, sizes: 0 });
  let t = performance.now();
  let text, err;
  try { text = await nest.queryLines(sql); } catch (e) { err = String(e.message ?? e); }
  const cold = performance.now() - t;
  const coldIo = { ...io };
  let warm = null;
  if (!err) { t = performance.now(); await nest.queryLines(sql); warm = performance.now() - t; }
  const lines = text !== undefined ? text.split("\n").filter((l) => l.length) : null;
  const rows = lines ? lines.length : null;
  const digest = lines ? multiset(lines) : null;
  const mib = (wasmMemory().buffer.byteLength / 2 ** 20) | 0;
  out.push({ view: v, rows, mem_mib: mib, cold_ms: Math.round(cold), warm_ms: warm && Math.round(warm), reads: coldIo.reads, mb: +(coldIo.bytes / 1e6).toFixed(1), digest, err: err?.slice(0, 200) });
  console.error(JSON.stringify(out.at(-1)));
}
fs.writeFileSync(process.env.OUT ?? "/dev/stdout", JSON.stringify(out, null, 1));

// Order-free: a view without ORDER BY may come back in any order, so rows are hashed sorted.
function multiset(rowLines) {
  // By UTF-8 bytes, as Rust sorts; JavaScript's default compares UTF-16 units.
  const lines = rowLines.map((l) => Buffer.from(l)).sort(Buffer.compare);
  return createHash("sha256").update(Buffer.concat(lines.flatMap((l, i) => (i ? [NL, l] : [l])))).digest("hex").slice(0, 16);
}
