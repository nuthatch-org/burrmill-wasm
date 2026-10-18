// Writes web/play/nests.json: every nest the mirror publishes, with its authored views, its
// nuthatch.toml and the ABIs that names, at the published commit, so the page needs nothing at run
// time but the segments and, for the live tail, an RPC.
//   node scripts/play-index.mjs <nuthatch-frontend>/src/data/mirror.json
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mirror = JSON.parse(readFileSync(process.argv[2], "utf8"));
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const nests = [];
for (const d of mirror.datasets) {
  const repo = d.repo.replace("https://github.com/", "");
  const file = (path) => gh("api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${d.commit}`);
  const tree = JSON.parse(gh("api", `repos/${repo}/git/trees/${d.commit}?recursive=1`));
  const files = tree.tree.filter((e) => e.type === "blob" && /^views\/[^/]+\.sql$/.test(e.path)).map((e) => e.path).sort();
  const views = files.map((path) => ({ path, text: file(path) }));
  const config = file("nuthatch.toml");
  const abis = Object.fromEntries([...config.matchAll(/^\s*abi\s*=\s*"([^"]+)"/gm)].map(([, p]) => [p, file(p)]));
  // The decoder's inputs are fetched only for the nest a visitor opens: the ABIs dwarf everything else.
  writeFileSync(`web/play/nests/${d.nest}.json`, JSON.stringify({ config, abis }) + "\n");
  nests.push({ nest: d.nest, repo: d.repo, commit: d.commit, dataset: d.dataset, views, decoder: `nests/${d.nest}.json` });
  console.error(`${d.nest}: ${views.length} views, ${Object.keys(abis).length} ABIs`);
}
writeFileSync("web/play/nests.json", JSON.stringify({ base: "https://nestsss.nestsss-worker.workers.dev", nests }, null, 1) + "\n");
