// RFC-0065 S3's gate: for a window the mirror has already sealed, the rows the live tail decodes from
// an RPC equal the sealed rows, per table, as multisets of encoded rows. Then the tail past the
// mirror is bound beside the segments and every view is run over both.
//   RPC=<url> node bench/tail-gate.mjs <mirror dir> <nest repo dir> [window blocks]
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Nest, Decoder } = require("../pkg/node/burrmill_wasm.js");
const { fetchTail } = await import("../web/play/tail.js");

const [dirArg, repoArg, windowArg] = process.argv.slice(2);
const dir = path.resolve(dirArg ?? "data/pulse");
const repo = path.resolve(repoArg ?? "../defi-pulse-nest");
const WINDOW = Number(windowArg ?? 20000);
const { MARGIN } = await import("../web/play/tail.js");
const rpc = process.env.RPC;
if (!rpc) throw new Error("RPC=<url> is required");

const manifest = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
const schema = fs.readFileSync(path.join(dir, "schema.json"), "utf8");
const config = fs.readFileSync(path.join(repo, "nuthatch.toml"), "utf8");
const abis = Object.fromEntries(
  fs.readdirSync(path.join(repo, "abis")).map((f) => [`abis/${f}`, fs.readFileSync(path.join(repo, "abis", f), "utf8")]),
);
const views = fs.readdirSync(path.join(repo, "views")).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => fs.readFileSync(path.join(repo, "views", f), "utf8"));

const fds = new Map();
const fd = (key) => { if (!fds.has(key)) fds.set(key, fs.openSync(path.join(dir, key), "r")); return fds.get(key); };
const size = async (key) => fs.fstatSync(fd(key)).size;
const read = async (key, offset, length) => { const b = Buffer.alloc(length); fs.readSync(fd(key), b, 0, length, offset); return b; };
const open = (m) => { const n = new Nest(size, read, "", m, schema); for (const v of views) n.addViews(v); return n; };

const NL = Buffer.from("\n");
const digest = (text) => {
  const lines = text.split("\n").filter((l) => l.length).map((l) => Buffer.from(l)).sort(Buffer.compare);
  const h = createHash("sha256").update(Buffer.concat(lines.flatMap((l, i) => (i ? [NL, l] : [l])))).digest("hex").slice(0, 16);
  return { rows: lines.length, h, lines };
};

const decoder = new Decoder(config, JSON.stringify(abis));
const sealed = open(manifest);
const covered = JSON.parse(sealed.covered());
// A segment ends at its last row, so the mirror's cut is the furthest any table reaches; a table's
// unpublished tail is younger than #2084's three hours, so the window stays clear of it.
const cut = Math.max(...Object.values(covered));
const B = cut - 2 * MARGIN;
const A = B - WINDOW;
console.error(`window: blocks ${A + 1}..${B} (${WINDOW}); the mirror's cut is ${cut}`);

let t = performance.now();
const tail = await fetchTail({ rpc, decoder, from: A + 1, to: B, log: (s) => console.error(s) });
console.error(`fetched and decoded in ${((performance.now() - t) / 1000).toFixed(1)} s: ${tail.logs} logs, ${tail.undecoded} undecoded, ${tail.removed} removed, ${tail.checked} timestamps checked against headers`);

const empty = open(JSON.stringify({ manifest_version: 1, tables: {} }));
empty.setTail(JSON.stringify(tail.rows));
const out = [];
let failed = 0;
for (const table of Object.keys(covered).sort()) {
  // `SELECT *` lists a segment's columns in file order and the tail's in decode order; the same
  // columns, named in one order, make the two encodings comparable byte for byte.
  const where = `WHERE block_number > ${A} AND block_number <= ${B}`;
  const keys = async (n) => {
    const first = (await n.queryLines(`SELECT * FROM "${table}" ${where} LIMIT 1`)).split("\n")[0];
    return first ? Object.keys(JSON.parse(first)).sort() : [];
  };
  const [ks, kd] = [await keys(sealed), await keys(empty)];
  if (ks.join() !== kd.join()) {
    failed++;
    console.error(`${table}: columns differ\n  sealed ${ks.join(",")}\n  tail   ${kd.join(",")}`);
  }
  const cols = ks.length ? ks.map((c) => `"${c}"`).join(", ") : "*";
  const q = `SELECT ${cols} FROM "${table}" ${where}`;
  const s = digest(await sealed.queryLines(q));
  const d = digest(await empty.queryLines(q));
  const match = s.h === d.h && ks.join() === kd.join();
  if (!match) {
    failed++;
    const only = (x, y) => x.lines.find((l) => !y.lines.some((m) => m.equals(l)))?.toString().slice(0, 400);
    console.error(`${table}: sealed-only ${only(s, d)}\n${table}: tail-only   ${only(d, s)}`);
  }
  out.push({ table, sealed: s.rows, tail: d.rows, sealed_digest: s.h, tail_digest: d.h, match });
}
console.table(out);

// The tab's own shape: segments, and the tail past them to the head.
const head = Number(BigInt((await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) })).json()).result));
t = performance.now();
const live = await fetchTail({ rpc, decoder, from: cut - MARGIN + 1, to: head, log: (s) => console.error(s) });
const kept = sealed.setTail(JSON.stringify(live.rows));
console.error(`live tail ${cut - MARGIN + 1}..${head}: ${kept} rows in ${((performance.now() - t) / 1000).toFixed(1)} s`);
for (const v of sealed.views()) {
  const t0 = performance.now();
  try {
    const n = digest(await sealed.queryLines(`SELECT * FROM "${v}"`)).rows;
    console.error(`view ${v}: ${n} rows in ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    failed++;
    console.error(`view ${v}: ${e}`);
  }
}
process.exit(failed ? 1 : 0);
