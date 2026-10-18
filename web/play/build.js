// The nest builder (RFC-0066 S1). The page asks the network what `nuthatch init` asks it; the files,
// the alias and the identity all come from nuthatch's own crates in the wasm module, so the download
// is the nest a node would scaffold, and `nuthatch dev` reports the NID shown here.
import init, * as w from "./pkg/burrmill_wasm.js";
import { chainId, resolveContract } from "./resolve.js";
import { zip } from "./zip.js";
import { explainRefusal } from "./budget.js";

const $ = (id) => document.getElementById(id);
const state = { contracts: [], files: {}, edited: {}, view: "views/10-example.sql", id: null };

function status(text, err = false) {
  $("status").textContent = text;
  $("status").classList.toggle("err", err);
}

const slug = (s) => s.replace(/_/g, "-").replace(/[^a-z0-9-]/g, "") || "nest";

function input() {
  return JSON.stringify({
    name: $("name").value.trim() || "nest",
    chain: "mainnet",
    chain_id: 1,
    rpc_urls: [$("rpc").value.trim()],
    contracts: state.contracts,
  });
}

// Re-scaffold from the contracts, keeping every view the visitor wrote or changed.
function scaffold() {
  state.files = { ...JSON.parse(w.scaffoldNest(input())), ...state.edited };
  refresh();
}

function refresh() {
  const id = JSON.parse(w.nestIdentity(input(), JSON.stringify(state.files)));
  $("identity").replaceChildren(
    ...[["NID", id.nid], ["data identity", id.data_identity]].flatMap(([k, v]) => {
      const a = document.createElement("span");
      a.className = "faint";
      a.textContent = k;
      const b = document.createElement("span");
      b.textContent = v;
      return [a, b];
    }),
  );
  state.id = id;
  const name = $("name").value.trim() || "nest";
  $("run").textContent = `unzip ${name}.zip && nuthatch dev --dir ${name}`;

  const schema = JSON.parse(state.files["schema.json"]);
  $("tables").replaceChildren(
    ...schema.tables.map((t) => {
      const p = document.createElement("span");
      p.className = "pill";
      p.textContent = t.table;
      p.title = t.columns.map((c) => c.name).join(", ");
      return p;
    }),
  );

  const views = Object.keys(state.files).filter((p) => p.startsWith("views/") && p.endsWith(".sql"));
  if (!views.includes(state.view)) state.view = views[0];
  $("view").replaceChildren(
    ...views.map((p) => {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      o.selected = p === state.view;
      return o;
    }),
  );
  if ($("sql").dataset.path !== state.view) {
    $("sql").value = state.files[state.view] ?? "";
    $("sql").dataset.path = state.view;
  }

  $("contracts").replaceChildren(
    ...state.contracts.map((c, i) => {
      const row = document.createElement("div");
      row.className = "card";
      const text = document.createElement("span");
      text.className = "mono";
      const from = c.implementation ? `, ABI from implementation ${c.implementation}` : "";
      const start = c.start_block != null ? `from block ${c.start_block}` : "from block 0 (no deploy block found: set one)";
      text.textContent = `${c.alias}  ${c.address}  ${start}${from}`;
      const drop = document.createElement("button");
      drop.className = "quiet";
      drop.textContent = "Remove";
      drop.onclick = () => {
        state.contracts.splice(i, 1);
        if (state.contracts.length) scaffold();
        else $("out").hidden = true;
      };
      row.append(text, drop);
      return row;
    }),
  );
  $("out").hidden = false;
}

async function add() {
  const address = $("address").value;
  if (!address.trim()) return;
  $("add").disabled = true;
  try {
    const rpc = $("rpc").value.trim();
    status("Asking the RPC for the chain…");
    const id = await chainId(rpc);
    if (id !== 1) throw new Error(`that RPC is chain ${id}; this builder scaffolds Ethereum mainnet`);
    status("Resolving the ABI: proxy slots, then Sourcify…");
    const start = $("start").value.trim();
    const c = await resolveContract({
      rpc,
      id,
      address,
      alias: $("alias").value.trim(),
      start: start ? Number(start) : null,
      taken: state.contracts.map((c) => c.alias),
      w,
    });
    const { implementation, name, ...contract } = c;
    state.contracts.push({ ...contract, implementation });
    if (state.contracts.length === 1 && !$("name").value) $("name").value = slug(c.alias);
    scaffold();
    status(`Added ${c.alias}${name ? ` (${name} on Sourcify)` : ""}.`);
    $("address").value = $("alias").value = $("start").value = "";
  } catch (e) {
    status(String(e.message ?? e), true);
  } finally {
    $("add").disabled = false;
  }
}

function download() {
  const name = $("name").value.trim() || "nest";
  const enc = new TextEncoder();
  const bytes = zip(Object.entries(state.files).map(([p, t]) => [`${name}/${p}`, enc.encode(t)]));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  a.download = `${name}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("add").onclick = add;
$("address").onkeydown = (e) => e.key === "Enter" && add();
$("download").onclick = download;
$("name").oninput = () => state.contracts.length && scaffold();
$("view").onchange = () => {
  state.view = $("view").value;
  refresh();
};
$("sql").oninput = () => {
  state.files[state.view] = state.edited[state.view] = $("sql").value;
  refresh();
  worker?.postMessage({ type: "views", id: ++qid, files: state.files });
};
$("new-view").onclick = () => {
  const used = Object.keys(state.files).filter((p) => p.startsWith("views/"));
  let n = 20;
  while (used.includes(`views/${n}-view.sql`)) n += 10;
  state.view = `views/${n}-view.sql`;
  state.files[state.view] = state.edited[state.view] = "CREATE VIEW my_view AS\nSELECT 1;\n";
  refresh();
};

init().then(
  () => status("Ready. Paste an address."),
  (e) => status(`nuthatch did not load: ${e}`, true),
);

// Index it: the worker backfills, seals and then follows the head; queries go to it.
let worker = null;
let qid = 0;

function table(text) {
  const rows = JSON.parse(text);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const head = document.createElement("tr");
  for (const c of cols) head.append(Object.assign(document.createElement("th"), { textContent: c }));
  const body = rows.slice(0, 500).map((r) => {
    const tr = document.createElement("tr");
    for (const c of cols) tr.append(Object.assign(document.createElement("td"), { textContent: r[c] === null ? "NULL" : String(r[c]) }));
    return tr;
  });
  $("result").replaceChildren(head, ...body);
  return rows.length;
}

function indexIt() {
  if (state.contracts.some((c) => c.start_block == null)) {
    status("Set a start block for every contract first: Sourcify had no deploy block for one.", true);
    return;
  }
  worker?.terminate();
  worker = new Worker(new URL("./build-worker.js", import.meta.url), { type: "module" });
  const from = Math.min(...state.contracts.map((c) => c.start_block));
  $("index").disabled = true;
  $("progress").textContent = `Backfilling from block ${from}…`;
  worker.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      $("progress").textContent = `Sealed through ${m.through} of ${m.finalized}: ${m.logs} logs, ${m.segments} segments, ${(m.ms / 1000).toFixed(1)} s`;
    } else if (m.type === "indexed") {
      $("index").disabled = false;
      $("index").textContent = "Index again";
      $("progress").textContent = `Indexed ${m.logs} logs from block ${from} to finalized block ${m.finalized}: ${m.segments} full segments (${(m.bytes / 1024).toFixed(0)} KiB) and ${m.tails} tails, the newest rows of each table sealed but still growing, in ${(m.ms / 1000).toFixed(1)} s, ${m.mem_mib} MiB of wasm memory. Following the head.`;
      $("query-box").hidden = false;
      if (!$("q").value) {
        const first = JSON.parse(state.files["schema.json"]).tables[0]?.table;
        $("q").value = first ? `SELECT * FROM "${first}" ORDER BY block_number DESC LIMIT 20` : "SELECT 1";
      }
    } else if (m.type === "sealed") {
      $("sealed").textContent = `Finality moved: sealed through block ${m.finalized} (${new Date().toLocaleTimeString()}), ${m.segments} full segments and ${m.tails} tails.`;
    } else if (m.type === "head") {
      const line = $("progress").textContent.replace(/ (Following the head|Head) .*$/, "");
      $("progress").textContent = m.error ? `${line} Head: ${m.error}` : `${line} Head ${m.head}, ${m.unsealed} unsealed rows on top.`;
    } else if (m.type === "rows") {
      $("qstatus").textContent = `${table(m.text)} rows in ${m.ms} ms`;
    } else if (m.type === "error") {
      if (m.id) $("qstatus").textContent = explainRefusal(m.error);
      else {
        $("index").disabled = false;
        $("progress").textContent = `Stopped: ${m.error}`;
      }
    }
  };
  worker.postMessage({ type: "index", files: state.files, from, rpc: $("rpc").value.trim(), second: $("second").value.trim() });
}

$("index").onclick = indexIt;
$("query").onclick = () => {
  $("qstatus").textContent = "running…";
  worker?.postMessage({ type: "query", id: ++qid, sql: $("q").value });
};
$("q").onkeydown = (e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && $("query").click();
