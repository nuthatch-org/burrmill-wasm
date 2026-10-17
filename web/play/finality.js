// Where the tab's finality comes from before a light client (RFC-0065 §4): a block is sealed below
// only when two independent RPCs both call it finalized, give it the same hash, and give every block a
// row to be sealed came from the hash that row carries. Nothing here is authenticated; it is agreement.

let id = 0;
async function one(rpc, method, params) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (!r.ok) throw new Error(`${new URL(rpc).host}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
const hex = (n) => `0x${n.toString(16)}`;
const header = (rpc, tag) => one(rpc, "eth_getBlockByNumber", [typeof tag === "number" ? hex(tag) : tag, false]);

async function hashes(rpc, blocks) {
  const out = new Map();
  for (let i = 0; i < blocks.length; i += 10) {
    const part = blocks.slice(i, i + 10);
    const heads = await Promise.all(part.map((b) => header(rpc, b)));
    part.forEach((b, j) => out.set(b, heads[j]?.hash ?? null));
  }
  return out;
}

/// The highest block both RPCs agree is final and that every row in `rows` (table to rows, as the
/// decoder answers them) agrees with, or `floor` and why not. `rows` came from `a`'s logs.
export async function agreedCeiling({ a, b, rows, floor }) {
  const [fa, fb] = await Promise.all([header(a, "finalized"), header(b, "finalized")]);
  if (!fa || !fb) return { ceiling: floor, reason: `${new URL(fa ? b : a).host} reports no finalized block` };
  let ceiling = Math.min(Number(BigInt(fa.number)), Number(BigInt(fb.number)));
  if (ceiling <= floor) return { ceiling: floor, reason: "nothing past the last seal is finalized on both" };
  const [ha, hb] = await Promise.all([header(a, ceiling), header(b, ceiling)]);
  if (!ha?.hash || ha.hash !== hb?.hash) return { ceiling: floor, reason: `the two RPCs give block ${ceiling} different hashes` };

  const carried = new Map();
  for (const r of Object.values(rows).flat()) {
    if (r.block_number > floor && r.block_number <= ceiling) carried.set(r.block_number, r.block_hash);
  }
  const blocks = [...carried.keys()].sort((x, y) => x - y);
  const theirs = await hashes(b, blocks);
  for (const block of blocks) {
    if (theirs.get(block) !== carried.get(block)) {
      return { ceiling: block - 1, reason: `block ${block}'s logs carry a hash ${new URL(b).host} does not give it` };
    }
  }
  return { ceiling, reason: null, checked: blocks.length + 1 };
}
