// A nest in a tab: pick a published nest, run SQL over its sealed segments, here. The engine runs in
// a worker (worker.js), so the page stays responsive and Cancel can stop a statement outright.
import { draw, stat } from "./chart.js";
import { explainRefusal, ANSWER_MB } from "./budget.js";

const $ = (id) => document.getElementById(id);
const SHOWN = 500;

// The loading state's styles come with the script, so the site's page, which proxies it, gets them
// in the same deploy. The colours are the page's own variables.
document.head.append(Object.assign(document.createElement("style"), { textContent: `
  .pg-load { display: flex; flex-direction: column; gap: 6px; }
  .pg-track { position: relative; height: 3px; width: min(360px, 100%); border-radius: 2px; background: var(--line); overflow: hidden; }
  .pg-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 2px; background: var(--accent); transition: width 0.15s linear; }
  .pg-fill.pg-indef { width: 30%; animation: pg-slide 1.2s ease-in-out infinite; }
  @keyframes pg-slide { from { left: -30%; } to { left: 100%; } }
  .pg-skel { height: 1.7em; margin: 1px 0; border-radius: 5px; background: var(--code); animation: pg-pulse 1.4s ease-in-out infinite; }
  .pg-skel:nth-child(3n + 2) { width: 80%; } .pg-skel:nth-child(3n) { width: 62%; }
  .pg-none { color: var(--faint); font-size: 0.82rem; padding: 5px 8px; }
  @keyframes pg-pulse { 50% { opacity: 0.4; } }
  @media (prefers-reduced-motion: reduce) {
    .pg-fill, .pg-fill.pg-indef, .pg-skel { animation: none; transition: none; }
    .pg-fill.pg-indef { left: 0; width: 100%; opacity: 0.5; }
  }
` }));

const bar = {
  box: Object.assign(document.createElement("div"), { className: "pg-load" }),
  text: document.createElement("span"),
  track: Object.assign(document.createElement("div"), { className: "pg-track" }),
  fill: document.createElement("div"),
};
bar.track.append(bar.fill);
bar.box.append(bar.text, bar.track);
/// A stage of opening a nest: what is happening, and how far along it is when that is known.
function loading(text, frac = null) {
  if (bar.box.parentNode !== $("status")) $("status").replaceChildren(bar.box);
  $("status").classList.remove("err");
  bar.text.textContent = text;
  bar.fill.className = frac === null ? "pg-fill pg-indef" : "pg-fill";
  bar.fill.style.width = frac === null ? "" : `${(Math.min(1, frac) * 100).toFixed(1)}%`;
}
function skeleton() {
  $("views").setAttribute("aria-busy", "true");
  $("views").replaceChildren(...Array.from({ length: 8 }, () => Object.assign(document.createElement("div"), { className: "pg-skel" })));
  $("examples").replaceChildren();
  $("about").replaceChildren();
}

function status(s, err = false) { $("status").textContent = s; $("status").classList.toggle("err", err); }
const message = (e) => String(e?.message ?? e);

skeleton();
loading("loading the list of nests…");
const index = await fetch("./nests.json").then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .catch((e) => { status(`couldn't load the list of nests: ${message(e)}. Reload to try again.`, true); throw e; });

let worker;
let seq = 0;
const pending = new Map();
const mb = (n) => (n / 1e6).toFixed(1);
function stageText({ name, loaded, total, tables }) {
  const of = nest?.nest ?? "the nest";
  switch (name) {
    case "download": return [total ? `downloading the engine: ${mb(loaded)} of ${mb(total)} MB unpacked` : `downloading the engine: ${mb(loaded)} MB`, total ? loaded / total : null];
    case "compile": return ["compiling the engine…", null];
    case "engine": return [`engine ready; opening ${of}…`, null];
    case "manifest": return [`reading ${of}'s manifest from the mirror…`, null];
    case "seed": return [`fetching ${of}'s newest rows, ${tables} table tail${tables === 1 ? "" : "s"}, from the mirror…`, null];
    default: return null;
  }
}
function startWorker() {
  worker?.terminate();
  for (const { reject } of pending.values()) reject(new Error("cancelled"));
  pending.clear();
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  let alive = false;
  const fail = (why) => {
    if (w !== worker) return;
    w.terminate();
    const err = new Error(why);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    status(why, true);
  };
  // A module worker that fails to load reports only here, often with no message, and never replies.
  w.onerror = (e) => {
    e.preventDefault();
    const why = e.message || "its script failed to load, most likely a page and an engine from different deploys";
    fail(alive ? `the engine stopped: ${why}. Reload the page.` : `couldn't start the engine: ${why}. Reload, or clear this site's cache.`);
  };
  w.onmessageerror = () => fail("a reply from the engine could not be read. Reload the page.");
  w.onmessage = ({ data: { id, ok, err, stage } }) => {
    alive = true;
    if (stage) {
      const s = stageText(stage);
      if (s && w === worker) loading(...s);
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    err === undefined ? p.resolve(ok) : p.reject(new Error(err));
  };
  worker = w;
}
const call = (op, args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  worker.postMessage({ id, op, args });
});

const duration = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/// The statement that defines `view`, cut from the nest's view files for showing beside the list.
function viewSource(nest, view) {
  const esc = view.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${esc}"?\\s+AS\\b`, "i");
  for (const f of nest.views) {
    const m = head.exec(f.text);
    if (m) {
      const rest = f.text.slice(m.index);
      const next = rest.slice(1).search(/\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i);
      return { path: f.path, text: (next < 0 ? rest : rest.slice(0, next + 1)).trim() };
    }
    if (f.path.replace(/^views\/|\.sql$/g, "") === view) return { path: f.path, text: f.text.trim() };
  }
  return null;
}

let nest;
let opened;
async function openNest(i, then) {
  nest = index.nests[i];
  skeleton();
  loading(`starting the engine for ${nest.nest}…`);
  startWorker();
  opened = await call("open", { base: `${index.base}/${nest.dataset}`, views: nest.views.map((v) => v.text), decoder: nest.decoder && new URL(nest.decoder, location.href).href });
  $("views").removeAttribute("aria-busy");
  $("views").replaceChildren(...opened.views.map((v) => {
    const b = Object.assign(document.createElement("button"), { textContent: v, className: "view" });
    b.addEventListener("click", () => { $("sql").value = `SELECT * FROM "${v}"`; showSource(v); run(); });
    b.addEventListener("mouseenter", () => showSource(v));
    return b;
  }));
  if (!opened.views.length) $("views").replaceChildren(Object.assign(document.createElement("div"), { className: "pg-none", textContent: "this nest publishes no views" }));
  $("about").replaceChildren(
    `${opened.tables} tables, ${opened.segments.toLocaleString()} segments, ${opened.rows.toLocaleString()} rows sealed, dataset `,
    Object.assign(document.createElement("code"), { textContent: `${nest.dataset.slice(0, 12)}…` }),
    ", views from ",
    Object.assign(document.createElement("a"), { href: `${nest.repo}/tree/${nest.commit}/views`, textContent: nest.repo.replace("https://github.com/", ""), target: "_blank", rel: "noopener" }),
    ` at ${nest.commit.slice(0, 7)}`,
  );
  const examples = [
    ...opened.views.slice(0, 3).map((v) => `SELECT * FROM "${v}" LIMIT 100`),
    opened.views[0] ? `SELECT count(*) AS rows FROM "${opened.views[0]}"` : null,
  ].filter(Boolean);
  $("examples").replaceChildren(...examples.map((q) => {
    const b = Object.assign(document.createElement("button"), { textContent: q, className: "example" });
    b.addEventListener("click", () => { $("sql").value = q; run(); });
    return b;
  }));
  if (!opened.tail.refused) loading(`${nest.nest} is open; fetching the blocks past the mirror before the first query…`);
  await refreshTail();
  if (then) { $("sql").value = then; run(); }
  else {
    if (opened.views[0]) { $("sql").value = `SELECT * FROM "${opened.views[0]}"`; showSource(opened.views[0]); run(); }
    else status(`${nest.nest} ready.`);
  }
}

/// Opens a nest and, unless a later open has replaced it, says on the page why it did not.
let opening = 0;
function openShown(i, then) {
  const mine = ++opening;
  return openNest(i, then).catch((e) => {
    if (mine !== opening) return;
    status(`${nest?.nest ?? "the nest"} did not open: ${message(e)}`, true);
    $("views").removeAttribute("aria-busy");
    $("views").replaceChildren(Object.assign(document.createElement("div"), { className: "pg-none", textContent: "no views: the nest did not open" }));
  });
}

// RFC-0065 S3: the blocks past the mirror's cut, fetched from an RPC and decoded here. Only a page
// that can say so fetches it, since its rows are whatever that RPC answered.
const RPCS = { 1: "https://ethereum-rpc.publicnode.com", 42161: "https://arbitrum-one-rpc.publicnode.com" };
const ownRpc = (chain) => { try { return localStorage.getItem(`play.rpc.${chain}`) || null; } catch { return null; } };
// RFC-0065 S4: the second, independent RPC whose logs must match before the tab seals them.
const SECOND = { 1: "https://rpc.flashbots.net" };
function sealedHere(s) {
  const parts = [`Sealed through block ${s.mirror_through.toLocaleString()} on the mirror, with the nest's provisional tails.`];
  const v = s.verified;
  const fin = `block ${v.number.toLocaleString()}, the finalized block the light client verified through the beacon chain's sync committee`;
  parts.push(s.sealed_here
    ? `This tab sealed ${s.sealed_here} more segments through block ${s.sealed_through.toLocaleString()}, below ${fin}, on headers that hash down to it. Their logs are what ${s.host} and ${s.second} both returned, which is agreement, not proof.`
    : `Nothing past it reaches a cut yet below ${fin}, so this tab has sealed nothing.`);
  parts.push(`The light client holds ${v.mem_mib} MiB beside the engine's ${s.mem_mib} MiB.`);
  if (s.held) parts.push(`Held back: ${s.held}.`);
  if (s.check?.agreed || s.check?.differed) {
    parts.push(s.check.differed
      ? `${s.check.differed} of ${s.check.agreed + s.check.differed} segments sealed here earlier differ from the nest's, so they were discarded.`
      : `All ${s.check.agreed} segments sealed here earlier have since been published by the nest, with the same hashes.`);
  }
  return parts.join(" ");
}
async function refreshTail() {
  const box = $("tail-note");
  if (!box) return;
  const sealed = `Sealed through block ${opened.sealed_through.toLocaleString()} on the mirror.`;
  if (opened.tail.refused) { box.textContent = `${sealed} No live tail: ${opened.tail.refused}`; return; }
  const chain = opened.tail.chain_id;
  const rpc = ownRpc(chain) ?? RPCS[chain];
  if ($("rpc")) $("rpc").value = ownRpc(chain) ?? "";
  if (!rpc) { box.textContent = `${sealed} No public RPC is known for chain ${chain}: add your own for a live tail.`; return; }
  box.textContent = `${sealed} Fetching the live tail from ${new URL(rpc).host}…`;
  const second = SECOND[chain];
  let why = "";
  if (second && new URL(second).host !== new URL(rpc).host) {
    try {
      // The seal can wait a minute on header fetches; the rows are shown before it.
      const t = await call("tail", { rpc });
      box.textContent = `${sealed} Live tail to block ${t.to.toLocaleString()} from ${t.host}: ${t.rows.toLocaleString()} rows, not sealed and not verified. Checking what this tab can seal…`;
    } catch { /* the seal below fetches the tail again, and says why if it cannot */ }
    try {
      const s = await call("seal", { rpc, second });
      box.textContent = [sealedHere(s), `Live tail to block ${s.to.toLocaleString()}: ${s.rows.toLocaleString()} rows past it, not sealed and not verified.`].join(" ");
      return;
    } catch (e) {
      why = ` Not sealing in this tab: ${e?.message ?? e}.`;
    }
  }
  try {
    const t = await call("tail", { rpc });
    box.textContent = `${sealed}${why} Live tail to block ${t.to.toLocaleString()} from ${t.host}: ${t.rows.toLocaleString()} rows in ${duration(t.ms)}, not sealed and not verified, refetched on refresh.`;
  } catch (e) {
    box.textContent = `${sealed}${why} No live tail: ${e?.message ?? e}`;
  }
}

function showSource(view) {
  const src = viewSource(nest, view);
  $("source-name").textContent = src ? `${view}  (${src.path})` : view;
  $("source").textContent = src ? src.text : "defined in a view file this page could not match";
}

let lastLines = [];
let lastMore = false;
let running = false;
// The bench digests whole answers, so it alone runs a statement past the page's answer cap.
let whole = false;
async function run() {
  if (running) return;
  running = true;
  $("run").disabled = true;
  $("cancel").hidden = false;
  const sql = $("sql").value;
  const url = new URL(location.href);
  url.searchParams.set("nest", nest.nest);
  url.searchParams.set("q", sql);
  history.replaceState(null, "", url);
  const started = performance.now();
  const tick = setInterval(() => status(`running… ${duration(performance.now() - started)}`), 200);
  try {
    const r = await call("query", { sql, whole });
    lastLines = r.text.split("\n").filter((l) => l.length);
    lastMore = r.more;
    render(lastLines);
    showViz(r.chart);
    status(`${r.more ? `the first ${lastLines.length.toLocaleString()} rows (${ANSWER_MB} MB of answer, as much as this page holds; narrow it with WHERE or LIMIT for the rest)` : `${lastLines.length.toLocaleString()} rows`} in ${duration(r.ms)}`
      + ` · ${r.fetched} segments fetched and verified (${(r.bytes / 1e6).toFixed(1)} MB), ${r.cached} from this browser's cache`
      + ` · ${r.mem_mib} MiB of wasm memory`);
    window.__last = { sql, rows: lastLines.length, ...r, text: undefined, chart: r.chart?.kind };
  } catch (e) {
    showViz(null);
    status(explainRefusal(String(e?.message ?? e)), true);
    window.__last = { sql, error: String(e?.message ?? e) };
  } finally {
    clearInterval(tick);
    running = false;
    $("run").disabled = false;
    $("cancel").hidden = true;
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
  const of = `${lastMore ? "the first " : ""}${lines.length.toLocaleString()}`;
  $("more").textContent = lines.length > SHOWN ? `showing the first ${SHOWN} of ${of} rows; CSV has ${lastMore ? "those" : "them all"}` : "";
  $("csv").hidden = lines.length === 0;
}

let viz = null;
let tab = "chart";
function showViz(spec) {
  viz = spec;
  $("viz").hidden = !spec;
  if (!spec) { $("table-wrap").hidden = false; return; }
  $("ycol").hidden = spec.kind === "stat" || spec.ys.length < 2;
  if (spec.kind !== "stat") {
    $("ycol").replaceChildren(...spec.ys.map((c) => Object.assign(document.createElement("option"), { value: c, textContent: c, selected: c === spec.y })));
  }
  $("viz-note").textContent = spec.note ?? (spec.kind === "dots" ? "one dot per row" : "");
  setTab(tab);
}
function setTab(t) {
  tab = t;
  for (const [id, on] of [["tab-chart", t === "chart"], ["tab-table", t === "table"]]) {
    $(id).classList.toggle("on", on);
    $(id).setAttribute("aria-selected", on);
  }
  const chart = viz && t === "chart";
  for (const id of ["chart", "stats", "tip", "legend", "ycol", "viz-note"]) $(id).style.display = chart ? "" : "none";
  $("table-wrap").hidden = chart;
  $("more").hidden = chart;
  paint();
}
function tip(head, parts) {
  $("tip").replaceChildren(head, ...parts.map(([color, text]) => {
    const s = Object.assign(document.createElement("span"), { className: "key", textContent: text });
    s.style.setProperty("--k", color);
    return s;
  }));
}
function paint() {
  tip("", []);
  if (!viz || tab !== "chart") return;
  if (viz.kind === "stat") {
    $("chart").replaceChildren();
    $("legend").replaceChildren();
    stat($("stats"), viz.row);
    return;
  }
  $("stats").replaceChildren();
  const keys = draw($("chart"), viz, $("ycol").value, tip) ?? [];
  $("legend").replaceChildren(...(keys.length > 1 ? keys : []).map(([name, color]) => {
    const s = Object.assign(document.createElement("span"), { className: "key", textContent: name });
    s.style.setProperty("--k", color);
    return s;
  }));
}
$("tab-chart").addEventListener("click", () => setTab("chart"));
$("tab-table").addEventListener("click", () => setTab("table"));
$("ycol").addEventListener("change", paint);
let frame = 0;
new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint); }).observe($("viz"));

function csv() {
  const rows = lastLines.map((l) => JSON.parse(l));
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/csv" })),
    download: `${nest.nest}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

$("nest").replaceChildren(...index.nests.map((n, i) => Object.assign(document.createElement("option"), { value: i, textContent: n.nest })));
$("nest").addEventListener("change", (e) => openShown(+e.target.value));
$("run").addEventListener("click", run);
$("cancel").addEventListener("click", () => openShown(+$("nest").value));
$("csv").addEventListener("click", csv);
$("sql").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run(); });
$("tail-receipts")?.addEventListener("click", async () => {
  const box = $("tail-note"), was = box.textContent, chain = opened?.tail?.chain_id;
  const second = SECOND[chain];
  if (!second) { box.textContent = `${was} No second RPC is known for chain ${chain} to share the headers with.`; return; }
  box.textContent = `${was} Checking receipts…`;
  try {
    const r = await call("receipts", { second, count: 20 });
    const head = r.checked
      ? `${r.complete} of the ${r.checked} newest finalized tail blocks with rows are complete: their receipts hash to headers the light client verified, and the RPC returned every log in them that this nest indexes, unaltered, with none added.`
      : "No block of the tail with rows is finalized yet.";
    const bad = r.differ.map((d) => `Block ${d.block.toLocaleString()}: ${d.reason}.`).join(" ");
    box.textContent = [was, head, bad, `${(r.bytes / 1e6).toFixed(1)} MB of receipts in ${duration(r.ms)}; ${(r.of - r.checked).toLocaleString()} more finalized blocks with rows are not checked.`].filter(Boolean).join(" ");
  } catch (e) {
    box.textContent = `${was} Receipts not checked: ${e?.message ?? e}.`;
  }
});
$("tail-refresh")?.addEventListener("click", async () => {
  if (running) return;
  await refreshTail();
  run();
});
$("rpc")?.addEventListener("change", async (e) => {
  const chain = opened?.tail?.chain_id;
  if (!chain) return;
  const url = e.target.value.trim();
  if (url) {
    try { new URL(url); } catch { $("tail-note").textContent = "That is not a URL."; return; }
  }
  // The visitor's own endpoint may carry a key, so it stays in this browser and out of the address bar.
  try { url ? localStorage.setItem(`play.rpc.${chain}`, url) : localStorage.removeItem(`play.rpc.${chain}`); } catch { /* this visit only */ }
  if (running) return;
  await refreshTail();
  run();
});
$("clear").addEventListener("click", async () => {
  try { await call("clearCache"); status("cache cleared"); } catch { status("nothing cached"); }
});

/// The order-free digest examples/native.rs and bench/node.mjs print: rows sorted by their UTF-8
/// bytes, joined by newlines, the first 16 hex digits of the SHA-256.
async function digest(lines) {
  const enc = new TextEncoder();
  const rows = lines.map((l) => enc.encode(l));
  rows.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  });
  const total = rows.reduce((s, r) => s + r.length, 0) + Math.max(0, rows.length - 1);
  const buf = new Uint8Array(total);
  let at = 0;
  rows.forEach((r, i) => { if (i) buf[at++] = 10; buf.set(r, at); at += r.length; });
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// Every view of the open nest, one after another, for measuring: cold on an empty cache, then
/// again from this browser's cache in a fresh worker.
window.__resources = () => call("resources");

window.__bench = async () => {
  whole = true;
  const out = [];
  for (const pass of ["cold", "opfs"]) {
    if (pass === "cold") await call("clearCache").catch(() => {});
    await openNest(+$("nest").value);
    for (const v of opened.views) {
      $("sql").value = `SELECT * FROM "${v}"`;
      await run();
      out.push({ pass, view: v, ...window.__last, digest: await digest(lastLines) });
    }
  }
  whole = false;
  window.__benchResult = out;
  return out;
};

const params = new URLSearchParams(location.search);
let start = Math.max(0, index.nests.findIndex((n) => n.nest === (params.get("nest") ?? "defi-pulse-nest")));
$("nest").value = start;
openShown(start, params.get("q"));
