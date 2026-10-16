// Writes web/play/nests.json: every nest the mirror publishes, with the authored views at the
// published commit, so the page needs nothing at run time but the segments.
//   node scripts/play-index.mjs <nuthatch-frontend>/src/data/mirror.json
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const mirror = JSON.parse(readFileSync(process.argv[2], "utf8"));
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const nests = [];
for (const d of mirror.datasets) {
  const repo = d.repo.replace("https://github.com/", "");
  const tree = JSON.parse(gh("api", `repos/${repo}/git/trees/${d.commit}?recursive=1`));
  const files = tree.tree.filter((e) => e.type === "blob" && /^views\/[^/]+\.sql$/.test(e.path)).map((e) => e.path).sort();
  const views = files.map((path) => ({
    path,
    text: Buffer.from(JSON.parse(gh("api", `repos/${repo}/contents/${path}?ref=${d.commit}`)).content, "base64").toString("utf8"),
  }));
  nests.push({ nest: d.nest, repo: d.repo, commit: d.commit, dataset: d.dataset, views });
  console.error(`${d.nest}: ${views.length} views`);
}
writeFileSync("web/play/nests.json", JSON.stringify({ base: "https://nestsss.nestsss-worker.workers.dev", nests }, null, 1) + "\n");
