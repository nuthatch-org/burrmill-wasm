// The builder's indexer (RFC-0066 S2): backfill and seal a nest the page scaffolded, open it as the
// playground opens a published one, keep the unsealed blocks to the head on top, and answer SQL.
import init, * as w from "./pkg/burrmill_wasm.js";
import { backfill, openable, headRows, storeFns } from "./index-it.js";

const ready = init();
const FOLLOW_MS = 12000;
let indexed = null;
let nest = null;
let views = [];

function open() {
  const { size, read } = storeFns(indexed.store);
  nest = new w.Nest(size, read, "", openable(indexed), indexed.files["schema.json"]);
  for (const [, sql] of views) nest.addViews(sql);
  if (indexed.rows) nest.setTail(JSON.stringify(indexed.rows));
}

async function follow() {
  try {
    const { rows, to } = await headRows({ decoder: indexed.decoder, rpc: indexed.rpc, after: indexed.sealer.watermark() });
    indexed.rows = rows;
    const kept = nest.setTail(JSON.stringify(rows));
    postMessage({ type: "head", head: to, unsealed: kept });
  } catch (e) {
    postMessage({ type: "head", error: String(e.message ?? e) });
  }
  setTimeout(follow, FOLLOW_MS);
}

const sortedViews = (files) =>
  Object.entries(files).filter(([p]) => p.startsWith("views/") && p.endsWith(".sql")).sort(([a], [b]) => (a < b ? -1 : 1));

onmessage = async ({ data }) => {
  await ready;
  try {
    if (data.type === "index") {
      const store = new Map();
      const done = await backfill({
        w, files: data.files, from: data.from, rpc: data.rpc, second: data.second, store,
        progress: (p) => postMessage({ type: "progress", ...p }),
      });
      indexed = { ...done, store, files: data.files, rpc: data.rpc };
      views = sortedViews(data.files);
      open();
      postMessage({
        type: "indexed",
        finalized: done.finalized,
        segments: Object.values(done.manifest.tables).flat().length,
        tails: Object.keys(done.provisional).length,
        hashes: Object.entries(done.manifest.tables).flatMap(([t, segs]) => segs.map((s) => ({ table: t, ...s }))),
        logs: done.logs, bytes: done.bytes, ms: done.ms,
        mem_mib: Math.round(w.wasmMemory().buffer.byteLength / 2 ** 20),
      });
      follow();
    } else if (data.type === "views") {
      views = sortedViews(data.files);
      if (indexed) open();
      postMessage({ type: "views", id: data.id });
    } else if (data.type === "query") {
      const t0 = performance.now();
      const text = await nest.query(data.sql);
      postMessage({ type: "rows", id: data.id, text, ms: Math.round(performance.now() - t0) });
    }
  } catch (e) {
    postMessage({ type: "error", id: data.id, error: String(e.message ?? e) });
  }
};
