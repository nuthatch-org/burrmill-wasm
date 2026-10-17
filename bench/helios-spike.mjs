// RFC-0065 S5 spike: Helios's light client verifies the finalized block in Node, from Helios's
// built-in checkpoint or CHECKPOINT=0x<beacon block root>. Needs @a16z/helios 0.12.0 unpacked at HELIOS.
//   HELIOS=<dir>/package node bench/helios-spike.mjs
const { createHeliosProvider } = await import(`${process.env.HELIOS}/dist/lib.mjs`);
const t0 = performance.now();
const p = await createHeliosProvider({
  executionRpc: "https://ethereum-rpc.publicnode.com",
  // CORS * over https; the README's default redirects to plain http, which a page cannot call.
  consensusRpc: "https://lodestar-mainnet.chainsafe.io",
  network: "mainnet",
  // A worker has no localStorage.
  dbType: "config",
  ...(process.env.CHECKPOINT ? { checkpoint: process.env.CHECKPOINT } : {}),
}, "ethereum");
await p.waitSynced();
const synced = Math.round(performance.now() - t0);
// The head can lag the endpoint's optimistic updates and is refused; finalized is what sealing needs.
let fin, err;
for (let i = 0; i < 40 && !fin; i++) {
  try { fin = await p.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }); }
  catch (e) { err = String(e); await new Promise((r) => setTimeout(r, 6000)); }
}
if (!fin) { console.log(JSON.stringify({ synced_ms: synced, err })); process.exit(1); }
const checkpoint = await p.request({ method: "helios_getCurrentCheckpoint", params: [] });
console.log(JSON.stringify({ synced_ms: synced, finalized: Number(fin.number), hash: fin.hash, checkpoint, rss_mib: Math.round(process.memoryUsage().rss / 2 ** 20) }));
process.exit(0);
