# burrmill-wasm

Burrmill, nuthatch's query engine, compiled to `wasm32-unknown-unknown` and run in a browser tab.

The aim is a static page that is a nest client: it fetches a nest's sealed, content-addressed Parquet
segments over HTTP (the R2 mirror, or any operator's), and answers the nest's authored views in the
tab. No server, no account, nothing to phone home to.

The bar is DuckDB-Wasm on nuthatch's own workload, not in general: the authored views of real nests,
the same answers, cold and warm time, bytes fetched, and the module a visitor downloads.

## How it works

`src/nest.rs` binds a published nest as nuthatch binds it. The mirror already holds what that needs:
`manifest.json` names each table's segments by content address, `schema.json` its declared columns,
and the segments sit at `<dataset>/<table>/<hash>.parquet`. The authored views come from the nest's
repository at the published commit. A statement binds only the tables it reaches, through the views it
names, which is nuthatch's own rule (#896), and the view bodies are cut from `views/*.sql` exactly as
nuthatch cuts them.

`src/js_store.rs` is an object store whose bytes come from two JavaScript functions, `size(key)` and
`read(key, offset, length)`. In a page that is a range request; in Node, a file read.

Burrmill needed these to run in a tab, all on its `pete/wasm` branch and none changing native
behaviour: tokio's runtime made native-only; an async query path driven by the page's event loop; an
engine opened from an object store; planning inline rather than on an 8 MiB thread, the module linking
an 8 MiB stack instead; one rayon pool per tab; the clock read through `Date`; and partitions
coalesced one after another, since a `UNION ALL` has a partition per arm however few are asked for and
DataFusion would spawn a task for each.

## Where it stands

The Lodestar nest (`graph-allocations-nest`, dataset `d6fd43c8…`, 4,745 segments, 6.0 M rows,
500 MB) answers all 23 authored views in wasm, each identical as a multiset of nuthatch-encoded rows
to the same code run natively (`bench/wasm-alloc.json`, `bench/native-alloc.jsonl`).

The DuckDB-Wasm comparison binds each table as nuthatch 4.0.2 bound it under DuckDB, only the tables
the statement reaches, and encodes DuckDB's Arrow with the same nuthatch encoder, so the comparison is
between engines and not between encoders (`bench/duckdb.mjs`).

| | burrmill-wasm | DuckDB-Wasm 1.33.1-dev57.0 (eh) |
|---|---:|---:|
| module, brotli | 6.9 MB | 5.3 MB |

## Building

```
brew install llvm          # zstd-sys needs a clang with the WebAssembly backend; Apple's has none
scripts/build.sh           # pkg/web and pkg/node; BURRMILL=<path> builds against a local burrmill
node bench/node.mjs data/alloc
node bench/duckdb.mjs data/alloc   # after npm install in bench/duckdb
cargo run --release --example native -- data/alloc
```

`data/` is the mirror's layout, fetched from the R2 bucket by content address; it is not committed.

## Not yet

- The mirror sends no CORS headers and refuses the preflight, so a page on another origin cannot read
  it. It needs a GET-only CORS rule on the bucket.
- Nothing yet checks a segment against its content address in the tab.
- Comparison with a live nuthatch's own answers, as against Burrmill natively, is not yet run.
