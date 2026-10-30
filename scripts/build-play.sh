#!/usr/bin/env bash
# The playground as one static directory, dist/play: the page, the nest index and the web module.
# Run scripts/build.sh first; scripts/play-index.mjs refreshes web/play/nests.json.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-pkg.mjs
rm -rf dist/play && mkdir -p dist/play/pkg
cp web/play/index.html web/play/play.js web/play/worker.js web/play/chart.js web/play/tail.js web/play/finality.js web/play/verified.js web/play/nests.json web/play/build.html web/play/build.js web/play/resolve.js web/play/zip.js web/play/index-it.js web/play/build-worker.js web/play/chains.js web/play/budget.js web/play/postcard.js dist/play/
# Helios (MIT), the light client the worker loads on its first seal (RFC-0065 S5), pinned by its hash.
helios=target/helios-0.12.0
if [ ! -f "$helios/package/dist/lib.mjs" ]; then
  mkdir -p "$helios" && curl -sfL https://registry.npmjs.org/@a16z/helios/-/helios-0.12.0.tgz | tar -xz -C "$helios"
fi
echo "0c0b4d155e65af04e1bc1c3abae1f792753553e1ff98db3a92db004cd3a26c22  $helios/package/dist/lib.mjs" | shasum -a 256 -c --quiet
mkdir -p dist/play/helios && cp "$helios/package/dist/lib.mjs" "$helios/package/LICENSE" dist/play/helios/
# The checkpoint the light client starts from: the beacon chain's finalized block as of this build.
curl -sf https://lodestar-mainnet.chainsafe.io/eth/v1/beacon/headers/finalized |
  jq -c --arg at "$(($(date +%s) * 1000))" '{root: .data.root, slot: (.data.header.message.slot | tonumber), at: ($at | tonumber)}' > dist/play/checkpoint.json
cp -R web/play/nests dist/play/nests
# Time-lapse (RFC-0070 S2): its page lives here, its engine is built in nuthatch by tools/rfc-0070-s2/build.sh.
tl_pkg=${TIMELAPSE_PKG:-../nuthatch/tools/rfc-0070-s2/web/pkg}
[ -f "$tl_pkg/rfc_0070_s1_bg.wasm" ] || { echo "no time-lapse engine at $tl_pkg: run nuthatch's tools/rfc-0070-s2/build.sh, or set TIMELAPSE_PKG" >&2; exit 1; }
cp -R web/play/timelapse dist/play/timelapse
mkdir -p dist/play/timelapse/pkg && cp "$tl_pkg/rfc_0070_s1.js" "$tl_pkg/rfc_0070_s1_bg.wasm" dist/play/timelapse/pkg/
# The whole nest in a tab (RFC-0075): its relay, worker and Service Worker are nuthatch's gated files,
# and its module is what nuthatch's spike/dbsp-wasm/build-tab.sh web pkg-web builds.
tab=${NEST_TAB:-../nuthatch/spike/dbsp-wasm}
[ -f "$tab/pkg-web/dbsp_wasm_spike_bg.wasm" ] || { echo "no tab module at $tab/pkg-web: run nuthatch's spike/dbsp-wasm/build-tab.sh web pkg-web, or set NEST_TAB" >&2; exit 1; }
mkdir -p dist/play/live/pkg
cp web/play/live/live.js "$tab/web/page.js" "$tab/web/nest-worker.js" "$tab/web/sw.js" dist/play/live/
cp "$tab/pkg-web/dbsp_wasm_spike.js" "$tab/pkg-web/dbsp_wasm_spike_bg.wasm" dist/play/live/pkg/
cp pkg/web/burrmill_wasm.js pkg/web/burrmill_wasm_bg.wasm dist/play/pkg/
# The worker shows download progress against the unpacked size: a brotli response has no Content-Length.
bytes=$(wc -c < pkg/web/burrmill_wasm_bg.wasm | tr -d ' ')
sed -i '' "s/^const ENGINE_BYTES = 0;/const ENGINE_BYTES = $bytes;/" dist/play/worker.js
grep -q "^const ENGINE_BYTES = $bytes;" dist/play/worker.js || { echo "worker.js: ENGINE_BYTES not stamped" >&2; exit 1; }
# The engine comparison imports DuckDB-Wasm from jsDelivr, so it never shares an origin with pages that
# keep visitors' RPC URLs: COMPARE=1 builds it alone into dist/compare, to serve from somewhere else.
if [ -n "${COMPARE:-}" ]; then
  rm -rf dist/compare && mkdir -p dist/compare/pkg
  cp web/play/compare.html web/play/compare.js web/play/nests.json web/duckbind.js dist/compare/
  cp pkg/web/burrmill_wasm.js pkg/web/burrmill_wasm_bg.wasm dist/compare/pkg/
fi
du -sh dist/play
