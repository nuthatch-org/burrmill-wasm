#!/usr/bin/env bash
# Publish dist/play as the nuthatch-play Vercel project, which nuthatch-indexer.com/play/ proxies.
# .play-deploy keeps the Vercel link and vercel.json across rebuilds; dist/play is wiped by each one.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/build-play.sh
mkdir -p .play-deploy
rsync -a --delete --exclude .vercel --exclude vercel.json dist/play/ .play-deploy/
cp web/play-vercel.json .play-deploy/vercel.json
cd .play-deploy && vercel deploy --prod --yes --scope nbgn
