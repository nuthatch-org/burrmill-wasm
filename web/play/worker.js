// The engine and its segment store, off the page's thread: a heavy view no longer freezes the tab,
// and terminating this worker is how a query is cancelled. Each segment is fetched whole, checked
// against the SHA-256 its key names, and kept in the origin-private file system.
import init, { Nest, Decoder, wasmMemory } from "./pkg/burrmill_wasm.js";
import { prepare } from "./chart.js";
import { fetchTail, headBlock, MARGIN } from "./tail.js";

const CONCURRENCY = 16;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

let opfs;
async function opfsDir() {
  if (opfs !== undefined) return opfs;
  try { opfs = await (await navigator.storage.getDirectory()).getDirectoryHandle("segments", { create: true }); }
  catch { opfs = null; }
  return opfs;
}
async function opfsGet(hash) {
  const dir = await opfsDir();
  if (!dir) return null;
  try { return new Uint8Array(await (await (await dir.getFileHandle(hash)).getFile()).arrayBuffer()); }
  catch { return null; }
}
async function opfsPut(hash, bytes) {
  const dir = await opfsDir();
  if (!dir) return;
  try { const w = await (await dir.getFileHandle(hash, { create: true })).createWritable(); await w.write(bytes); await w.close(); }
  catch { /* a full or refused store only costs a refetch */ }
}

const counts = { fetched: 0, cached: 0, bytes: 0, reads: 0, read_ms: 0 };
function segmentStore(base) {
  const cache = new Map();
  let active = 0;
  const waiting = [];
  const acquire = () => new Promise((go) => (active < CONCURRENCY ? (active++, go()) : waiting.push(go)));
  const release = () => { const next = waiting.shift(); next ? next() : active--; };
  async function fetchVerified(key) {
    const want = key.split("/").pop().replace(/\.parquet$/, "");
    const kept = await opfsGet(want);
    if (kept) { counts.cached++; return kept; }
    await acquire();
    try {
      const r = await fetch(`${base}/${key}`);
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const got = hex(await crypto.subtle.digest("SHA-256", bytes));
      if (got !== want) throw new Error(`${key}: content is ${got.slice(0, 12)}…, not the address it is stored under`);
      counts.fetched++;
      counts.bytes += bytes.length;
      await opfsPut(want, bytes);
      return bytes;
    } finally { release(); }
  }
  const whole = (key) => { if (!cache.has(key)) cache.set(key, fetchVerified(key)); return cache.get(key); };
  // Time the engine spends waiting on the store, against the time it spends computing.
  const timed = (f) => async (...a) => {
    const t = performance.now();
    try { return await f(...a); } finally { counts.reads++; counts.read_ms += performance.now() - t; }
  };
  return {
    size: timed(async (key) => (await whole(key)).length),
    read: timed(async (key, offset, length) => {
      const bytes = await whole(key);
      return bytes.subarray(offset, offset + length);
    }),
  };
}

const ready = init();
let engine;

// The live tail's decoder for the open nest, or why there is none.
let decoder = null;
let refused = null;
let chainId = null;
// Past this, the mirror is too far behind for a public RPC to fill the gap in a tab.
const MAX_TAIL = 50_000;

async function open({ base, views, decoder: decoderUrl }) {
  await ready;
  const [manifestText, schemaText, decoderJson] = await Promise.all([
    fetch(`${base}/manifest.json`).then((r) => { if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`); return r.text(); }),
    fetch(`${base}/schema.json`).then((r) => (r.ok ? r.text() : undefined)),
    decoderUrl ? fetch(decoderUrl).then((r) => (r.ok ? r.json() : null)) : null,
  ]);
  engine?.free();
  decoder?.free();
  decoder = null;
  refused = decoderJson ? null : "this nest has no published config";
  chainId = null;
  const store = segmentStore(base);
  engine = new Nest(store.size, store.read, "", manifestText, schemaText);
  for (const text of views) engine.addViews(text);
  if (decoderJson) {
    try {
      decoder = new Decoder(decoderJson.config, JSON.stringify(decoderJson.abis));
      chainId = Number(decoderJson.config.match(/^\s*chain_id\s*=\s*(\d+)/m)?.[1]) || null;
    } catch (e) { refused = String(e?.message ?? e); }
  }
  const manifest = JSON.parse(manifestText);
  const segments = Object.values(manifest.tables).flat();
  const covered = JSON.parse(engine.covered());
  return {
    views: engine.views(),
    tables: engine.tables().length,
    segments: segments.length,
    rows: segments.reduce((s, x) => s + (x.rows ?? 0), 0),
    sealed_through: Math.max(0, ...Object.values(covered)),
    tail: decoder ? { chain_id: chainId } : { refused },
  };
}

/// Every log past the mirror's cut, from `rpc`, decoded and bound beside the segments. Replaces the
/// tail before it: nothing is kept between refreshes, so a reorg costs a refetch, not a wrong row.
async function tail({ rpc }) {
  if (!decoder) throw new Error(`no live tail: ${refused}`);
  // A failed refresh leaves no tail at all, so the page's "no live tail" is true of the rows too.
  try { return await fetchAndBind(rpc); } catch (e) { engine.setTail("{}"); throw e; }
}

async function fetchAndBind(rpc) {
  const t = performance.now();
  const reply = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }) })).json();
  const served = Number(BigInt(reply.result));
  if (chainId && served !== chainId) throw new Error(`that RPC serves chain ${served}; this nest is on chain ${chainId}`);
  const cut = Math.max(0, ...Object.values(JSON.parse(engine.covered())));
  const head = await headBlock(rpc);
  const from = cut - MARGIN + 1;
  if (head - from + 1 > MAX_TAIL) throw new Error(`the mirror ends ${(head - cut).toLocaleString()} blocks behind the head, more than a tab fetches (${MAX_TAIL.toLocaleString()})`);
  const got = await fetchTail({ rpc, decoder, from, to: head });
  const rows = engine.setTail(JSON.stringify(got.rows));
  return { from: cut + 1, to: head, rows, logs: got.logs, undecoded: got.undecoded, ms: performance.now() - t, host: new URL(rpc).host };
}

async function query({ sql }) {
  const before = { ...counts };
  const t = performance.now();
  const text = await engine.queryLines(sql);
  const ms = performance.now() - t;
  let chart = null;
  try { chart = prepare(text.split("\n").filter((l) => l.length)); }
  catch (e) { console.warn("no chart:", e); }
  return {
    text,
    chart,
    ms,
    fetched: counts.fetched - before.fetched,
    cached: counts.cached - before.cached,
    bytes: counts.bytes - before.bytes,
    reads: counts.reads - before.reads,
    read_ms: counts.read_ms - before.read_ms,
    mem_mib: (wasmMemory().buffer.byteLength / 2 ** 20) | 0,
  };
}

async function clearCache() {
  await (await navigator.storage.getDirectory()).removeEntry("segments", { recursive: true });
  opfs = undefined;
}

// The browser's own record of what this worker fetched, independent of the counts above.
const resources = () => performance.getEntriesByType("resource").map((e) => ({ url: e.name, bytes: e.transferSize, ms: Math.round(e.duration) }));

const handlers = { open, tail, query, clearCache, resources };
self.onmessage = async ({ data: { id, op, args } }) => {
  try { self.postMessage({ id, ok: await handlers[op](args) }); }
  catch (e) { self.postMessage({ id, err: String(e?.message ?? e) }); }
};
