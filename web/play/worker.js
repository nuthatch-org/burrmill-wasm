// The engine and its segment store, off the page's thread: a heavy view no longer freezes the tab,
// and terminating this worker is how a query is cancelled. Each segment is fetched whole, checked
// against the SHA-256 its key names, and kept in the origin-private file system.
import init, { Nest, Decoder, Sealer, wasmMemory, verifyChain, verifyReceipts } from "./pkg/burrmill_wasm.js";
import { prepare } from "./chart.js";
import { fetchTail, headBlock, MARGIN } from "./tail.js";
import { agreedLogs } from "./finality.js";
import { verifiedFinalized, verifiedCeiling, checkReceipts } from "./verified.js";
import { budgetMiB, ANSWER_MB } from "./budget.js";
import { cutCatalogue, cutsOf, pinDigest } from "./postcard.js";

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
    const mine = local.get(want);
    if (mine) return mine;
    const kept = await opfsGet(want);
    if (kept) { counts.cached++; return kept; }
    await acquire();
    try {
      // A cold CDN drops the odd fetch under load (RFC-0068 §14), so a failed one is tried once more.
      const get = async () => { const r = await fetch(`${base}/${key}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
      let bytes;
      try { bytes = await get(); }
      catch { try { bytes = await get(); } catch (e) { throw new Error(`segment ${key} from ${new URL(base).host} did not arrive: ${e?.message ?? e}`); } }
      const got = hex(await crypto.subtle.digest("SHA-256", bytes));
      if (got !== want) throw new Error(`refused segment ${key} from ${new URL(base).host}: its bytes hash to ${got.slice(0, 12)}…, not the address it is stored under`);
      counts.fetched++;
      counts.bytes += bytes.length;
      await opfsPut(want, bytes);
      return bytes;
    } finally { release(); }
  }
  // A failure is not kept, so the next statement that reaches the segment fetches it again.
  const whole = (key) => {
    if (!cache.has(key)) {
      const p = fetchVerified(key);
      cache.set(key, p);
      p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
    }
    return cache.get(key);
  };
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

// Stamped by scripts/build-play.sh with the unpacked size of the module, which the progress counts.
const ENGINE_BYTES = 0;
const stage = (s) => self.postMessage({ stage: s });
stage({ name: "download", loaded: 0, total: ENGINE_BYTES });

/// The module, streamed so the page can show how much of it has arrived. The compile runs alongside.
async function fetchModule() {
  const r = await fetch(new URL("./pkg/burrmill_wasm_bg.wasm", import.meta.url));
  if (!r.ok) return r;
  const encoded = r.headers.get("content-encoding");
  const total = ENGINE_BYTES || (encoded ? 0 : Number(r.headers.get("content-length")) || 0);
  let loaded = 0, last = 0;
  const counted = r.body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      loaded += chunk.length;
      const now = performance.now();
      if (now - last > 100) { last = now; stage({ name: "download", loaded, total }); }
      out.enqueue(chunk);
    },
    flush() { stage({ name: "compile", loaded, total }); },
  }));
  return new Response(counted, { status: r.status, headers: { "content-type": "application/wasm" } });
}
const ready = init({ module_or_path: fetchModule() }).then(
  (m) => { stage({ name: "engine" }); return m; },
  (e) => { throw new Error(`the engine did not load: ${e?.message ?? e}`); },
);
let engine;

// The live tail's decoder for the open nest, or why there is none.
let decoder = null;
let refused = null;
let chainId = null;
// Past this, the mirror is too far behind for a public RPC to fill the gap in a tab.
const MAX_TAIL = 50_000;

async function open({ base, views, decoder: decoderUrl, pin }) {
  await ready;
  stage({ name: "manifest" });
  if (pin) return openPinned({ base, views, pin });
  const [manifestText, schemaText, decoderJson, seed] = await Promise.all([
    fetch(`${base}/manifest.json`, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`); return r.text(); }),
    fetch(`${base}/schema.json`).then((r) => (r.ok ? r.text() : undefined)),
    decoderUrl ? fetch(decoderUrl).then((r) => (r.ok ? r.json() : null)) : null,
    fetch(`${base}/_seed/seed.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  decoder?.free();
  decoder = null;
  refused = decoderJson ? null : "this nest has no published config";
  chainId = null;
  sealing = null;
  cur = { base, views, manifestText, schemaText, store: segmentStore(base), seed: null };
  // A nest whose tables are all under the seal floor has every row in the seed's tails and nothing
  // in the catalogue, so the tails are part of what the mirror publishes, not only a place to resume.
  if (seed && seed.catalogue_sha256 === (await sha(manifestText))) {
    stage({ name: "seed", tables: Object.keys(seed.tails).length });
    try {
      for (const [t, s] of Object.entries(seed.tails)) await bytesOf(s.hash, `${base}/_seed/${t}.tail`);
      cur.seed = seed;
    } catch (e) { console.warn("seed tails unavailable:", e); }
  }
  bind();
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
    rows: segments.reduce((s, x) => s + (x.rows ?? 0), 0) + Object.values(cur.seed?.tails ?? {}).reduce((s, x) => s + (x.rows ?? 0), 0),
    sealed_through: Math.max(0, cur.seed?.complete_through ?? 0, ...Object.values(covered)),
    tail: decoder ? { chain_id: chainId } : { refused },
  };
}

/// A postcard (RFC-0068): the host's catalogue cut where the link says, checked against the link's
/// digest before anything is bound, with no seed tails and no live tail.
async function openPinned({ base, views, pin }) {
  const host = new URL(base).host;
  const [manifestText, schemaBytes, published] = await Promise.all([
    fetch(`${base}/manifest.json`, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`${host} answered HTTP ${r.status} for the nest's catalogue`); return r.text(); }),
    fetch(`${base}/schema.json`, { cache: "no-cache" }).then(async (r) => { if (!r.ok) throw new Error(`${host} answered HTTP ${r.status} for schema.json, which the postcard pins`); return new Uint8Array(await r.arrayBuffer()); }),
    fetch(`${base}/publish.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const cut = cutCatalogue(JSON.parse(manifestText), pin.cuts);
  if (cut.behind.length) return { pin: { state: "behind", host, tables: cut.behind } };
  if (cut.moved.length) return { pin: { state: "moved", host, tables: cut.moved } };
  const digest = await pinDigest(schemaBytes, cut.manifest.tables);
  if (digest !== pin.digest) return { pin: { state: "differs", host, digest } };
  decoder?.free();
  decoder = null;
  refused = "a postcard shows what the nest had sealed when the link was made";
  chainId = null;
  sealing = null;
  cur = { base, views, manifestText: JSON.stringify(cut.manifest), schemaText: new TextDecoder().decode(schemaBytes), store: segmentStore(base), seed: null, pin: { cuts: pin.cuts, digest } };
  bind();
  const segments = Object.values(cut.manifest.tables).flat();
  return {
    views: engine.views(),
    tables: engine.tables().length,
    segments: segments.length,
    rows: segments.reduce((s, x) => s + (x.rows ?? 0), 0),
    sealed_through: Math.max(0, ...Object.values(pin.cuts)),
    tail: { refused },
    pin: { state: "open", host, digest, chain_id: published?.chain_id ?? null },
  };
}

/// The cut and digest a postcard of what is open would carry: the link's own when it is one, else the
/// sealed catalogue as the host published it, without the seed's tails or anything sealed here.
async function pinOf() {
  if (cur.pin) return { ...cur.pin, through: Math.max(0, ...Object.values(cur.pin.cuts)) };
  const schema = await fetch(`${cur.base}/schema.json`, { cache: "no-cache" }).then(async (r) => { if (!r.ok) throw new Error(`schema.json: HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); });
  if (new TextDecoder().decode(schema) !== cur.schemaText) throw new Error("the host's schema.json changed since this page opened the nest; reload to make a postcard");
  const manifest = JSON.parse(cur.manifestText);
  const cuts = cutsOf(manifest);
  return { cuts, digest: await pinDigest(schema, cutCatalogue(manifest, cuts).manifest.tables), through: Math.max(0, ...Object.values(cuts)) };
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
  const cut = Math.max(0, cur.seed?.complete_through ?? 0, ...Object.values(JSON.parse(engine.covered())));
  const head = await headBlock(rpc);
  const from = cut - MARGIN + 1;
  if (head - from + 1 > MAX_TAIL) throw new Error(`the mirror ends ${(head - cut).toLocaleString()} blocks behind the head, more than a tab fetches (${MAX_TAIL.toLocaleString()})`);
  const got = await fetchTail({ rpc, decoder, from, to: head });
  const rows = engine.setTail(JSON.stringify(got.rows));
  lastTail = { rpc, raw: got.raw };
  return { from: cut + 1, to: head, rows, logs: got.logs, undecoded: got.undecoded, ms: performance.now() - t, host: new URL(rpc).host };
}

// RFC-0065 S4: sealing in the tab. The open nest, kept so the engine can be bound again over what
// this tab has sealed, and the sealer resumed from the mirror's seed snapshot.
let cur = null;
let sealing = null;
/// Segment bytes sealed here or taken from the seed snapshot, by hash.
const local = new Map();
/// Blocks a held range may span before it is cut: nuthatch's per-chain `seal_span` (src/chains.rs).
const SEAL_SPAN = { 1: 1800 };

const sha = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const stateName = () => `${cur.base.split("/").pop()}.json`;

/// The engine over the mirror's catalogue, the seed snapshot's tails and every segment sealed here.
function bind() {
  const m = JSON.parse(cur.manifestText);
  const add = (s) => (m.tables[s.table] ??= []).push({ hash: s.hash, from_block: s.from_block, to_block: s.to_block, rows: s.rows });
  if (!sealing && cur.seed) for (const [t, s] of Object.entries(cur.seed.tails)) add({ ...s, table: t });
  if (sealing) {
    for (const s of sealing.finals) add(s);
    for (const s of Object.values(sealing.tails)) add(s);
  }
  engine?.free();
  engine = new Nest(cur.store.size, cur.store.read, "", JSON.stringify(m), cur.schemaText, budgetMiB());
  for (const text of cur.views) engine.addViews(text);
}

async function tabDir() {
  try { return await (await navigator.storage.getDirectory()).getDirectoryHandle("sealed", { create: true }); }
  catch { return null; }
}
async function loadState() {
  try { return JSON.parse(await (await (await (await tabDir()).getFileHandle(stateName())).getFile()).text()); }
  catch { return null; }
}
async function saveState() {
  const dir = await tabDir();
  if (!dir) return;
  const { sealer, ...kept } = sealing;
  try { const w = await (await dir.getFileHandle(stateName(), { create: true })).createWritable(); await w.write(JSON.stringify({ ...kept, watermark: sealer.watermark() })); await w.close(); }
  catch { /* a refused store only costs sealing again after a discard */ }
}
async function bytesOf(hash, url) {
  const kept = local.get(hash) ?? (await opfsGet(hash)) ?? (url ? new Uint8Array(await (await fetch(url, { cache: "no-cache" })).arrayBuffer()) : null);
  if (!kept) throw new Error(`segment ${hash.slice(0, 12)}… is no longer in this browser`);
  if (hex(await crypto.subtle.digest("SHA-256", kept)) !== hash) throw new Error(`${url}: content is not ${hash.slice(0, 12)}…`);
  local.set(hash, kept);
  return kept;
}

/// Resume from what this tab sealed before, if the mirror has not overtaken it and agrees with every
/// segment both have, else from the mirror's seed snapshot. Answers how the comparison went.
async function startSealing() {
  if (sealing) return null;
  const span = SEAL_SPAN[chainId];
  if (!span) throw new Error(`the tab does not know chain ${chainId}'s seal span`);
  const seed = await fetch(`${cur.base}/_seed/seed.json`, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null));
  if (!seed) throw new Error("the mirror has no seed snapshot to resume sealing from");
  if (seed.catalogue_sha256 !== (await sha(cur.manifestText))) throw new Error("the mirror changed while this page opened it; reload to seal");
  const published = new Set(Object.entries(JSON.parse(cur.manifestText).tables).flatMap(([t, ss]) => ss.map((s) => `${t} ${s.hash}`)));
  for (const [t, s] of Object.entries(seed.tails)) published.add(`${t} ${s.hash}`);

  const kept = await loadState();
  const check = { agreed: 0, differed: 0 };
  let resume = kept && kept.chain_id === chainId && kept.watermark > seed.complete_through;
  for (const s of kept?.finals ?? []) {
    if (s.to_block > seed.complete_through) continue;
    if (published.has(`${s.table} ${s.hash}`)) check.agreed++;
    else { check.differed++; console.warn("sealed here, not on the mirror:", s); }
  }
  // A segment straddling the mirror's watermark was cut where the nest did not cut.
  if (check.differed || (kept?.finals ?? []).some((s) => s.from_block <= seed.complete_through && s.to_block > seed.complete_through)) resume = false;

  if (resume) {
    const finals = kept.finals.filter((s) => s.to_block > seed.complete_through);
    try { for (const s of [...finals, ...Object.values(kept.tails)]) await bytesOf(s.hash, null); }
    catch { resume = false; }
    if (resume) sealing = { chain_id: chainId, sealer: new Sealer(kept.watermark, span), finals, tails: kept.tails };
  }
  if (!resume) {
    sealing = { chain_id: chainId, sealer: new Sealer(seed.complete_through, span), finals: [], tails: {} };
    for (const [t, s] of Object.entries(seed.tails)) sealing.tails[t] = { ...s, table: t };
  }
  sealing.mirror_through = seed.complete_through;
  for (const [t, s] of Object.entries(sealing.tails)) {
    const bytes = await bytesOf(s.hash, `${cur.base}/_seed/${t}.tail`);
    sealing.sealer.addTail(t, s.from_block, s.to_block, bytes, s.hash);
  }
  return check;
}

// Helios is 4.5 MB, so it loads on the first seal, not with the page. Its linear memory is caught as it
// is instantiated, for the page to say what the light client holds beside the engine.
let helios = null;
async function lightClient() {
  if (helios) return helios;
  const { createHeliosProvider } = await import("./helios/lib.mjs");
  const shipped = await (await fetch("./checkpoint.json", { cache: "no-cache" })).json();
  const memories = [];
  const create = async (...args) => {
    const kept = { instantiate: WebAssembly.instantiate, instantiateStreaming: WebAssembly.instantiateStreaming };
    for (const [k, f] of Object.entries(kept)) {
      WebAssembly[k] = async (...a) => {
        const r = await f.apply(WebAssembly, a);
        const m = (r.instance ?? r).exports?.memory;
        if (m instanceof WebAssembly.Memory) memories.push(m);
        return r;
      };
    }
    try { return await createHeliosProvider(...args); }
    finally { Object.assign(WebAssembly, kept); }
  };
  helios = { create, shipped, memories };
  return helios;
}
const checkpointFile = async (create) => (await navigator.storage.getDirectory()).getFileHandle(`helios-${chainId}.json`, { create });
async function loadCheckpoint() {
  try { return JSON.parse(await (await (await checkpointFile(false)).getFile()).text()); }
  catch { return null; }
}
async function saveCheckpoint(c) {
  try { const w = await (await checkpointFile(true)).createWritable(); await w.write(JSON.stringify(c)); await w.close(); }
  catch { /* a refused store only costs a longer sync next time */ }
}

/// Fetch past this tab's last seal from `rpc`, seal what the light client verified is final and
/// `second` returns the same logs for, and bind the rest as the unsealed tail.
async function seal({ rpc, second }) {
  if (!decoder) throw new Error(`no live tail: ${refused}`);
  const t = performance.now();
  for (const url of [rpc, second]) {
    const reply = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }) })).json();
    const served = Number(BigInt(reply.result));
    if (served !== chainId) throw new Error(`${new URL(url).host} serves chain ${served}; this nest is on chain ${chainId}`);
  }
  const check = await startSealing();
  const mirrorThrough = sealing.mirror_through;
  const { sealer } = sealing;
  const floor = sealer.watermark();
  const head = await headBlock(rpc);
  if (head - floor > MAX_TAIL) throw new Error(`this tab's last seal is ${(head - floor).toLocaleString()} blocks behind the head, more than a tab fetches (${MAX_TAIL.toLocaleString()})`);
  const got = await fetchTail({ rpc, decoder, from: floor + 1, to: head });
  lastTail = { rpc, raw: got.raw };
  sealer.clear();
  sealer.push(JSON.stringify(got.rows));
  const lc = await lightClient();
  const top = await verifiedFinalized({ create: lc.create, chainId, rpc, shipped: lc.shipped, load: loadCheckpoint, save: saveCheckpoint });
  let agreed = { ceiling: floor, reason: null };
  // The headers cost about 15 KB a block, so they are fetched only when a seal would follow.
  if (sealer.reach(Math.min(top.number, head)) > 0) {
    const v = await verifiedCeiling({ rpc, sources: [rpc, second], top, floor, logs: got.raw, verifyChain });
    const l = await agreedLogs({ b: second, logs: got.raw, times: got.times, filter: JSON.parse(decoder.filter()), floor, ceiling: v.ceiling });
    agreed = { ceiling: l.ceiling, reason: l.reason ?? v.reason };
  }
  const out = JSON.parse(sealer.seal(agreed.ceiling));
  for (const [i, s] of out.entries()) {
    const bytes = sealer.bytes(i);
    local.set(s.hash, bytes);
    await opfsPut(s.hash, bytes);
    delete sealing.tails[s.table];
    if (s.provisional) sealing.tails[s.table] = s;
    else sealing.finals.push(s);
  }
  await saveState();
  bind();
  const rows = engine.setTail(JSON.stringify(got.rows));
  return {
    mirror_through: mirrorThrough, sealed_through: sealer.watermark(), sealed_now: out.filter((s) => !s.provisional).length, sealed_here: sealing.finals.length,
    held: agreed.reason, to: head, rows, logs: got.logs, ms: performance.now() - t,
    host: new URL(rpc).host, second: new URL(second).host, check,
    verified: { number: top.number, consensus: top.consensus, sync_ms: top.sync_ms, mem_mib: lc.memories.reduce((a, m) => a + m.buffer.byteLength, 0) / 2 ** 20 | 0 },
    mem_mib: (wasmMemory().buffer.byteLength / 2 ** 20) | 0,
  };
}

/// The tail's logs as last fetched, for checking against receipts on request.
let lastTail = null;

/// The newest `count` blocks of the tail that have rows and are finalized, each checked against its
/// receipts (RFC-0065 §6): about 1 MB a block, which is why the page asks first.
async function receipts({ second, count }) {
  if (!lastTail) throw new Error("no live tail to check yet");
  const { rpc, raw } = lastTail;
  const lc = await lightClient();
  const top = await verifiedFinalized({ create: lc.create, chainId, rpc, shipped: lc.shipped, load: loadCheckpoint, save: saveCheckpoint });
  const withRows = [...new Set(raw.map((l) => Number(BigInt(l.blockNumber))))].filter((n) => n <= top.number).sort((a, b) => b - a);
  const t = performance.now();
  const out = await checkReceipts({ rpc, sources: [rpc, second], top, blocks: withRows.slice(0, count), logs: raw, filter: JSON.parse(decoder.filter()), verifyChain, verifyReceipts });
  return { ...out, finalized: top.number, of: withRows.length, ms: performance.now() - t, host: new URL(rpc).host };
}

async function query({ sql, whole }) {
  const before = { ...counts };
  const t = performance.now();
  let answer;
  try { answer = whole ? { text: await engine.queryLines(sql), more: false } : await engine.queryUpTo(sql, ANSWER_MB * 1e6); }
  catch (e) {
    // The engine wraps the store's error in its own; the page says the store's, which names the segment.
    const m = /(refused segment [^\n]*|segment [^\n]* did not arrive[^\n]*)/.exec(String(e?.message ?? e));
    throw m ? new Error(m[1]) : e;
  }
  const { text, more } = answer;
  const ms = performance.now() - t;
  let chart = null;
  try { chart = prepare(text.split("\n").filter((l) => l.length)); }
  catch (e) { console.warn("no chart:", e); }
  return {
    text,
    more,
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

const handlers = { open, pin: pinOf, tail, receipts, seal: (a) => seal(a).catch((e) => { engine.setTail("{}"); throw e; }), query, clearCache, resources };
self.onmessage = async ({ data: { id, op, args } }) => {
  try { self.postMessage({ id, ok: await handlers[op](args) }); }
  catch (e) { self.postMessage({ id, err: String(e?.message ?? e) }); }
};
