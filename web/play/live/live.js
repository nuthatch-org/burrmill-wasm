// RFC-0075: the whole nest in this tab. A dedicated worker runs nuthatch's cursor, hot store, reorg
// rollback, entities and query routes, built from nuthatch's spike/dbsp-wasm; sw.js answers the node's
// HTTP routes under this page's path, so every request below is a plain fetch on this origin.
import { startNest } from "./page.js";
import { budgetMiB, SMALL_MIB } from "../budget.js";

const $ = (id) => document.getElementById(id);
const base = new URL("./", location.href);
const params = new URLSearchParams(location.search);

const GRT = "0xc944E90C64B2c07662A292be6244BDf05Cda44a7";
const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const POLL_SECS = 12;

// RFC-0075 S4's nest: two entities over the token's transfers and three views over them and the facts.
const FILES = {
  "entities.toml": `[[entities]]
name = "received"
sql = "entities/received.sql"
key = ["to"]
max_rows = 10000

[[entities]]
name = "sent"
sql = "entities/sent.sql"
key = ["from"]
max_rows = 10000
`,
  "entities/received.sql": `SELECT t."to", COUNT(*) AS n, SUM(CAST(t.value AS HUGEINT)) AS total, MIN(t.block_number) AS first_block, MAX(t.block_number) AS last_block
FROM tab__transfer t
GROUP BY t."to"
`,
  "entities/sent.sql": `SELECT t."from", COUNT(*) AS n, SUM(CAST(t.value AS HUGEINT)) AS total
FROM tab__transfer t
WHERE t."from" <> '0x0000000000000000000000000000000000000000'
GROUP BY t."from"
`,
  "views/20-live.sql": `CREATE VIEW per_minute AS
SELECT block_timestamp - block_timestamp % 60 AS minute, COUNT(*) AS transfers, SUM(value_dec) AS volume
FROM tab__transfer
GROUP BY 1;

CREATE VIEW busy_receivers AS
SELECT "to", n, total FROM received WHERE n >= 3;

CREATE VIEW two_way AS
SELECT r."to" AS account, r.n AS received_n, s.n AS sent_n, r.total - s.total AS net
FROM received r JOIN sent s ON r."to" = s."from";
`,
};

const EXAMPLES = [
  "SELECT count(*) FROM tab__transfer",
  'SELECT block_number, log_index, "from", "to", value FROM tab__transfer ORDER BY block_number DESC, log_index DESC LIMIT 10',
  'SELECT "to", n, total FROM received ORDER BY n DESC LIMIT 10',
  "SELECT * FROM per_minute ORDER BY minute DESC LIMIT 20",
  "SELECT * FROM two_way ORDER BY received_n + sent_n DESC LIMIT 10",
];

const ownRpc = () => { try { return localStorage.getItem("play.rpc.1"); } catch { return null; } };
const rpc = params.get("rpc") || ownRpc() || DEFAULT_RPC;
const contract = params.get("contract") || GRT;
const back = Math.max(1, Math.min(5000, Number(params.get("back")) || 300));
// The query string can only lower the ceiling, so a link cannot raise a phone's past what it holds.
const ceiling = Math.min(budgetMiB(), Number(params.get("ceiling")) || Infinity);

$("contract").value = contract;
$("back").value = back;
$("rpc").value = rpc;
$("ceiling").textContent = ceiling <= SMALL_MIB
  ? `Memory ceiling: ${ceiling} MiB, because this looks like a phone. A statement may use a quarter of it; the cursor and its entities the rest.`
  : `Memory ceiling: ${ceiling.toLocaleString("en")} MiB, nuthatch's budget for one chain's cursor. A statement may use a quarter of it; the cursor and its entities the rest.`;
$("trust").textContent = `This tab trusts ${new URL(rpc).host}. No light client checks the head yet, so it indexes the chain that RPC describes, and rolls back what that RPC later forks away.`;

const fmt = (n) => (n == null ? "none" : Number(n).toLocaleString("en"));
let tip = null;
let rollbacks = 0;
const show = (f) => {
  if (f.error) {
    $("cursor-err").textContent = `The last pass stopped: ${f.error}. It tries again in ${POLL_SECS} s.`;
    return;
  }
  $("cursor-err").textContent = "";
  if (f.resumed_from != null) {
    rollbacks += 1;
    const li = document.createElement("li");
    li.textContent = `${new Date().toLocaleTimeString()}: a reorg; rolled back and resumed from block ${fmt(f.resumed_from)}`;
    $("reorgs").prepend(li);
  }
  $("c-last").textContent = fmt(f.last_block);
  $("c-tip").textContent = fmt(tip);
  $("c-rows").textContent = fmt(f.hot_rows);
  $("c-holders").textContent = fmt(f.holders);
  $("c-sealed").textContent = f.sealed_through == null ? "nothing yet" : fmt(f.sealed_through);
  $("c-reorgs").textContent = fmt(rollbacks);
  $("c-store").textContent = f.backend === "opfs" ? "redb in OPFS" : "redb in memory";
};

async function ready() {
  const r = await fetch(new URL("ready", base));
  const j = await r.json();
  tip = j.tip;
  $("c-tip").textContent = fmt(tip);
  $("c-lag").textContent = j.lag_blocks == null ? "" : `${fmt(j.lag_blocks)} behind`;
}

async function head() {
  const r = await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = await r.json();
  if (!j.result) throw new Error(`${new URL(rpc).host} did not give a block number: ${JSON.stringify(j.error ?? j)}`);
  return Number(BigInt(j.result));
}

// Each load opens a fresh store, so the entities start cold and are available; older ones are swept
// unless another tab still holds them.
async function sweep() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (name.startsWith("live-")) await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch { /* no OPFS: the store is in memory */ }
}

function render(path, status, text) {
  $("req").textContent = `GET ${path} -> ${status}`;
  let j;
  try { j = JSON.parse(text); } catch { j = null; }
  const table = $("table");
  table.replaceChildren();
  if (j && Array.isArray(j.columns) && Array.isArray(j.rows)) {
    const tr = document.createElement("tr");
    for (const c of j.columns) { const th = document.createElement("th"); th.textContent = c; tr.append(th); }
    table.append(tr);
    for (const row of j.rows) {
      const r = document.createElement("tr");
      for (const c of j.columns) {
        const td = document.createElement("td");
        const v = row[c];
        td.textContent = v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
        r.append(td);
      }
      table.append(r);
    }
  }
  $("raw").textContent = j ? JSON.stringify(j, null, 2) : text;
}

async function get(path) {
  const r = await fetch(new URL(path, base));
  const text = await r.text();
  render(base.pathname + path, r.status, text);
  return { status: r.status, text };
}

const runSql = () => get(`sql?q=${encodeURIComponent($("sql").value)}`);

async function main() {
  $("status").textContent = `Asking ${new URL(rpc).host} for the head…`;
  const start = (await head()) - back;
  await sweep();
  $("status").textContent = `Loading nuthatch and following ${contract} from block ${fmt(start)}…`;
  const t0 = performance.now();
  const nest = await startNest({
    scope: base.pathname,
    swUrl: new URL("sw.js", base).pathname,
    workerUrl: new URL("nest-worker.js", base).pathname,
    open: {
      pkg: "./pkg/dbsp_wasm_spike.js",
      nid: `live-${Date.now().toString(36)}`, rpc, contract, start, files: FILES,
      memoryCeilingMib: ceiling, pollIntervalSecs: POLL_SECS, keepFollowing: true,
    },
    onFollowed: (f) => { show(f); ready().catch(() => {}); },
  });
  window.nest = nest;
  show(nest.opened);
  await ready();
  $("status").textContent = `Caught up with the tip in ${((performance.now() - t0) / 1000).toFixed(1)} s. It follows every ${POLL_SECS} s from here.`;
  for (const id of ["run", "entity-go"]) $(id).disabled = false;
  for (const b of document.querySelectorAll("[data-get]")) b.disabled = false;
  const latest = JSON.parse((await get("entities?limit=1")).text);
  const e = latest.items?.[0];
  if (e) $("entity").value = `${String(e.block_number).padStart(12, "0")}-${String(e.log_index).padStart(6, "0")}`;
  document.body.dataset.state = "following";
}

$("sql").value = params.get("q") || EXAMPLES[0];
for (const q of EXAMPLES) {
  const b = document.createElement("button");
  b.className = "example"; b.textContent = q; b.title = q;
  b.addEventListener("click", () => { $("sql").value = q; if (!$("run").disabled) runSql(); });
  $("examples").append(b);
}
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  // The RPC stays in this browser, as /play keeps it: a URL can carry a key, and the link does not.
  const url = $("rpc").value.trim();
  try { url && url !== DEFAULT_RPC ? localStorage.setItem("play.rpc.1", url) : localStorage.removeItem("play.rpc.1"); } catch { /* this visit only */ }
  const q = new URLSearchParams({ contract: $("contract").value.trim(), back: $("back").value });
  location.search = q.toString();
});
$("run").addEventListener("click", runSql);
$("sql").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !$("run").disabled) runSql(); });
$("entity-go").addEventListener("click", () => get(`entity/${encodeURIComponent($("entity").value.trim())}`));
for (const b of document.querySelectorAll("[data-get]")) b.addEventListener("click", () => get(b.dataset.get));
$("files").textContent = Object.entries(FILES).map(([k, v]) => `-- ${k}\n${v}`).join("\n");

main().catch((e) => {
  $("status").textContent = `It stopped: ${e.message}`;
  $("status").classList.add("err");
  document.body.dataset.state = "failed";
});
