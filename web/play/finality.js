// Where the tab's finality comes from before a light client (RFC-0065 §4): a block is sealed below
// only when two independent RPCs both call it finalized, give it the same hash, and return the same
// logs, block hashes included, for every block up to it. Nothing here is authenticated; it is agreement.

let id = 0;
async function one(rpc, method, params) {
  let j = null;
  for (let attempt = 0; !j; attempt++) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }).catch((e) => e);
    const busy = r instanceof Error || r.status === 429 || r.status === 403 || r.status >= 500;
    // A 4xx can still carry the RPC's reason, which is what says a range was too wide.
    if (!busy && !r.ok) throw new Error(`${new URL(rpc).host}: ${(await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`}`);
    j = busy ? null : await r.json().catch(() => null);
    if (!j && attempt === 5) throw new Error(`${new URL(rpc).host}: ${r instanceof Error ? r.message : `HTTP ${r.status}`}, six times`);
    if (!j) await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
const hex = (n) => `0x${n.toString(16)}`;
const num = (h) => Number(BigInt(h));
const header = (rpc, tag) => one(rpc, "eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]);
const refusedRange = (e) => /range|limit|too many|exceed|max|response size|10000|query returned/i.test(String(e?.message ?? e));

async function getLogs(rpc, filter, from, to) {
  const out = [];
  let next = from;
  let size = to - from + 1;
  while (next <= to) {
    const end = Math.min(to, next + size - 1);
    try {
      out.push(...(await one(rpc, "eth_getLogs", [{ ...filter, fromBlock: hex(next), toBlock: hex(end) }])));
      next = end + 1;
    } catch (e) {
      if (size > 1 && refusedRange(e)) { size = Math.max(1, Math.floor(size / 2)); continue; }
      throw e;
    }
  }
  return out;
}

/// Each block's logs as comparable strings, for blocks in `(floor, ceiling]`.
function byBlock(logs, floor, ceiling) {
  const m = new Map();
  for (const l of logs) {
    const b = num(l.blockNumber);
    if (l.removed === true || b <= floor || b > ceiling) continue;
    const sig = [num(l.logIndex), l.blockHash, l.transactionHash, l.address.toLowerCase(), l.topics.join(","), l.data].join("|");
    if (!m.has(b)) m.set(b, []);
    m.get(b).push(sig);
  }
  for (const v of m.values()) v.sort();
  return m;
}

/// The highest block past `floor` that `a` and `b` both call finalized, with the same hash, and for
/// which `b` returns exactly `logs` (what `a` answered for `filter`), or `floor` and why not.
export async function agreedCeiling({ a, b, logs, filter, floor }) {
  const head = await agreedFinalized({ a, b, floor });
  if (head.reason) return head;
  const { ceiling } = head;
  return agreedLogs({ b, logs, filter, floor, ceiling });
}

/// The lower of the two RPCs' finalized blocks, if both give it one hash, or `floor` and why not.
export async function agreedFinalized({ a, b, floor }) {
  const [fa, fb] = await Promise.all([header(a, "finalized"), header(b, "finalized")]);
  if (!fa || !fb) return { ceiling: floor, reason: `${new URL(fa ? b : a).host} reports no finalized block` };
  const ceiling = Math.min(num(fa.number), num(fb.number));
  if (ceiling <= floor) return { ceiling: floor, reason: "nothing past the last seal is finalized on both" };
  const [ha, hb] = await Promise.all([header(a, ceiling), header(b, ceiling)]);
  if (!ha?.hash || ha.hash !== hb?.hash) return { ceiling: floor, reason: `the two RPCs give block ${ceiling} different hashes` };
  return { ceiling, reason: null };
}

/// `ceiling`, or the block before the first in `(floor, ceiling]` for which `b` does not return
/// exactly `logs`.
export async function agreedLogs({ b, logs, filter, floor, ceiling }) {
  const ours = byBlock(logs, floor, ceiling);
  const theirs = byBlock(await getLogs(b, filter, floor + 1, ceiling), floor, ceiling);
  const blocks = [...new Set([...ours.keys(), ...theirs.keys()])].sort((x, y) => x - y);
  for (const block of blocks) {
    if ((ours.get(block) ?? []).join("\n") !== (theirs.get(block) ?? []).join("\n")) {
      return { ceiling: block - 1, reason: `the two RPCs return different logs for block ${block}` };
    }
  }
  return { ceiling, reason: null, blocks: blocks.length };
}
