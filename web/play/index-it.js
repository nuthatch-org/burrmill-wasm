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
  const state = begin({ w, files, from, span, store });
  await advance(state, { rpc, second, ceiling, progress, log });
  return state;
}

// A nest with nothing sealed yet, resuming at `from`.
export function begin({ w, files, from, span = 1800, store }) {
  const abis = Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith("abis/")));
  const decoder = new w.Decoder(files["nuthatch.toml"], JSON.stringify(abis));
  return {
    decoder,
    filter: JSON.parse(decoder.filter()),
    sealer: new w.Sealer(from - 1, span),
    store,
    manifest: { tables: {} },
    provisional: {},
    sealedTo: from - 1,
    finalized: from - 1,
    logs: 0,
    bytes: 0,
    ms: 0,
  };
}

// Seal from where `state` stopped to the block both RPCs call finalized (at most `ceiling`). Answers
// whether anything new was sealed. Called again as finality advances.
export async function advance(state, { rpc, second, ceiling = Infinity, progress = () => {}, log = () => {} }) {
  const t0 = Date.now();
  // Both RPCs' finalized block, which must carry one hash; agreement on logs is checked per window.
  const head = await agreedFinalized({ a: rpc, b: second, floor: state.sealedTo });
  if (head.reason) {
    // Once following, a finalized block that has not moved yet is the usual answer, not a failure.
    if (state.followed && /nothing past/.test(head.reason)) return false;
    throw new Error(head.reason);
  }
  const finalized = Math.min(head.ceiling, ceiling);
  state.finalized = finalized;
  const before = state.sealedTo;
  for (let next = state.sealedTo + 1; next <= finalized; ) {
    const end = Math.min(finalized, next + WINDOW - 1);
    const tail = await fetchTail({ rpc, decoder: state.decoder, from: next, to: end, log });
    const agreed = await agreedLogs({ b: second, logs: tail.raw, filter: state.filter, floor: next - 1, ceiling: end });
    if (agreed.reason) throw new Error(agreed.reason);
    state.logs += tail.logs;
    state.sealer.push(JSON.stringify(tail.rows));
    const sealed = JSON.parse(state.sealer.seal(end));
    sealed.forEach((s, i) => {
      const file = state.sealer.bytes(i);
      state.store.set(`${s.table}/${s.hash}.parquet`, file);
      const meta = { hash: s.hash, from_block: s.from_block, to_block: s.to_block, rows: s.rows };
      const old = state.provisional[s.table];
      // A tail is replaced by the next cut of its table; its file is not read again.
      if (old && old.hash !== s.hash) state.store.delete(`${s.table}/${old.hash}.parquet`);
      delete state.provisional[s.table];
      if (s.provisional) state.provisional[s.table] = meta;
      else {
        (state.manifest.tables[s.table] ??= []).push(meta);
        state.bytes += file.length;
      }
    });
    state.sealedTo = end;
    next = end + 1;
    state.ms += Date.now() - t0;
    progress({ through: end, finalized, logs: state.logs, segments: count(state.manifest), ms: state.ms });
  }
  state.followed = true;
  return state.sealedTo > before;
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
