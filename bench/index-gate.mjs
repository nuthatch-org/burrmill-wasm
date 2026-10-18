// RFC-0066 S2's gate: "Index it" on a nest the builder made, against `nuthatch dev` on the same zip.
// Every segment the tab seals must hash to the one the node sealed for that table and range.
//   NUTHATCH=<binary> ADDRESS=0x.. [CHAIN=base] [START=n] [RPC=<rpc>] [SECOND=<rpc>] node bench/index-gate.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { resolveContract, chainId } from "../web/play/resolve.js";
import { backfill } from "../web/play/index-it.js";
import { CHAINS } from "../web/play/chains.js";

const w = createRequire(import.meta.url)("../pkg/node/burrmill_wasm.js");
const bin = process.env.NUTHATCH;
const name = "gate";
const chain = process.env.CHAIN ?? "mainnet";
const { span } = CHAINS[chain];
const rpc = process.env.RPC ?? CHAINS[chain].rpc;
const second = process.env.SECOND ?? CHAINS[chain].second;

const id = await chainId(rpc);
const c = await resolveContract({ rpc, id, address: process.env.ADDRESS, start: process.env.START ? Number(process.env.START) : null, taken: [], w });
const { implementation, name: _, ...contract } = c;
const input = JSON.stringify({ name, chain, chain_id: id, rpc_urls: [rpc], contracts: [contract] });
const files = JSON.parse(w.scaffoldNest(input));
const root = mkdtempSync(join(tmpdir(), "index-gate-"));
for (const [p, t] of Object.entries(files)) {
  mkdirSync(dirname(join(root, name, p)), { recursive: true });
  writeFileSync(join(root, name, p), t);
}
console.log(`${c.alias} from block ${c.start_block}; the nest is in ${root}/${name}`);

// The node first, alone on the public RPC, until its `sealed_through` is within two spans of the
// finalized head; then the tab seals to exactly that block, tails included. The manifest alone cannot
// say how far the node got: spans with no rows write nothing to it.
const port = 18000 + Math.floor(Math.random() * 1000);
const dev = spawn(bin, ["dev", "--dir", join(root, name), "--listen", `127.0.0.1:${port}`, "--no-admin"], { stdio: "ignore" });
process.on("exit", () => dev.kill());
const manifestPath = join(root, name, "segments", "manifest.json");
const finalizedNow = async () => Number(BigInt((await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] }) })).json()).result.number));
let native = null;
let through = 0;
for (let i = 0; i < 900 && !native; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const s = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json()).catch(() => null);
  through = Number(s?.sealed_through ?? 0);
  if (through && through >= (await finalizedNow()) - 2 * span && existsSync(manifestPath)) native = JSON.parse(readFileSync(manifestPath, "utf8"));
}
dev.kill();
if (!native) { console.log("RESULT: FAIL - the node never caught up"); process.exit(1); }
console.log(`node sealed through ${through}`);

const peak = { mib: 0 };
const store = new Map();
const tab = await backfill({
  w, files, from: c.start_block, span, rpc, second, store, ceiling: through,
  progress: (p) => {
    peak.mib = Math.max(peak.mib, process.memoryUsage().rss / 2 ** 20);
    console.log(`tab sealed through ${p.through} of ${p.finalized}: ${p.logs} logs, ${(p.ms / 1000).toFixed(1)} s`);
  },
});
const ours = [
  ...Object.entries(tab.manifest.tables).flatMap(([t, segs]) => segs.map((s) => ({ t, ...s }))),
  ...Object.entries(tab.provisional).map(([t, s]) => ({ t, ...s, provisional: true })),
];
const kib = ours.reduce((n, s) => n + store.get(`${s.t}/${s.hash}.parquet`).length, 0) / 1024;
console.log(`tab: ${tab.logs} logs, ${ours.length} segments (${kib.toFixed(0)} KiB) through ${tab.sealer.watermark()} in ${(tab.ms / 1000).toFixed(1)} s, peak RSS ${peak.mib.toFixed(0)} MiB`);
const nativeHashes = new Set(Object.entries(native.tables).flatMap(([t, segs]) => segs.map((s) => `${t} ${s.hash}`)));
const nativeCount = Object.values(native.tables).flat().length;
const differ = ours.filter((s) => !nativeHashes.has(`${s.t} ${s.hash}`));
console.log(`${ours.length - differ.length} of ${ours.length} tab segments hash to the node's (the node has ${nativeCount})`);
for (const s of differ) console.log(`DIFFERS ${s.t} ${s.from_block}-${s.to_block} ${s.rows} ${s.hash}${s.provisional ? " (tail)" : ""}`);
const ok = ours.length > 0 && differ.length === 0 && ours.length === nativeCount;
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
