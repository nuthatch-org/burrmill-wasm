// The engine and its segment store, off the page's thread: a heavy view no longer freezes the tab,
// and terminating this worker is how a query is cancelled. Each segment is fetched whole, checked
// against the SHA-256 its key names, and kept in the origin-private file system.
import init, { Nest, wasmMemory } from "./pkg/burrmill_wasm.js";

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

const counts = { fetched: 0, cached: 0, bytes: 0 };
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
  return {
    size: async (key) => (await whole(key)).length,
    read: async (key, offset, length) => (await whole(key)).subarray(offset, offset + length),
  };
}

const ready = init();
let engine;

async function open({ base, views }) {
  await ready;
  const [manifestText, schemaText] = await Promise.all([
    fetch(`${base}/manifest.json`).then((r) => { if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`); return r.text(); }),
    fetch(`${base}/schema.json`).then((r) => (r.ok ? r.text() : undefined)),
  ]);
  engine?.free();
  const store = segmentStore(base);
  engine = new Nest(store.size, store.read, "", manifestText, schemaText);
  for (const text of views) engine.addViews(text);
  const manifest = JSON.parse(manifestText);
  const segments = Object.values(manifest.tables).flat();
  return {
    views: engine.views(),
    tables: engine.tables().length,
    segments: segments.length,
    rows: segments.reduce((s, x) => s + (x.rows ?? 0), 0),
  };
}

async function query({ sql }) {
  const before = { ...counts };
  const t = performance.now();
  const text = await engine.queryLines(sql);
  return {
    text,
    ms: performance.now() - t,
    fetched: counts.fetched - before.fetched,
    cached: counts.cached - before.cached,
    bytes: counts.bytes - before.bytes,
    mem_mib: (wasmMemory().buffer.byteLength / 2 ** 20) | 0,
  };
}

async function clearCache() {
  await (await navigator.storage.getDirectory()).removeEntry("segments", { recursive: true });
  opfs = undefined;
}

const handlers = { open, query, clearCache };
self.onmessage = async ({ data: { id, op, args } }) => {
  try { self.postMessage({ id, ok: await handlers[op](args) }); }
  catch (e) { self.postMessage({ id, err: String(e?.message ?? e) }); }
};
