// RFC-0065 S4's finality gates, against a scripted RPC pair: a range one RPC calls finalized and the
// other does not, or gives a different hash, or that was reorged under the logs, is never sealed.
//   node bench/finality-test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Sealer } = require("../pkg/node/burrmill_wasm.js");
const { agreedCeiling } = await import("../web/play/finality.js");

const h = (chain, n) => `0x${chain}${n.toString(16).padStart(63, "0")}`;
const hx = (n) => `0x${n.toString(16)}`;
// One log in every fifth block, 101..=196, on `chain(n)`'s block hashes.
const logsOn = (chain, extra = []) => [...Array.from({ length: 20 }, (_, i) => 101 + i * 5), ...extra].map((n) => ({
  blockNumber: hx(n), logIndex: "0x0", blockHash: h(chain(n), n), transactionHash: h("c", n),
  address: "0x00000000000000000000000000000000000000aa", topics: ["0x01"], data: "0x", removed: false,
}));
const canonical = () => "a";

// Each fake RPC: its finalized block, its chain of block hashes, and the logs it answers.
function serve(rpcs) {
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    const rpc = rpcs[new URL(url).host];
    let result;
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "finalized" ? rpc.finalized : Number(BigInt(params[0]));
      result = n == null ? null : { number: hx(n), hash: h(rpc.chain(n), n) };
    } else if (method === "eth_getLogs") {
      const [f, t] = [Number(BigInt(params[0].fromBlock)), Number(BigInt(params[0].toBlock))];
      result = rpc.logs.filter((l) => Number(BigInt(l.blockNumber)) >= f && Number(BigInt(l.blockNumber)) <= t);
    } else throw new Error(method);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
}
const A = "https://a.test", B = "https://b.test";
const rowsOf = (logs) => ({ t__x: logs.map((l) => {
  const n = Number(BigInt(l.blockNumber));
  return { table: "t__x", block_number: n, log_index: 0, block_timestamp: 1_700_000_000 + n * 12, block_hash: l.blockHash, value: "1" };
}) });
function sealedThrough(ceiling, logs) {
  const s = new Sealer(100, 10);
  s.push(JSON.stringify(rowsOf(logs)));
  return Math.max(100, ...JSON.parse(s.seal(ceiling)).map((x) => x.to_block));
}
const ask = (logs) => agreedCeiling({ a: A, b: B, logs, filter: {}, floor: 100 });

// Both agree: sealed through the lower of the two finalized blocks, here a span cut at 190.
const good = logsOn(canonical);
serve({ "a.test": { finalized: 200, chain: canonical, logs: good }, "b.test": { finalized: 195, chain: canonical, logs: good } });
let got = await ask(good);
assert.equal(got.ceiling, 195, String(got.reason));
assert.equal(sealedThrough(got.ceiling, good), 190);

// B has not finalized past the last seal: nothing is sealed.
serve({ "a.test": { finalized: 200, chain: canonical, logs: good }, "b.test": { finalized: 100, chain: canonical, logs: good } });
got = await ask(good);
assert.equal(got.ceiling, 100);
assert.equal(sealedThrough(got.ceiling, good), 100);

// B reports no finalized block at all.
serve({ "a.test": { finalized: 200, chain: canonical, logs: good }, "b.test": { finalized: null, chain: canonical, logs: good } });
assert.equal((await ask(good)).ceiling, 100);

// The two give the finalized block different hashes: nothing is sealed.
const fork = (n) => (n >= 150 ? "b" : "a");
serve({ "a.test": { finalized: 200, chain: canonical, logs: good }, "b.test": { finalized: 200, chain: fork, logs: logsOn(fork) } });
got = await ask(good);
assert.equal(got.ceiling, 100);
assert.match(got.reason, /different hashes/);

// A's log for block 146 came from a fork that was reorged away before B finalized it: the ceiling
// stops below it, and no segment reaches block 146.
const forked = logsOn((n) => (n === 146 ? "f" : "a"));
serve({ "a.test": { finalized: 200, chain: canonical, logs: forked }, "b.test": { finalized: 200, chain: canonical, logs: good } });
got = await ask(forked);
assert.equal(got.ceiling, 145, String(got.reason));
assert.ok(sealedThrough(got.ceiling, forked) < 146);

// B returns a log at block 153 that A left out: nothing from block 153 on is sealed.
serve({ "a.test": { finalized: 200, chain: canonical, logs: good }, "b.test": { finalized: 200, chain: canonical, logs: logsOn(canonical, [153]) } });
got = await ask(good);
assert.equal(got.ceiling, 152, String(got.reason));
assert.ok(sealedThrough(got.ceiling, good) < 153);

console.log("RESULT: PASS (6 scripted cases)");
