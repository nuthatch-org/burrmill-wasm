// RFC-0065 S5's gates for the verified head, against a scripted RPC over three real mainnet headers and
// a scripted light client: nothing is sealed below a finalized block the light client did not give, or
// on headers or logs that do not hash down from it.
//   node bench/verified-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { verifyChain } = require("../pkg/node/burrmill_wasm.js");
const { verifiedFinalized, verifiedCeiling } = await import("../web/play/verified.js");

const real = JSON.parse(fs.readFileSync(new URL("../src/fixtures/headers.json", import.meta.url), "utf8"));
const floor = Number(BigInt(real[0].number)) - 1;
const top = { number: floor + 3, hash: real[2].hash };
const RPC = "https://rpc.test";

function serve(headers) {
  globalThis.fetch = async (url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    assert.equal(method, "eth_getBlockByNumber");
    const h = headers.find((x) => x.number === params[0]);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id, result: h ? structuredClone(h) : null }) };
  };
}
const logIn = (h) => ({ blockNumber: h.number, blockHash: h.hash, logIndex: "0x0" });
const ceiling = (headers, logs, t = top) => (serve(headers), verifiedCeiling({ rpc: RPC, top: t, floor, logs, verifyChain }));
let cases = 0;
const ok = async (name, f) => { await f(); cases++; console.log(`ok - ${name}`); };

await ok("headers that hash down from the verified block seal through it", async () => {
  const v = await ceiling(real, real.map(logIn));
  assert.deepEqual([v.ceiling, v.reason, v.headers], [top.number, null, 3]);
});

await ok("a finalized hash the RPC's chain does not reach is refused", async () => {
  await assert.rejects(ceiling(real, [], { ...top, hash: `0x${"7".repeat(64)}` }), /the light client verified/);
});

await ok("an altered header is refused, whether or not its hash field is rewritten", async () => {
  const forged = structuredClone(real);
  forged[0].receiptsRoot = `0x${"1".repeat(64)}`;
  await assert.rejects(ceiling(forged, []), /not the 0x/);
  forged[0].hash = real[1].parentHash.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  await assert.rejects(ceiling(forged, []), /hashes to|parent/);
});

await ok("a missing header is refused", async () => {
  serve([real[0], real[2]]);
  await assert.rejects(verifiedCeiling({ rpc: RPC, top, floor, logs: [], verifyChain }), /no header for block/);
});

await ok("a log on a block hash off the verified chain holds the seal below that block", async () => {
  const logs = real.map(logIn);
  logs[1] = { ...logs[1], blockHash: `0x${"9".repeat(64)}` };
  const v = await ceiling(real, logs);
  assert.equal(v.ceiling, floor + 1);
  assert.match(v.reason, /not on the verified chain/);
});

await ok("nothing past the last seal is finalized: no header is fetched", async () => {
  globalThis.fetch = () => { throw new Error("fetched"); };
  const v = await verifiedCeiling({ rpc: RPC, top: { ...top, number: floor }, floor, logs: [], verifyChain });
  assert.equal(v.ceiling, floor);
});

// The light client, scripted: what `createHeliosProvider` would answer.
const kept = [];
const client = (answer) => async (config) => ({
  config,
  waitSynced: async () => {},
  request: async ({ method }) => (method === "helios_getCurrentCheckpoint" ? "0xcafe" : answer()),
});
const shipped = { root: "0xship", at: 1 };
const ask = (create, load = async () => null) => verifiedFinalized({ create, chainId: 1, rpc: `${RPC}/${kept.length}-${Math.random()}`, shipped, load, save: async (c) => kept.push(c), tries: 2, wait: 1 });

await ok("a finalized block the light client cannot verify is not given", async () => {
  await assert.rejects(ask(client(() => { throw new Error("out of sync"); })), /no finalized block: out of sync/);
  await assert.rejects(ask(client(() => null)), /no finalized block/);
});

await ok("the light client's finalized block is given, and its checkpoint kept", async () => {
  let started;
  const create = async (config, kind) => { started = config; return client(() => ({ number: "0xa", hash: "0xab" }))(config, kind); };
  const f = await ask(create, async () => ({ root: "0xnewer", at: 2 }));
  assert.deepEqual([f.number, f.hash], [10, "0xab"]);
  assert.equal(started.checkpoint, "0xnewer");
  assert.equal(kept.at(-1).root, "0xcafe");
});

console.log(`RESULT: PASS (${cases} scripted cases)`);
