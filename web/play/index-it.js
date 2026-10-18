// "Index it" (RFC-0066 S2, on RFC-0065 S6): a nest the tab has never seen, backfilled from its deploy
// block and sealed here, then followed to the head. A block is sealed only once two RPCs both call it
// finalized, with one hash, and return the same logs for it (finality.js); the light client's header
// check is the published nest's tail, and over a backfill it costs more than the backfill (S6, §12).
// Segments live in `store`, a Map of key to bytes, which a `Nest` reads as it reads the mirror.
import { fetchTail, headBlock } from "./tail.js";
import { agreedFinalized, agreedLogs } from "./finality.js";

const WINDOW = 20000;

// `files` is the nest as path to text; `from` its first block, `ceiling` the last it may seal.
// `progress(event)` hears each window.
export async function backfill({ w, files, from, rpc, second, span = 1800, ceiling = Infinity, store, progress = () => {}, log = () => {} }) {
  const abis = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("abis/")));
  const decoder = new w.Decoder(files["nuthatch.toml"], JSON.stringify(abis));
  const filter = JSON.parse(decoder.filter());
  const sealer = new w.Sealer(from - 1, span);
  const manifest = { tables: {} };
  const provisional = {};
  const t0 = Date.now();
  let logs = 0;
  let bytes = 0;
  // Both RPCs' finalized block, which must carry one hash; agreement on logs is checked per window.
  const head = await agreedFinalized({ a: rpc, b: second, floor: from - 1 });
  if (head.reason && head.ceiling < from) throw new Error(head.reason);
  const finalized = Math.min(head.ceiling, ceiling);
  for (let next = from; next <= finalized; ) {
    const end = Math.min(finalized, next + WINDOW - 1);
    const tail = await fetchTail({ rpc, decoder, from: next, to: end, log });
    const agreed = await agreedLogs({ b: second, logs: tail.raw, filter, floor: next - 1, ceiling: end });
    if (agreed.reason) throw new Error(agreed.reason);
    logs += tail.logs;
    sealer.push(JSON.stringify(tail.rows));
    const sealed = JSON.parse(sealer.seal(end));
    sealed.forEach((s, i) => {
      const file = sealer.bytes(i);
      store.set(`${s.table}/${s.hash}.parquet`, file);
      const meta = { hash: s.hash, from_block: s.from_block, to_block: s.to_block, rows: s.rows };
      if (s.provisional) provisional[s.table] = meta;
      else {
        (manifest.tables[s.table] ??= []).push(meta);
        if (provisional[s.table]?.to_block <= s.to_block) delete provisional[s.table];
        bytes += file.length;
      }
    });
    next = end + 1;
    progress({ through: end, finalized, logs, segments: count(manifest), ms: Date.now() - t0 });
  }
  return { decoder, sealer, manifest, provisional, finalized, logs, bytes, ms: Date.now() - t0 };
}

const count = (m) => Object.values(m.tables).reduce((n, s) => n + s.length, 0);

// The manifest a `Nest` opens: every sealed segment, plus each table's provisional tail.
export function openable({ manifest, provisional }) {
  const tables = structuredClone(manifest.tables);
  for (const [t, s] of Object.entries(provisional)) (tables[t] ??= []).push(s);
  return JSON.stringify({ tables });
}

// Rows past the seal, to the head: unfinalized, so served and never sealed.
export async function headRows({ decoder, rpc, after }) {
  const to = await headBlock(rpc);
  if (to <= after) return { rows: {}, to: after };
  const tail = await fetchTail({ rpc, decoder, from: after + 1, to });
  return { rows: tail.rows, to };
}

// A `Nest` over `store`, as the worker opens the mirror's.
export function storeFns(store) {
  const get = (key) => {
    const b = store.get(key);
    if (!b) throw new Error(`no segment ${key}`);
    return b;
  };
  return {
    size: async (key) => get(key).length,
    read: async (key, offset, length) => get(key).subarray(offset, offset + length),
  };
}
