// A nest in a tab: pick a published nest, run SQL over its sealed segments, here. Each segment is
// fetched whole from the mirror, checked against the SHA-256 its key names, and kept in the
// origin-private file system, so a second visit fetches nothing it already verified.
import init, { Nest, wasmMemory } from "./pkg/burrmill_wasm.js";

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 16;
const SHOWN = 500;

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

/// Segments by key, `<table>/<sha256>.parquet`, verified before use.
function segmentStore(base, counts) {
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

const index = await (await fetch("./nests.json")).json();
await init();

let engine;
let counts;
async function openNest(i) {
  const n = index.nests[i];
  engine?.free();
  status(`opening ${n.nest}…`);
  const base = `${index.base}/${n.dataset}`;
  const [manifestText, schemaText] = await Promise.all([
    fetch(`${base}/manifest.json`).then((r) => { if (!r.ok) throw new Error(`manifest: HTTP ${r.status}`); return r.text(); }),
    fetch(`${base}/schema.json`).then((r) => (r.ok ? r.text() : undefined)),
  ]);
  counts = { fetched: 0, cached: 0, bytes: 0 };
  const store = segmentStore(base, counts);
  engine = new Nest(store.size, store.read, "", manifestText, schemaText);
  for (const v of n.views) engine.addViews(v.text);
  const manifest = JSON.parse(manifestText);
  const segments = Object.values(manifest.tables).flat().length;
  $("views").replaceChildren(...engine.views().map((v) => {
    const b = Object.assign(document.createElement("button"), { textContent: v, className: "view" });
    b.addEventListener("click", () => { $("sql").value = `SELECT * FROM "${v}" LIMIT 100`; run(); });
    return b;
  }));
  $("about").innerHTML = "";
  $("about").append(
    `${engine.tables().length} tables, ${segments.toLocaleString()} segments, dataset `,
    Object.assign(document.createElement("code"), { textContent: `${n.dataset.slice(0, 12)}…` }),
    ", views from ",
    Object.assign(document.createElement("a"), { href: `${n.repo}/tree/${n.commit}/views`, textContent: n.repo.replace("https://github.com/", ""), target: "_blank", rel: "noopener" }),
    ` at ${n.commit.slice(0, 7)}`,
  );
  const first = engine.views()[0];
  if (first) $("sql").value = `SELECT * FROM "${first}" LIMIT 100`;
  status(`${n.nest} ready`);
}

function status(s, err = false) { $("status").textContent = s; $("status").classList.toggle("err", err); }

let running = false;
async function run() {
  if (running || !engine) return;
  running = true;
  $("run").disabled = true;
  const before = { ...counts };
  status("running…");
  const t = performance.now();
  try {
    const text = await engine.queryLines($("sql").value);
    const ms = performance.now() - t;
    const lines = text.split("\n").filter((l) => l.length);
    render(lines);
    const fetched = counts.fetched - before.fetched, cached = counts.cached - before.cached;
    const mb = ((counts.bytes - before.bytes) / 1e6).toFixed(1);
    status(`${lines.length.toLocaleString()} rows in ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}`
      + ` · ${fetched} segments fetched and verified (${mb} MB), ${cached} from this browser's cache`
      + ` · ${(wasmMemory().buffer.byteLength / 2 ** 20) | 0} MiB of wasm memory`);
  } catch (e) {
    status(String(e?.message ?? e), true);
  } finally {
    running = false;
    $("run").disabled = false;
  }
}

function render(lines) {
  const rows = lines.slice(0, SHOWN).map((l) => JSON.parse(l));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = document.createElement("tr");
  for (const c of cols) head.appendChild(Object.assign(document.createElement("th"), { textContent: c }));
  const body = rows.map((r) => {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const v = r[c];
      tr.appendChild(Object.assign(document.createElement("td"), {
        textContent: v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v),
        className: typeof v === "number" ? "num" : v === null ? "null" : "",
      }));
    }
    return tr;
  });
  $("thead").replaceChildren(head);
  $("tbody").replaceChildren(...body);
  $("more").textContent = lines.length > SHOWN ? `showing the first ${SHOWN} of ${lines.length.toLocaleString()} rows` : "";
}

$("nest").replaceChildren(...index.nests.map((n, i) => Object.assign(document.createElement("option"), { value: i, textContent: n.nest })));
$("nest").addEventListener("change", (e) => openNest(+e.target.value).catch((err) => status(String(err?.message ?? err), true)));
$("run").addEventListener("click", run);
$("sql").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });
$("clear").addEventListener("click", async () => {
  try { await (await navigator.storage.getDirectory()).removeEntry("segments", { recursive: true }); opfs = undefined; status("cache cleared"); }
  catch { status("nothing cached"); }
});
const start = Math.max(0, index.nests.findIndex((n) => n.nest === "graph-allocations-nest"));
$("nest").value = start;
openNest(start).catch((err) => status(String(err?.message ?? err), true));
