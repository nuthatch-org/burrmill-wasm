// RFC-0066 S1's gate: the nest the builder page makes, from the same modules the page loads, against
// the nest `nuthatch init` makes with no `--rpc`, and the NID `nuthatch dev --dir` reports for the
// downloaded zip. RPC only resolves the contracts, as the page's RPC box does.
//   NUTHATCH=<binary> NAME=pair ADDRESSES=0x..[,0x..] [STARTS=n[,n]] node bench/builder-gate.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { resolveContract, chainId } from "../web/play/resolve.js";
import { zip } from "../web/play/zip.js";
import { CHAINS } from "../web/play/chains.js";

const w = createRequire(import.meta.url)("../pkg/node/burrmill_wasm.js");
const bin = process.env.NUTHATCH;
const name = process.env.NAME ?? "nest";
const rpc = process.env.RPC ?? "https://ethereum-rpc.publicnode.com";
const addresses = process.env.ADDRESSES.split(",");
const starts = (process.env.STARTS ?? "").split(",").map((s) => (s ? Number(s) : null));
if (!bin) throw new Error("NUTHATCH=<binary> is required");

const id = await chainId(rpc);
const contracts = [];
for (const [i, address] of addresses.entries()) {
  const c = await resolveContract({ rpc, id, address, start: starts[i], taken: contracts.map((c) => c.alias), w });
  console.log(`${c.alias}: ${c.address}${c.implementation ? ` via ${c.implementation}` : ""}, start ${c.start_block}`);
  contracts.push(c);
}
const input = JSON.stringify({ name, chain: "mainnet", chain_id: id, rpc_urls: CHAINS.mainnet.rpc_urls, contracts });
const files = w.scaffoldNest(input);
const page = JSON.parse(w.nestIdentity(input, files));
const enc = new TextEncoder();
const archive = zip(Object.entries(JSON.parse(files)).map(([p, t]) => [`${name}/${p}`, enc.encode(t)]));

const root = mkdtempSync(join(tmpdir(), "builder-gate-"));
writeFileSync(join(root, `${name}.zip`), archive);
execFileSync("unzip", ["-q", `${name}.zip`, "-d", "tab"], { cwd: root });
const startArgs = contracts.some((c) => c.start_block != null) ? ["--start-block", contracts.map((c) => c.start_block ?? "").join(",")] : [];
execFileSync(bin, ["init", ...addresses, ...startArgs, "--chain", "mainnet", "--dir", join("node", name)], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
let same = true;
try {
  execFileSync("diff", ["-r", join("node", name), join("tab", name)], { cwd: root, stdio: "inherit" });
} catch {
  same = false;
}

const port = 18000 + Math.floor(Math.random() * 1000);
const dev = spawn(bin, ["dev", "--dir", join(root, "tab", name), "--listen", `127.0.0.1:${port}`, "--backfill", "10", "--no-admin"], { stdio: "ignore" });
let node = null;
for (let i = 0; i < 60 && !node; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  node = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json()).catch(() => null);
}
dev.kill();
console.log(`page NID ${page.nid}\ndev  NID ${node?.nid}`);
const ok = same && node?.nid === page.nid && node?.data_identity === page.data_identity;
console.log(ok ? "PASS: the zip is the nest init writes, and dev reports the NID the page showed" : "FAIL");
process.exit(ok ? 0 : 1);
