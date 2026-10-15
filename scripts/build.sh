#!/usr/bin/env bash
# Build the wasm module and its JavaScript glue into pkg/{web,node}.
#   BURRMILL=../burrmill-wasmcore/crates/burrmill  build against a local burrmill checkout
#   CLANG=/opt/homebrew/opt/llvm/bin               a clang with the WebAssembly backend (zstd-sys)
set -euo pipefail
cd "$(dirname "$0")/.."
clang_dir=${CLANG:-/opt/homebrew/opt/llvm/bin}
[ -x "$clang_dir/clang" ] || { echo "no clang at $clang_dir: Apple's has no wasm32 backend; brew install llvm" >&2; exit 1; }
export CC_wasm32_unknown_unknown=$clang_dir/clang AR_wasm32_unknown_unknown=$clang_dir/llvm-ar
patch=()
[ -n "${BURRMILL:-}" ] && patch=(--config "patch.\"https://github.com/nuthatch-org/burrmill\".burrmill.path=\"$BURRMILL\"")
# bash 3.2 (macOS) calls an empty array unbound under set -u.
cargo build --release --target wasm32-unknown-unknown ${patch[@]+"${patch[@]}"}
wasm=target/wasm32-unknown-unknown/release/burrmill_wasm.wasm
wasm-bindgen "$wasm" --out-dir pkg/node --target nodejs
wasm-bindgen "$wasm" --out-dir pkg/web --target web
for t in node web; do
  wasm-opt -O3 --strip-debug --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "pkg/$t/burrmill_wasm_bg.wasm" -o "pkg/$t/burrmill_wasm_bg.wasm"
done
f=pkg/web/burrmill_wasm_bg.wasm
echo "wasm: $(wc -c < "$f") bytes, $(brotli -c -q 11 "$f" | wc -c) brotli"
