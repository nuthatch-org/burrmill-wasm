// RFC-0065 S4's finality gates, against a scripted RPC pair: a range one RPC calls finalized and the
// other does not, or gives a different hash, or that was reorged under the logs, is never sealed.
//   node bench/finality-test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Sealer } = require("../pkg/node/burrmill_wasm.js");
const { agreedCeiling } = await import("../web/play/finality.js");

const h = (chain, n) => `0x${chain}${n.toString(16).padStart(63, "0")}`;
// Each fake RPC: its finalized block, and the chain its block hashes come from, per block.
function serve(rpcs) {
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const rpc = rpcs[new URL(url).host];
    assert.equal(method, "eth_getBlockByNumber");
    const n = params[0] === "finalized" ? rpc.finalized : Number(BigInt(params[0]));
    const result = n == null ? null : { number: `0x${n.toString(16)}`, hash: h(rpc.chain(n), n) };
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
}
const A = "https://a.test", B = "https://b.test";
// Rows from A's logs: one block in five, blocks 101..=200, every one carrying canonical hashes.
const row = (n, chain = "a") => ({ table: "t__x", block_number: n, log_index: 0, block_timestamp: 1_700_000_000 + n * 12, block_hash: h(chain, n), value: "1" });
const rows = (f) => ({ t__x: Array.from({ length: 20 }, (_, i) => f(101 + i * 5)) });
const canonical = () => "a";

function sealedThrough(ceiling, rs) {
  const s = new Sealer(100, 10);
  s.push(JSON.stringify(rs));
  const out = JSON.parse(s.seal(ceiling));
  return Math.max(100, ...out.map((x) => x.to_block));
}

// Both agree: sealed through the lower of the two finalized blocks, here a span cut at 190.
serve({ "a.test": { finalized: 200, chain: canonical }, "b.test": { finalized: 195, chain: canonical } });
let got = await agreedCeiling({ a: A, b: B, rows: rows(row), floor: 100 });
assert.equal(got.ceiling, 195, got.reason);
assert.equal(sealedThrough(got.ceiling, rows(row)), 190);

// B has not finalized past the last seal: nothing is sealed.
serve({ "a.test": { finalized: 200, chain: canonical }, "b.test": { finalized: 100, chain: canonical } });
got = await agreedCeiling({ a: A, b: B, rows: rows(row), floor: 100 });
assert.equal(got.ceiling, 100);
assert.equal(sealedThrough(got.ceiling, rows(row)), 100);

// B reports no finalized block at all.
serve({ "a.test": { finalized: 200, chain: canonical }, "b.test": { finalized: null, chain: canonical } });
got = await agreedCeiling({ a: A, b: B, rows: rows(row), floor: 100 });
assert.equal(got.ceiling, 100);

// The two give the finalized block different hashes: nothing is sealed.
serve({ "a.test": { finalized: 200, chain: canonical }, "b.test": { finalized: 200, chain: (n) => (n >= 150 ? "b" : "a") } });
got = await agreedCeiling({ a: A, b: B, rows: rows(row), floor: 100 });
assert.equal(got.ceiling, 100);
assert.match(got.reason, /different hashes/);

// A's logs for block 146 came from a fork that was reorged away before B finalized it: the ceiling
// stops below it, and no segment reaches block 146.
const forked = rows((n) => row(n, n === 146 ? "f" : "a"));
serve({ "a.test": { finalized: 200, chain: canonical }, "b.test": { finalized: 200, chain: canonical } });
got = await agreedCeiling({ a: A, b: B, rows: forked, floor: 100 });
assert.equal(got.ceiling, 145);
const through = sealedThrough(got.ceiling, forked);
assert.ok(through < 146, `sealed through ${through}`);

console.log("RESULT: PASS (5 scripted cases)");
