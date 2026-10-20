// The chains the builder scaffolds, with what nuthatch's chain registry (src/chains.rs) says about
// each: its id, and the span its segments are cut on, which the tab must share to seal the bytes a
// node seals. The RPCs are keyless ones that passed a browser's CORS preflight and served logs a week
// back on 2026-10-18; on Base the second allows 50 blocks a query, so its agreement check is slow.
// `rpc_urls` is what `init` writes for the chain, as of nuthatch 8d649a7b: part of the NID,
// and the only RPCs a download carries, since what a visitor types may hold a key.
export const CHAINS = {
  mainnet: { id: 1, label: "Ethereum", span: 1800, rpc: "https://rpc.mevblocker.io", second: "https://eth.drpc.org",
    rpc_urls: ["https://mainnet.gateway.tenderly.co", "https://rpc.mevblocker.io"] },
  base: { id: 8453, label: "Base", span: 10800, rpc: "https://base.drpc.org", second: "https://1rpc.io/base",
    rpc_urls: ["https://base.gateway.tenderly.co", "https://base-pokt.nodies.app"] },
  "arbitrum-one": { id: 42161, label: "Arbitrum One", span: 86400, rpc: "https://arb1.arbitrum.io/rpc", second: "https://arbitrum.drpc.org",
    rpc_urls: ["https://arb1.arbitrum.io/rpc", "https://arb-pokt.nodies.app"] },
};
