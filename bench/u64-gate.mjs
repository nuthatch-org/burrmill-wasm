// The segment-hash gate for integers past 2^53 (nuthatch #2182), offline: the nest the builder scaffolds
// from src/fixtures/uint64-nest.json, indexed by "Index it" against a scripted RPC pair, must seal the
// bytes a node seals (the hashes `cargo test` pins from nuthatch-seal) and serve the values exactly,
// sealed and unsealed alike.
//   node bench/u64-gate.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { backfill, openable, storeFns, unsealed, headRows } from "../web/play/index-it.js";

const w = createRequire(import.meta.url)("../pkg/node/burrmill_wasm.js");
const fixture = JSON.parse(fs.readFileSync(new URL("../src/fixtures/uint64-nest.json", import.meta.url), "utf8"));
const files = JSON.parse(w.scaffoldNest(JSON.stringify(fixture.input)));
const EXACT = ["5009297550715157269", "-9007199254740993", "18446744073709551615", "-9223372036854775808"];

const hx = (n) => `0x${n.toString(16)}`;
const head = 130;
// Both RPCs answer the fixture's logs, and each block's header with the timestamp its logs carry.
function serve(finalized) {
  globalThis.fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(init.body);
    let result;
    if (method === "eth_blockNumber") result = hx(head);
    else if (method === "eth_getBlockByNumber") {
      const n = params[0] === "finalized" ? finalized : Number(BigInt(params[0]));
      const log = fixture.logs.find((l) => Number(BigInt(l.blockNumber)) === n);
      result = { number: hx(n), hash: `0x${n.toString(16).padStart(64, "a")}`, timestamp: log?.blockTimestamp ?? hx(1_700_000_000 + n * 12) };
    } else if (method === "eth_getLogs") {
      const [f, t] = [Number(BigInt(params[0].fromBlock)), Number(BigInt(params[0].toBlock))];
      result = fixture.logs.filter((l) => Number(BigInt(l.blockNumber)) >= f && Number(BigInt(l.blockNumber)) <= t);
    } else throw new Error(method);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result }) };
  };
}
const table = Object.keys(fixture.sealed)[0];
const answer = async (state, head = {}) => {
  const nest = new w.Nest(...Object.values(storeFns(state.store)), "", openable(state), files["schema.json"]);
  nest.setTail(unsealed(state, head));
  return nest.queryLines(`SELECT * FROM "${table}"`);
};

// Finalized past the span: both rows sealed into one segment, which must be the node's.
serve(head);
const store = new Map();
const sealed = await backfill({ w, files, from: 101, span: 10, rpc: "https://a.test", second: "https://b.test", store });
const ours = Object.fromEntries([...Object.entries(sealed.manifest.tables), ...Object.entries(sealed.provisional).map(([t, s]) => [t, [s]])].map(([t, segs]) => [t, segs.map((s) => s.hash).join(",")]));
assert.deepEqual(ours, fixture.sealed, "the tab's segments do not hash to the node's");
let text = await answer(sealed);
for (const v of EXACT) assert.ok(text.includes(v), `the sealed answer lost ${v}: ${text}`);

// Finalized before the span ends: nothing sealed, the rows served from what was fetched and the head.
serve(104);
const held = await backfill({ w, files, from: 101, span: 10, rpc: "https://a.test", second: "https://b.test", store: new Map() });
assert.equal(Object.keys(held.manifest.tables).length + Object.keys(held.provisional).length, 0);
const top = await headRows({ decoder: held.decoder, rpc: "https://a.test", after: held.sealedTo });
text = await answer(held, top.rows);
for (const v of EXACT) assert.ok(text.includes(v), `the unsealed answer lost ${v}: ${text}`);

console.log(`RESULT: PASS (${table} sealed to ${ours[table].slice(0, 12)}…, every value exact sealed and unsealed)`);
