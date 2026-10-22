// A nest in a tab: pick a published nest, run SQL over its sealed segments, here. The engine runs in
// a worker (worker.js), so the page stays responsive and Cancel can stop a statement outright.
import { draw, stat } from "./chart.js";
import { explainRefusal, ANSWER_MB } from "./budget.js";
import { parseFragment, formatFragment, deflate, unfold } from "./postcard.js";
import { CHAINS } from "./chains.js";

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
  .pg-cuts { margin-top: 4px; } .pg-cuts summary { cursor: pointer; }
  .pg-cuts ul { margin: 4px 0; padding-left: 18px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
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
// What is open and whether it opened, for the scripted gates that drive this page.
const postcard = { state: "opening", message: "" };
window.__postcard = postcard;

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
    case "manifest": return [`reading ${of}'s manifest from ${nest?.base ? host(nest.base) : "the mirror"}…`, null];
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

// What the address bar's fragment names: a curated nest, a published directory, or a postcard pinning
// one. The fragment stays in the browser, so the query in it never reaches a server.
let link;
const host = (base) => new URL(base).host;

/// The nest `link` names, with the views it runs over: the link's own when it carries them.
async function sourceOf(l) {
  if (l.kind === "nest") {
    const n = index.nests.find((x) => x.nest === l.nest) ?? index.nests.find((x) => x.nest === "defi-pulse-nest") ?? index.nests[0];
    return { ...n, base: `${index.base}/${n.dataset}` };
  }
  const base = `${l.m ?? index.base}/${l.d}`;
  const curated = l.m ? null : index.nests.find((x) => x.dataset === l.d);
  const views = l.w ? [{ path: "the link", text: await unfold(l.w, base) }] : [];
  return { nest: curated?.nest ?? `${l.d.slice(0, 12)}… on ${host(base)}`, dataset: l.d, base, views, pin: l.kind === "postcard" ? { cuts: l.c, digest: l.h } : null };
}

let nest;
let opened;
async function openNest(l, autorun = true) {
  link = l;
  nest = { nest: l.kind === "nest" ? l.nest ?? "the nest" : "the postcard", views: [] };
  skeleton();
  pinShown(null);
  pickerShows(l);
  loading("reading the link…");
  nest = await sourceOf(l);
  const then = await unfold(l.q, nest.base);
  loading(`starting the engine for ${nest.nest}…`);
  startWorker();
  opened = await call("open", { base: nest.base, views: nest.views.map((v) => v.text), decoder: !nest.pin && nest.decoder ? new URL(nest.decoder, location.href).href : undefined, pin: nest.pin });
  if (opened.pin && opened.pin.state !== "open") return refusePin(opened.pin);
  $("views").removeAttribute("aria-busy");
  $("views").replaceChildren(...opened.views.map((v) => {
    const b = Object.assign(document.createElement("button"), { textContent: v, className: "view" });
    b.addEventListener("click", () => { $("sql").value = `SELECT * FROM "${v}"`; showSource(v); run(); });
    b.addEventListener("mouseenter", () => showSource(v));
    return b;
  }));
  if (!opened.views.length) $("views").replaceChildren(Object.assign(document.createElement("div"), { className: "pg-none", textContent: link.kind === "nest" ? "this nest publishes no views" : "the link carries no views" }));
  $("about").replaceChildren(
    `${opened.tables} tables, ${opened.segments.toLocaleString()} segments, ${opened.rows.toLocaleString()} rows sealed, dataset `,
    Object.assign(document.createElement("code"), { textContent: `${nest.dataset.slice(0, 12)}…` }),
    ...(link.kind === "nest" ? [
      ", views from ",
      Object.assign(document.createElement("a"), { href: `${nest.repo}/tree/${nest.commit}/views`, textContent: nest.repo.replace("https://github.com/", ""), target: "_blank", rel: "noopener" }),
      ` at ${nest.commit.slice(0, 7)}`,
    ] : [`, from ${host(nest.base)}${nest.views.length ? ", views from the link" : ""}`]),
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
  if (nest.pin) pinShown(opened);
  else {
    if (!opened.tail.refused) loading(`${nest.nest} is open; fetching the blocks past the mirror before the first query…`);
    await refreshTail();
  }
  postcard.state = "open";
  if (then) { $("sql").value = then; autorun ? run() : status(`${nest.nest} ready.`); }
  else {
    if (opened.views[0]) { $("sql").value = `SELECT * FROM "${opened.views[0]}"`; showSource(opened.views[0]); if (autorun) run(); }
    else status(`${nest.nest} ready.`);
  }
}

/// Opens what the address bar names and, unless a later open has replaced it, says on the page why it
/// did not.
let opening = 0;
function openShown(autorun = true) {
  const mine = ++opening;
  postcard.state = "opening";
  let l;
  try { l = parseFragment(location.hash); }
  catch (e) { failed(e); return Promise.resolve(); }
  return openNest(l, autorun).catch((e) => { if (mine === opening) failed(e); });
  function failed(e) {
    postcard.state = "error";
    status(`${nest?.nest ?? "the nest"} did not open: ${message(e)}`, true);
    $("views").removeAttribute("aria-busy");
    $("views").replaceChildren(Object.assign(document.createElement("div"), { className: "pg-none", textContent: "no views: the nest did not open" }));
  }
}

/// The picker stays the curated list; a link to anything else shows as one more entry above it.
function pickerShows(l) {
  const own = $("nest").querySelector("option[data-link]");
  if (l.kind === "nest") {
    own?.remove();
    $("nest").value = String(Math.max(0, index.nests.findIndex((n) => n.nest === (l.nest ?? "defi-pulse-nest"))));
    return;
  }
  const o = own ?? Object.assign(document.createElement("option"), { value: "link" });
  o.dataset.link = "";
  o.textContent = `${l.kind === "postcard" ? "postcard" : "link"}: ${host(`${l.m ?? index.base}/x`)}`;
  if (!own) $("nest").prepend(o);
  $("nest").value = "link";
}

/// Drop the pin: the same nest, unpinned, live tail and all where the page has one for it.
function followHead() {
  const curated = !link.m && index.nests.find((n) => n.dataset === link.d);
  const next = curated ? { kind: "nest", nest: curated.nest, q: link.q } : { kind: "base", m: link.m, d: link.d, w: link.w, q: link.q };
  location.hash = formatFragment(next);
}
const followButton = () => {
  const b = Object.assign(document.createElement("button"), { className: "quiet", textContent: "Follow to the head", title: "Drop the pin and open what the host holds now" });
  b.addEventListener("click", followHead);
  return b;
};

/// RFC-0068 §7: what a postcard pinned, said beside the answer.
const tailControls = (shown) => { for (const id of ["tail-refresh", "tail-receipts", "rpc"]) if ($(id)) $(id).hidden = !shown; };
function pinShown(o) {
  tailControls(!o);
  if (!o) return;
  const cuts = Object.entries(nest.pin.cuts).sort(([a], [b]) => a.localeCompare(b));
  const chain = o.pin.chain_id ? Object.values(CHAINS).find((c) => c.id === o.pin.chain_id)?.label ?? `chain ${o.pin.chain_id}` : "a chain its host does not name";
  const details = Object.assign(document.createElement("details"), { className: "pg-cuts" });
  const ul = document.createElement("ul");
  ul.append(...cuts.map(([t, b]) => Object.assign(document.createElement("li"), { textContent: `${t}: block ${b.toLocaleString()}` })));
  details.append(Object.assign(document.createElement("summary"), { textContent: `each table's cut (${cuts.length} of ${o.tables} tables; the others had nothing sealed when the link was made, so they answer nothing)` }), ul);
  $("tail-note")?.replaceChildren(
    `Pinned by a postcard: on ${chain}, these rows are what nest ${nest.dataset.slice(0, 12)}… had sealed through block ${opened.sealed_through.toLocaleString()}, each table cut where the link says; nothing later is included. `
    + `${o.pin.host} served the catalogue and schema.json, which hash to the link's digest, and every segment is checked against its address as it arrives. `,
    followButton(),
    details,
  );
}

/// The host does not hold what the postcard pins. Said plainly, and never answered from.
function refusePin(p) {
  postcard.state = p.state;
  tailControls(false);
  $("views").removeAttribute("aria-busy");
  $("views").replaceChildren(Object.assign(document.createElement("div"), { className: "pg-none", textContent: "no views: the postcard was not answered" }));
  const list = (ts) => ts.slice(0, 3).join(", ") + (ts.length > 3 ? ` and ${ts.length - 3} more` : "");
  const text = {
    behind: () => `${p.host} has not caught up with this postcard: its catalogue ends before the link's cut for ${list(p.tables)}. A host that caches its catalogue lags a fresh link (GitHub Pages holds it ten minutes, jsDelivr up to twelve hours). Try again later.`,
    moved: () => `${p.host} no longer holds the segments this postcard pins: for ${list(p.tables)}, no segment ends at the link's cut any more, so the nest has been sealed again with other boundaries since the link was made, most likely re-indexed from scratch. This link cannot be answered from this host.`,
    differs: () => `${p.host} does not hold the segments this postcard pins: under the link's cut, its catalogue and schema.json hash to ${p.digest.slice(0, 12)}…, and the link says ${nest.pin.digest.slice(0, 12)}…. Either the host changed what it published or the nest was published again from a fresh index. This link cannot be answered from this host.`,
  }[p.state]();
  status(text, true);
  postcard.message = text;
  const retry = Object.assign(document.createElement("button"), { className: "quiet", textContent: "Try again" });
  retry.addEventListener("click", () => openShown());
  $("tail-note")?.replaceChildren(...(p.state === "behind" ? [retry, " "] : []), followButton());
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
  if (running || !opened?.views) return;
  running = true;
  $("run").disabled = true;
  $("cancel").hidden = false;
  const sql = $("sql").value;
  link = { ...link, q: sql ? await deflate(sql) : null };
  history.replaceState(null, "", `#${formatFragment(link)}`);
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
    download: `${nest.nest.replace(/[^A-Za-z0-9_-]+/g, "-")}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

$("nest").replaceChildren(...index.nests.map((n, i) => Object.assign(document.createElement("option"), { value: i, textContent: n.nest })));
$("nest").addEventListener("change", (e) => { if (e.target.value !== "link") location.hash = formatFragment({ kind: "nest", nest: index.nests[+e.target.value].nest }); });
$("run").addEventListener("click", run);
$("cancel").addEventListener("click", () => openShown(false));
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

/// One statement's whole answer and its digest, or why there is none.
postcard.answer = async (sql) => {
  while (running) await new Promise((r) => setTimeout(r, 100));
  if (postcard.state !== "open") return { error: `nothing is open: ${postcard.state}` };
  try {
    const r = await call("query", { sql, whole: true });
    const lines = r.text.split("\n").filter((l) => l.length);
    return { rows: lines.length, digest: await digest(lines), fetched: r.fetched, cached: r.cached };
  } catch (e) { return { error: message(e) }; }
};

/// Every view of the open nest, one after another, for measuring: cold on an empty cache, then
/// again from this browser's cache in a fresh worker.
window.__resources = () => call("resources");

window.__bench = async () => {
  whole = true;
  const out = [];
  for (const pass of ["cold", "opfs"]) {
    if (pass === "cold") await call("clearCache").catch(() => {});
    await openNest(link);
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

// Links made before RFC-0068 carried the query in the query string; it moves to the fragment.
const legacy = new URLSearchParams(location.search);
if (legacy.has("nest") || legacy.has("q")) {
  const q = legacy.get("q");
  const frag = location.hash.length > 1 ? location.hash : `#${formatFragment({ kind: "nest", nest: legacy.get("nest"), q: q ? await deflate(q) : null })}`;
  history.replaceState(null, "", `${location.pathname}${frag}`);
}
// A link pasted into this tab changes only the fragment; the page's own rewrites do not fire this.
addEventListener("hashchange", () => openShown());
openShown();
