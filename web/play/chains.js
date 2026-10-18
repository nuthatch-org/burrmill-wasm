// The chains the builder scaffolds, with what nuthatch's chain registry (src/chains.rs) says about
// each: its id, and the span its segments are cut on, which the tab must share to seal the bytes a
// node seals. The RPCs are keyless ones that passed a browser's CORS preflight and served logs a week
// back on 2026-10-18; on Base the second allows 50 blocks a query, so its agreement check is slow.
export const CHAINS = {
  mainnet: { id: 1, label: "Ethereum", span: 1800, rpc: "https://rpc.mevblocker.io", second: "https://eth.drpc.org" },
  base: { id: 8453, label: "Base", span: 10800, rpc: "https://base.drpc.org", second: "https://1rpc.io/base" },
  "arbitrum-one": { id: 42161, label: "Arbitrum One", span: 86400, rpc: "https://arb1.arbitrum.io/rpc", second: "https://arbitrum.drpc.org" },
};
