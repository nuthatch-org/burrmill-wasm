// Both engines over every authored view of one published nest, in this tab, against the mirror.
// A run tags every URL with its own query string, which the mirror ignores and the HTTP cache does
// not, so a cold run is cold for both engines however often the page has been used.
import init, { Nest, encodeIpcLines } from "./pkg/burrmill_wasm.js";
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.33.1-dev57.0/+esm";
import { tableToIPC } from "https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm";
import { bindDdl, declaredColumns, viewStatements } from "./duckbind.js";

const CONCURRENCY = 16;
const $ = (id) => document.getElementById(id);
const log = (s) => ($("log").textContent = s);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

await init();
const index = await (await fetch("./nests.json")).json();

/// The digest examples/native.rs and the playground print: rows sorted by UTF-8 bytes, joined by
/// newlines, the first 16 hex digits of the SHA-256.
async function multiset(text) {
  const enc = new TextEncoder();
  const lines = text.split("\n").filter((l) => l.length).map((l) => enc.encode(l));
  lines.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  const all = new Uint8Array(lines.reduce((s, l) => s + l.length, 0) + Math.max(0, lines.length - 1));
  let at = 0;
  lines.forEach((l, i) => { if (i) all[at++] = 10; all.set(l, at); at += l.length; });
  return { rows: lines.length, digest: hex(await crypto.subtle.digest("SHA-256", all)).slice(0, 16) };
}

async function loadNest(n) {
  const base = `${index.base}/${n.dataset}`;
  const [manifestText, schemaText] = await Promise.all([
    fetch(`${base}/manifest.json`, { cache: "no-store" }).then((r) => r.text()),
    fetch(`${base}/schema.json`, { cache: "no-store" }).then((r) => (r.ok ? r.text() : undefined)),
  ]);
  return { ...n, base, manifestText, manifest: JSON.parse(manifestText), schemaText, viewTexts: n.views.map((v) => v.text) };
}

function segmentStore(base, bust) {
  const cache = new Map();
  const counts = { fetched: 0, bytes: 0 };
  let active = 0;
  const waiting = [];
  const slot = () => (active < CONCURRENCY ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => (waiting.length ? waiting.shift()() : active--);
  async function fetchVerified(key) {
    const want = /([0-9a-f]{64})\.parquet$/.exec(key)?.[1];
    await slot();
    try {
      const r = await fetch(`${base}/${key}${bust}`);
      if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (want && hex(await crypto.subtle.digest("SHA-256", bytes)) !== want) throw new Error(`${key}: content is not what its address names`);
      counts.fetched++; counts.bytes += bytes.length;
      return bytes;
    } finally { release(); }
  }
  const whole = (key) => { if (!cache.has(key)) cache.set(key, fetchVerified(key)); return cache.get(key); };
  return { counts, size: async (key) => (await whole(key)).length, read: async (key, o, n) => (await whole(key)).subarray(o, o + n) };
}

async function runOurs(nest, view, bust) {
  const store = segmentStore(nest.base, bust);
  const engine = new Nest(store.size, store.read, "", nest.manifestText, nest.schemaText);
  for (const t of nest.viewTexts) engine.addViews(t);
  const sql = `SELECT * FROM "${view}"`;
  try {
    let t = performance.now();
    const text = await engine.queryLines(sql);
    const cold = performance.now() - t;
    t = performance.now();
    await engine.queryLines(sql);
    const warm = performance.now() - t;
    return { cold, warm, ...store.counts, ...(await multiset(text)), ...(window.__keepText ? { text } : {}) };
  } finally { engine.free(); }
}

const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" }));

async function runDuck(nest, view, bust) {
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    // nuthatch ran DuckDB on UTC hosts; DuckDB-Wasm takes the browser's zone, which moves every day boundary.
    await conn.query("SET TimeZone = 'UTC'");
    const declared = declaredColumns(nest.schemaText ? JSON.parse(nest.schemaText) : null);
    // What nuthatch bound for a statement under DuckDB: the tables and views it reaches, by the same rule.
    const reacher = new Nest(async () => 0, async () => new Uint8Array(), "", nest.manifestText, nest.schemaText);
    for (const t of nest.viewTexts) reacher.addViews(t);
    const sql = `SELECT * FROM "${view}"`;
    const [tables, wanted] = reacher.reach(sql);
    reacher.free();
    let t = performance.now();
    for (const table of tables) {
      const urls = (nest.manifest.tables[table] ?? []).map((s) => `${nest.base}/${table}/${s.hash}.parquet${bust}`);
      const ddl = bindDdl(table, declared, urls);
      if (ddl) await conn.query(ddl);
    }
    for (const [n, stmt] of viewStatements(nest.viewTexts)) if (wanted.includes(n)) await conn.query(stmt);
    const result = await conn.query(sql);
    const cold = performance.now() - t;
    t = performance.now();
    await conn.query(sql);
    const warm = performance.now() - t;
    const text = encodeIpcLines(tableToIPC(result, "stream"));
    await conn.close();
    return { cold, warm, ...(await multiset(text)), ...(window.__keepText ? { text } : {}) };
  } finally { await db.terminate().catch(() => {}); worker.terminate(); }
}

const ms = (x) => (x == null ? "" : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(2)} s`);
function show(view, ours, duck) {
  const tr = document.createElement("tr");
  const cell = (text, cls = "") => Object.assign(document.createElement("td"), { textContent: text, className: cls });
  tr.append(cell(view), cell(ours.rows?.toLocaleString() ?? ""));
  if (ours.error) tr.append(Object.assign(cell(`Burrmill: ${ours.error}`, "err"), { colSpan: 2 }));
  else tr.append(cell(ms(ours.cold), duck.cold > ours.cold ? "win" : ""), cell(ms(ours.warm), duck.warm > ours.warm ? "win" : ""));
  if (duck.error) tr.append(Object.assign(cell(`DuckDB: ${duck.error}`, "err"), { colSpan: 2 }));
  else tr.append(cell(ms(duck.cold), ours.cold > duck.cold ? "win" : ""), cell(ms(duck.warm), ours.warm > duck.warm ? "win" : ""));
  const same = !ours.error && !duck.error && ours.digest === duck.digest;
  tr.append(cell(ours.error || duck.error ? "" : same ? "identical" : `differ (${ours.rows} vs ${duck.rows} rows)`, same ? "ok" : "bad"));
  $("results").appendChild(tr);
}

async function runAll() {
  $("go").disabled = true;
  $("results").replaceChildren();
  const nest = await loadNest(index.nests[+$("nest").value]);
  const reacher = new Nest(async () => 0, async () => new Uint8Array(), "", nest.manifestText, nest.schemaText);
  for (const t of nest.viewTexts) reacher.addViews(t);
  const views = reacher.views();
  reacher.free();
  const out = [];
  try {
    for (const view of views) {
      const bust = `?run=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      log(`${view}: Burrmill…`);
      const ours = await runOurs(nest, view, bust).catch((e) => ({ error: String(e?.message ?? e) }));
      log(`${view}: DuckDB-Wasm…`);
      const duck = await runDuck(nest, view, bust).catch((e) => ({ error: String(e?.message ?? e) }));
      show(view, ours, duck);
      out.push({ view, ours, duck });
    }
    log(`done: ${views.length} views, sealed through the manifest fetched at ${new Date().toISOString().slice(11, 19)} UTC`);
  } finally { $("go").disabled = false; }
  window.__compare = out;
  return out;
}

$("nest").replaceChildren(...index.nests.map((n, i) => Object.assign(document.createElement("option"), { value: i, textContent: n.nest })));
const wanted = new URLSearchParams(location.search).get("nest") ?? "defi-pulse-nest";
$("nest").value = Math.max(0, index.nests.findIndex((n) => n.nest === wanted));
$("go").addEventListener("click", runAll);
window.__runAll = runAll;
window.__one = async (view, keep = true) => { window.__keepText = keep; const nest = await loadNest(index.nests[+$("nest").value]); const bust = `?run=${Date.now()}`; return { ours: await runOurs(nest, view, bust), duck: await runDuck(nest, view, bust) }; };
log("ready");
