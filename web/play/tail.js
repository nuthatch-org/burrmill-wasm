// The live tail's fetch (RFC-0065 S3): the nest's logs over a block range from one RPC, each block's
// timestamp, then nuthatch's decoder (in wasm) for the rows. Shared by the worker and bench/tail-gate.mjs.
// Nothing here is verified: the rows are whatever this RPC said, which is why the page says so.

const SAMPLE = 20;
/// How far before the mirror's cut the tail starts: a table's unpublished rows are under three hours of
/// chain time old (nuthatch #2084), 900 mainnet slots, so twice that covers missed slots too.
export const MARGIN = 1800;

let id = 0;
async function call(rpc, body) {
  // A public RPC answers a busy moment with 429, a 403 (publicnode), a 5xx or a body that is not JSON.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch((e) => e);
    const busy = r instanceof Error || r.status === 429 || r.status === 403 || r.status >= 500;
    if (!busy && !r.ok) throw new Error(`${new URL(rpc).host}: HTTP ${r.status}`);
    const j = busy ? null : await r.json().catch(() => null);
    if (j) return j;
    if (attempt === 5) throw new Error(`${new URL(rpc).host}: ${r instanceof Error ? r.message : `HTTP ${r.status}`}, six times`);
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
}
async function one(rpc, method, params) {
  const j = await call(rpc, { jsonrpc: "2.0", id: ++id, method, params });
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
export const headBlock = async (rpc) => Number(BigInt(await one(rpc, "eth_blockNumber", [])));
const hex = (n) => `0x${n.toString(16)}`;
const refusedRange = (e) => /range|limit|too many|exceed|max|response size|10000|query returned/i.test(String(e?.message ?? e));

/// Each block's timestamp from its header, a handful at a time.
async function headerTimes(rpc, blocks) {
  const out = {};
  for (let i = 0; i < blocks.length; i += 10) {
    const part = blocks.slice(i, i + 10);
    const heads = await Promise.all(part.map((b) => one(rpc, "eth_getBlockByNumber", [hex(b), false])));
    part.forEach((b, k) => {
      if (!heads[k]) throw new Error(`no header for block ${b}`);
      out[b] = Number(BigInt(heads[k].timestamp));
    });
  }
  return out;
}

export async function fetchTail({ rpc, decoder, from, to, chunk = 2000, log = () => {} }) {
  if (to < from) return { rows: {}, logs: 0, undecoded: 0, removed: 0, checked: 0, from, to };
  const filter = JSON.parse(decoder.filter());
  const logs = [];
  let next = from;
  let size = chunk;
  while (next <= to) {
    const end = Math.min(to, next + size - 1);
    try {
      const got = await one(rpc, "eth_getLogs", [{ ...filter, fromBlock: hex(next), toBlock: hex(end) }]);
      logs.push(...got);
      next = end + 1;
    } catch (e) {
      if (size > 1 && refusedRange(e)) { size = Math.max(1, Math.floor(size / 2)); log(`range refused, asking ${size} blocks at a time`); continue; }
      throw e;
    }
  }
  // A node that carries `blockTimestamp` on each log answers the header nuthatch would buy per block,
  // and nuthatch uses it (`remember_log_timestamps`); a sample is checked against the headers here.
  const times = {};
  let checked = 0;
  if (decoder.timestamps()) {
    const live = logs.filter((l) => l.removed !== true);
    for (const l of live) {
      const ts = l.blockTimestamp && Number(BigInt(l.blockTimestamp));
      if (ts) times[Number(BigInt(l.blockNumber))] = ts;
    }
    const blocks = [...new Set(live.map((l) => Number(BigInt(l.blockNumber))))].sort((a, b) => a - b);
    const missing = blocks.filter((b) => times[b] === undefined);
    Object.assign(times, await headerTimes(rpc, missing));
    const fetched = new Set(missing);
    const carried = blocks.filter((b) => !fetched.has(b));
    const sample = carried.filter((_, i) => i % Math.max(1, Math.floor(carried.length / SAMPLE)) === 0).slice(0, SAMPLE);
    const truth = await headerTimes(rpc, sample);
    for (const b of sample) {
      if (truth[b] !== times[b]) throw new Error(`block ${b}: the log says ${times[b]}, the header ${truth[b]}`);
    }
    checked = sample.length + missing.length;
  }
  const decoded = JSON.parse(decoder.decode(JSON.stringify(logs), JSON.stringify(times)));
  return { ...decoded, checked, from, to, raw: logs };
}
