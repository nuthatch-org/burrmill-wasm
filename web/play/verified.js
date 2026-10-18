// RFC-0065 S5: the finalized block from Helios's beacon light client, which checks it through the sync
// committee from a checkpoint, so the consensus endpoint can withhold an update but not forge one. The
// headers under it come from the untrusted RPC and are only kept if they hash, parent by parent, to it.

const CONSENSUS = { 1: "https://lodestar-mainnet.chainsafe.io" };

let client = null;

/// The light client for `rpc`, started once per worker from the newer of the checkpoint shipped with the
/// page and the last one this browser kept. `create` is Helios's `createHeliosProvider`.
async function start({ create, chainId, rpc, shipped, load }) {
  if (client?.rpc === rpc) return client;
  const consensus = CONSENSUS[chainId];
  if (!consensus) throw new Error(`no light client is configured for chain ${chainId}`);
  const kept = await load();
  const checkpoint = kept && kept.at > shipped.at ? kept : shipped;
  const t = performance.now();
  // A worker has no localStorage, which Helios's default store wants.
  const p = await create({ executionRpc: rpc, consensusRpc: consensus, network: "mainnet", checkpoint: checkpoint.root, dbType: "config" }, "ethereum");
  await p.waitSynced();
  client = { rpc, p, consensus, from: checkpoint, sync_ms: performance.now() - t };
  return client;
}

/// Helios's finalized block, `{number, hash}`, and the checkpoint it now holds, which `save` keeps.
export async function verifiedFinalized({ create, chainId, rpc, shipped, load, save, tries = 10, wait = 3000 }) {
  const c = await start({ create, chainId, rpc, shipped, load });
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const b = await c.p.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
      if (b?.hash) {
        const root = await c.p.request({ method: "helios_getCurrentCheckpoint", params: [] });
        await save({ root, at: Date.now() });
        return { number: Number(BigInt(b.number)), hash: b.hash, consensus: new URL(c.consensus).host, sync_ms: c.sync_ms };
      }
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`the light client gave no finalized block: ${last?.message ?? last ?? "none"}`);
}

let id = 0;
/// Block `n`'s header from the first of `sources` (starting at `n`'s turn) that is not throttling.
async function header(sources, n) {
  for (let wait = 500; ; wait *= 2) {
    for (let k = 0; k < sources.length; k++) {
      const rpc = sources[(n + k) % sources.length];
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] }) });
      if (r.status === 429) continue;
      if (!r.ok) throw new Error(`${new URL(rpc).host}: HTTP ${r.status}`);
      const j = await r.json();
      if (!j.result) throw new Error(`${new URL(rpc).host} has no header for block ${n}`);
      delete j.result.transactions;
      return j.result;
    }
    // A public RPC throttles a few thousand headers in a row and answers again after a pause.
    if (wait > 16000) throw new Error(`every RPC is throttling; block ${n}'s header was refused for a minute`);
    await new Promise((res) => setTimeout(res, wait));
  }
}

/// `top`'s ceiling once the headers in `(floor, top.number]` hash down from `top.hash` (`verifyChain` is
/// the wasm check), lowered to the block before the first of `rpc`'s `logs` whose block hash is not on
/// that chain. The headers are shared across `sources`, any RPCs at all, since none of them is trusted.
export async function verifiedCeiling({ rpc, sources = [rpc], top, floor, logs, verifyChain, concurrency = 10 }) {
  if (top.number <= floor) return { ceiling: floor, reason: "nothing past the last seal is finalized" };
  const blocks = Array.from({ length: top.number - floor }, (_, i) => floor + 1 + i);
  const headers = [];
  for (let i = 0; i < blocks.length; i += concurrency) {
    headers.push(...(await Promise.all(blocks.slice(i, i + concurrency).map((n) => header(sources, n)))));
  }
  const chain = JSON.parse(verifyChain(JSON.stringify(headers), top.hash));
  for (const l of [...logs].sort((x, y) => Number(BigInt(x.blockNumber)) - Number(BigInt(y.blockNumber)))) {
    const n = Number(BigInt(l.blockNumber));
    if (n <= floor || n > top.number) continue;
    if (l.blockHash !== chain[n]) return { ceiling: n - 1, reason: `${new URL(rpc).host}'s logs for block ${n} are not on the verified chain` };
  }
  return { ceiling: top.number, reason: null, headers: headers.length };
}

const matches = (filter, log) => {
  const addrs = [filter.address ?? []].flat().map((a) => a.toLowerCase());
  if (addrs.length && !addrs.includes(log.address.toLowerCase())) return false;
  return (filter.topics ?? []).every((want, i) => want == null || [want].flat().includes(log.topics[i]));
};
const sig = (l, i) => [i, l.address.toLowerCase(), l.topics.join(","), l.data].join("|");

/// Each of `blocks` (at or below `top`) checked against its receipts: they must hash to the block's
/// header, verified down from `top`, and the block's logs that match `filter` must be exactly `rpc`'s
/// `logs` for it. A block that passes is complete: no row of it was altered, added or left out.
export async function checkReceipts({ rpc, sources = [rpc], top, blocks, logs, filter, verifyChain, verifyReceipts, concurrency = 4 }) {
  if (!blocks.length) return { checked: 0, complete: 0, differ: [], bytes: 0 };
  const low = Math.min(...blocks);
  const want = Array.from({ length: top.number - low + 1 }, (_, i) => low + i);
  const headers = [];
  for (let i = 0; i < want.length; i += 10) headers.push(...(await Promise.all(want.slice(i, i + 10).map((n) => header(sources, n)))));
  // Past this, each header's fields are the ones that hashed down to the light client's block.
  verifyChain(JSON.stringify(headers), top.hash);
  const byNumber = new Map(headers.map((h) => [Number(BigInt(h.number)), h]));
  const theirs = new Map();
  for (const l of logs) {
    const n = Number(BigInt(l.blockNumber));
    if (!theirs.has(n)) theirs.set(n, []);
    theirs.get(n).push(sig(l, Number(BigInt(l.logIndex))));
  }
  let bytes = 0;
  const differ = [];
  for (let i = 0; i < blocks.length; i += concurrency) {
    await Promise.all(blocks.slice(i, i + concurrency).map(async (n) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_getBlockReceipts", params: [`0x${n.toString(16)}`] }) });
      if (!r.ok) throw new Error(`${new URL(rpc).host}: HTTP ${r.status}`);
      const text = await r.text();
      bytes += text.length;
      const receipts = JSON.parse(text).result;
      if (!receipts) throw new Error(`${new URL(rpc).host} has no receipts for block ${n}`);
      let all;
      try { all = JSON.parse(verifyReceipts(JSON.stringify(receipts), byNumber.get(n).receiptsRoot)); }
      catch (e) { differ.push({ block: n, reason: String(e?.message ?? e) }); return; }
      const ours = all.map(sig).filter((_, k) => matches(filter, all[k])).sort();
      const got = [...(theirs.get(n) ?? [])].sort();
      if (ours.join("\n") !== got.join("\n")) {
        differ.push({ block: n, reason: `the block has ${ours.length} matching logs; ${new URL(rpc).host} returned ${got.length}, ${got.filter((s) => !ours.includes(s)).length} of them not in its receipts` });
      }
    }));
  }
  return { checked: blocks.length, complete: blocks.length - differ.length, differ: differ.sort((a, b) => a.block - b.block), bytes, headers: headers.length };
}
