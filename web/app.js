// Both engines on one view of one nest, over HTTP. Ours fetches each segment whole, checks it
// against the SHA-256 its key names, and keeps it; DuckDB-Wasm is handed the same URLs and makes
// its own range requests. Each run is cold: a fresh engine and an empty cache.
import init, { Nest, encodeIpcLines, wasmMemory } from "/pkg/web/burrmill_wasm.js";
import * as duckdb from "/duckdb/duckdb-browser.mjs";
import { tableToIPC } from "apache-arrow";
import { bindDdl, declaredColumns, viewStatements } from "/duckbind.js";

const NESTS = ["alloc", "gns", "dips"];
const CONCURRENCY = 32;
const $ = (id) => document.getElementById(id);
const log = (s) => ($("log").textContent = s);
window.__results = [];

await init();

async function loadNest(name) {
  const base = `${location.origin}/data/${name}`;
  const [manifestText, schemaText, files] = await Promise.all([
    fetch(`${base}/manifest.json`).then((r) => r.text()),
    fetch(`${base}/schema.json`).then((r) => (r.ok ? r.text() : undefined)),
    fetch(`/_views/${name}`).then((r) => r.json()),
  ]);
  const viewTexts = await Promise.all(files.map((f) => fetch(`${base}/views/${f}`).then((r) => r.text())));
  return { name, base, manifestText, manifest: JSON.parse(manifestText), schemaText, viewTexts };
}

const stats = async (reset) => (await fetch(`/_stats${reset ? "?reset=1" : ""}`)).json();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/// Order-free: row lines sorted by UTF-8 bytes, joined by newlines, hashed. As the Node harnesses.
async function multiset(text) {
  const enc = new TextEncoder();
  const lines = text.split("\n").filter((l) => l.length).map((l) => enc.encode(l));
  lines.sort((a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  const total = lines.reduce((s, l) => s + l.length, 0) + Math.max(0, lines.length - 1);
  const all = new Uint8Array(total);
  let at = 0;
  lines.forEach((l, i) => { if (i) all[at++] = 10; all.set(l, at); at += l.length; });
  return { rows: lines.length, digest: hex(await crypto.subtle.digest("SHA-256", all)).slice(0, 16) };
}

/// The origin-private file system, keyed by content address. A segment never changes, so a copy
/// verified once is good for ever, and a second visit to the page fetches nothing.
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
  try {
    const w = await (await dir.getFileHandle(hash, { create: true })).createWritable();
    await w.write(bytes); await w.close();
  } catch { /* a full or refused store costs a refetch, nothing else */ }
}
export async function clearOpfs() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("segments", { recursive: true }).catch(() => {});
  opfs = undefined;
}

/// A store over HTTP: one request per segment, verified against its content address, kept. With
/// `persist`, kept in OPFS too, and read from there first.
function segmentStore(base, persist) {
  const cache = new Map();
  const counts = { verified: 0, from_opfs: 0 };
  let active = 0;
  const waiting = [];
  const slot = () => (active < CONCURRENCY ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => (waiting.length ? waiting.shift()() : active--);
  async function fetchVerified(key) {
    const want = /([0-9a-f]{64})\.parquet$/.exec(key)?.[1];
    if (persist && want) {
      const kept = await opfsGet(want);
      if (kept) { counts.from_opfs++; return kept; }
    }
    await slot();
    try {
      const r = await fetch(`${base}/${key}`);
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (want) {
        const got = hex(await crypto.subtle.digest("SHA-256", bytes));
        if (got !== want) throw new Error(`${key}: content is ${got}, not what its address names`);
        counts.verified++;
        if (persist) await opfsPut(want, bytes);
      }
      return bytes;
    } finally { release(); }
  }
  const whole = (key) => { if (!cache.has(key)) cache.set(key, fetchVerified(key)); return cache.get(key); };
  return {
    counts,
    size: async (key) => (await whole(key)).length,
    read: async (key, offset, length) => (await whole(key)).subarray(offset, offset + length),
  };
}

async function runOurs(nest, view, persist = false) {
  const store = segmentStore(nest.base, persist);
  const engine = new Nest(store.size, store.read, "", nest.manifestText, nest.schemaText);
  for (const t of nest.viewTexts) engine.addViews(t);
  const sql = `SELECT * FROM "${view}"`;
  await stats(true);
  let t = performance.now();
  const text = await engine.queryLines(sql);
  const cold = performance.now() - t;
  const net = await stats(true);
  t = performance.now();
  await engine.queryLines(sql);
  const warm = performance.now() - t;
  const warmNet = await stats(true);
  engine.free();
  return { engine: persist ? "burrmill-wasm+opfs" : "burrmill-wasm", view, cold, warm, net, warmNet,
    verified: store.counts.verified, from_opfs: store.counts.from_opfs,
    mem_mib: (wasmMemory().buffer.byteLength / 2 ** 20) | 0, ...(await multiset(text)) };
}

let duck;
async function duckInstance() {
  const worker = new Worker("/duckdb/duckdb-browser-eh.worker.js");
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate("/duckdb/duckdb-eh.wasm");
  return { db, worker };
}

async function runDuck(nest, view) {
  const { db, worker } = await duckInstance();
  const conn = await db.connect();
  const declared = declaredColumns(nest.schemaText ? JSON.parse(nest.schemaText) : null);
  const views = viewStatements(nest.viewTexts);
  // What nuthatch 4.0.2 bound for the statement: the tables and views it reaches, by the same rule.
  const reacher = new Nest(async () => 0, async () => new Uint8Array(), "", nest.manifestText, nest.schemaText);
  for (const t of nest.viewTexts) reacher.addViews(t);
  const sql = `SELECT * FROM "${view}"`;
  const [tables, wanted] = reacher.reach(sql);
  reacher.free();
  await stats(true);
  let t = performance.now();
  for (const table of tables) {
    const urls = (nest.manifest.tables[table] ?? []).map((s) => `${nest.base}/${table}/${s.hash}.parquet`);
    const ddl = bindDdl(table, declared, urls);
    if (ddl) await conn.query(ddl);
  }
  for (const [n, stmt] of views) if (wanted.includes(n)) await conn.query(stmt);
  const result = await conn.query(sql);
  const cold = performance.now() - t;
  const net = await stats(true);
  t = performance.now();
  await conn.query(sql);
  const warm = performance.now() - t;
  const warmNet = await stats(true);
  const text = encodeIpcLines(tableToIPC(result, "stream"));
  await conn.close(); await db.terminate(); worker.terminate();
  return { engine: "duckdb-wasm", view, cold, warm, net, warmNet, verified: 0, ...(await multiset(text)) };
}

function show(r) {
  window.__results.push(r);
  const tr = document.createElement("tr");
  const cells = r.error
    ? [r.engine, r.view, { err: r.error }]
    : [r.engine, r.view, r.rows.toLocaleString(), Math.round(r.cold), Math.round(r.warm),
       r.net.data_requests.toLocaleString(), (r.net.data_bytes / 1e6).toFixed(1), r.verified.toLocaleString(), r.digest];
  for (const c of cells) {
    const td = document.createElement("td");
    if (c && c.err) { td.className = "err"; td.colSpan = 7; td.textContent = c.err; } else td.textContent = c;
    tr.appendChild(td);
  }
  $("results").appendChild(tr);
}

let current;
async function selectNest(name) {
  log(`loading ${name}…`);
  current = await loadNest(name);
  const reacher = new Nest(async () => 0, async () => new Uint8Array(), "", current.manifestText, current.schemaText);
  for (const t of current.viewTexts) reacher.addViews(t);
  $("view").replaceChildren(...reacher.views().map((v) => Object.assign(document.createElement("option"), { value: v, textContent: v })));
  reacher.free();
  log(`${name}: ${Object.values(current.manifest.tables).flat().length} segments`);
}

async function run(which) {
  const view = $("view").value;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    for (const [name, fn] of which) {
      log(`${name}: ${view}…`);
      try { show(await fn(current, view)); } catch (e) { show({ engine: name, view, error: String(e?.message ?? e) }); }
    }
    log("done");
  } finally {
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  }
}

$("nest").replaceChildren(...NESTS.map((n) => Object.assign(document.createElement("option"), { value: n, textContent: n })));
$("nest").addEventListener("change", (e) => selectNest(e.target.value));
$("ours").addEventListener("click", () => run([["burrmill-wasm", runOurs]]));
$("duck").addEventListener("click", () => run([["duckdb-wasm", runDuck]]));
$("both").addEventListener("click", () => run([["burrmill-wasm", runOurs], ["duckdb-wasm", runDuck]]));
window.__clearOpfs = clearOpfs;
window.__run = async (nest, view, engines = ["burrmill-wasm", "duckdb-wasm"]) => {
  if (current?.name !== nest) { $("nest").value = nest; await selectNest(nest); }
  $("view").value = view;
  const fns = { "burrmill-wasm": runOurs, "burrmill-wasm+opfs": (n, v) => runOurs(n, v, true), "duckdb-wasm": runDuck };
  await run(engines.map((e) => [e, fns[e]]));
  return window.__results.slice(-engines.length);
};
await selectNest(NESTS[0]);
