#!/usr/bin/env bash
# The playground as one static directory, dist/play: the page, the nest index and the web module.
# Run scripts/build.sh first; scripts/play-index.mjs refreshes web/play/nests.json.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f pkg/web/burrmill_wasm_bg.wasm ] || { echo "no pkg/web: run scripts/build.sh first" >&2; exit 1; }
rm -rf dist/play && mkdir -p dist/play/pkg
cp web/play/index.html web/play/play.js web/play/worker.js web/play/nests.json web/play/compare.html web/play/compare.js web/duckbind.js dist/play/
cp pkg/web/burrmill_wasm.js pkg/web/burrmill_wasm_bg.wasm dist/play/pkg/
du -sh dist/play
