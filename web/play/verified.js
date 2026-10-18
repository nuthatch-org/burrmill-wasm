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
