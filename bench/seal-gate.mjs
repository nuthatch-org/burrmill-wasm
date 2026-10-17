// RFC-0065 S4's determinism gate: the tab's sealer, resumed at `from - 1` with nothing held, seals the
// range from an RPC, and every segment it writes must carry the hash a native nest sealed for it.
//   RPC=<url> node bench/seal-gate.mjs <native manifest.json> <nest repo dir> <from> <to> [seal span]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Decoder, Sealer } = require("../pkg/node/burrmill_wasm.js");
const { fetchTail } = await import("../web/play/tail.js");

const [manifestArg, repoArg, fromArg, toArg, spanArg] = process.argv.slice(2);
const rpc = process.env.RPC;
if (!rpc) throw new Error("RPC=<url> is required");
const [from, to, span] = [Number(fromArg), Number(toArg), Number(spanArg ?? 1800)];
const repo = path.resolve(repoArg);
const config = fs.readFileSync(path.join(repo, "nuthatch.toml"), "utf8");
const abis = Object.fromEntries(
  fs.readdirSync(path.join(repo, "abis")).map((f) => [`abis/${f}`, fs.readFileSync(path.join(repo, "abis", f), "utf8")]),
);
const decoder = new Decoder(config, JSON.stringify(abis));
const native = JSON.parse(fs.readFileSync(manifestArg, "utf8"));
const nativeHashes = new Map(
  Object.entries(native.tables).flatMap(([t, segs]) => segs.map((s) => [`${t} ${s.hash}`, s])),
);

const t0 = performance.now();
const tail = await fetchTail({ rpc, decoder, from, to, log: (m) => console.log(m) });
const sealer = new Sealer(from - 1, span);
const added = sealer.push(JSON.stringify(tail.rows));
const sealed = JSON.parse(sealer.seal(to));
const ms = Math.round(performance.now() - t0);

let matched = 0;
const differ = [];
// A tail the age rule closes is reported twice, provisional and then final, with one file.
const distinct = [...new Map(sealed.map((s) => [`${s.table} ${s.hash}`, s])).values()];
for (const s of distinct) {
  if (nativeHashes.has(`${s.table} ${s.hash}`)) matched++;
  else differ.push(s);
}
// Native segments wholly inside what the tab sealed, that the tab did not write.
const through = sealer.watermark();
const tabHashes = new Set(sealed.map((s) => `${s.table} ${s.hash}`));
const missed = [...nativeHashes].filter(([k, s]) => s.to_block <= through && !tabHashes.has(k));
console.log(`${tail.logs} logs, ${added} rows, sealed ${sealed.length} segments through ${through} in ${ms} ms`);
console.log(`${matched} of ${distinct.length} distinct segments hash to a native segment; ${missed.length} native segments not written`);
for (const s of differ) console.log(`DIFFERS ${s.table} ${s.from_block}-${s.to_block} ${s.rows} ${s.hash}`);
for (const [k, s] of missed) console.log(`MISSED ${k} ${s.from_block}-${s.to_block} ${s.rows}`);
console.log(differ.length || missed.length || !sealed.length ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(differ.length || missed.length || !sealed.length ? 1 : 0);
