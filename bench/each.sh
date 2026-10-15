#!/usr/bin/env bash
# One view per process, each line logged as it finishes, each capped: a wasm memory never shrinks,
# so a fresh process is also the only honest per-view memory figure.
#   bench/each.sh <node|duckdb> data/alloc out.jsonl [seconds per view]
set -uo pipefail
cd "$(dirname "$0")/.."
engine=$1 dir=$2 out=$3 cap=${4:-600}
: > "$out"
views=$(node -e '
  const fs = require("fs"), p = require("path"), d = process.argv[1];
  const sql = fs.readdirSync(p.join(d, "views")).filter(f => f.endsWith(".sql")).sort()
    .map(f => fs.readFileSync(p.join(d, "views", f), "utf8")).join(";\n");
  const names = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+"?([a-z0-9_]+)"?\s+as\s/gi)].map(m => m[1].toLowerCase());
  console.log(names.join("\n"));' "$dir")
for v in $views; do
  line=$(OUT=/dev/null timeout "$cap" node "bench/$engine.mjs" "$dir" "$v" 2>&1 | grep '^{' | tail -1)
  [ -n "$line" ] || line="{\"view\":\"$v\",\"err\":\"no answer within ${cap}s\"}"
  echo "$line" | tee -a "$out"
done
