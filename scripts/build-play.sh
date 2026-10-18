#!/usr/bin/env bash
# The playground as one static directory, dist/play: the page, the nest index and the web module.
# Run scripts/build.sh first; scripts/play-index.mjs refreshes web/play/nests.json.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f pkg/web/burrmill_wasm_bg.wasm ] || { echo "no pkg/web: run scripts/build.sh first" >&2; exit 1; }
rm -rf dist/play && mkdir -p dist/play/pkg
cp web/play/index.html web/play/play.js web/play/worker.js web/play/chart.js web/play/tail.js web/play/finality.js web/play/verified.js web/play/nests.json web/play/compare.html web/play/compare.js web/play/build.html web/play/build.js web/play/resolve.js web/play/zip.js web/play/index-it.js web/play/build-worker.js web/duckbind.js dist/play/
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
cp pkg/web/burrmill_wasm.js pkg/web/burrmill_wasm_bg.wasm dist/play/pkg/
du -sh dist/play
