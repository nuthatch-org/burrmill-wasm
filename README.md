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
to the same code run natively (`bench/wasm-alloc.jsonl`, `bench/native-alloc.jsonl`).

The DuckDB-Wasm comparison binds each table as nuthatch 4.0.2 bound it under DuckDB, only the tables
the statement reaches, and encodes DuckDB's Arrow with the same nuthatch encoder, so the comparison is
between engines and not between encoders (`bench/duckdb.mjs`).

In Node, from local disk, one process per view so each cold run is genuinely cold. DuckDB-Wasm is
1.33.1-dev57.0, the eh bundle; ours is timed with the nuthatch encoding in it and DuckDB without, so
the comparison leans DuckDB's way. Every view DuckDB answered, it answered identically.

| view | rows | burrmill-wasm cold / warm | DuckDB-Wasm cold / warm | Burrmill native cold / warm |
|---|---:|---:|---:|---:|
| `deployment_signal` | 14,992 | 224 ms / 42 ms | 181 ms / 24 ms | 26 ms / 12 ms |
| `epoch_boundaries` | 0 | 378 ms / 167 ms | 990 ms / 365 ms | 149 ms / 33 ms |
| `lodestar_allocations` | 290,746 | 1.9 s / 1.3 s | 3.1 s / 1.7 s | 574 ms / 535 ms |
| `lodestar_curator_signals` | 16,188 | 922 ms / 439 ms | 3.9 s / 1.6 s | 137 ms / 74 ms |
| `lodestar_curators` | 1,834 | 250 ms / 62 ms | 208 ms / 42 ms | 15 ms / 8 ms |
| `lodestar_delegations` | 606,557 | 897 ms / 653 ms | 860 ms / 457 ms | 264 ms / 294 ms |
| `lodestar_delegator_positions` | 322,883 | 2.0 s / 1.2 s | 2.6 s / 2.2 s | 342 ms / 374 ms |
| `lodestar_delegator_stakes` | 322,883 | 4.9 s / 4.0 s | 14.0 s / 7.5 s | 737 ms / 715 ms |
| `lodestar_delegators` | 309,742 | 1.4 s / 881 ms | 2.7 s / 2.2 s | 206 ms / 216 ms |
| `lodestar_deployments` | 25,259 | 2.0 s / 1.3 s | 7.1 s / 3.2 s | 294 ms / 217 ms |
| `lodestar_disputes` | 0 | 149 ms / 7 ms | 39 ms / 1 ms | 4 ms / 1 ms |
| `lodestar_epochs` | 0 | 924 ms / 323 ms | 14.0 s / 7.1 s | 273 ms / 103 ms |
| `lodestar_escrow_transactions` | 86,391 | 304 ms / 133 ms | 233 ms / 61 ms | 69 ms / 64 ms |
| `lodestar_indexer_daily` | 20,207 | 5.2 s / 4.3 s | 15.5 s / 7.6 s | 675 ms / 494 ms |
| `lodestar_indexer_deployment_daily` | 846,992 | 6.3 s / 5.3 s | 13.0 s / 7.7 s | 1.1 s / 1.2 s |
| `lodestar_indexer_ledger` | 1,718,370 | 4.9 s / 4.1 s | no answer in 1 h | 1.4 s / 1.6 s |
| `lodestar_indexer_pool` | 143 | 3.4 s / 2.7 s | 9.1 s / 5.0 s | 422 ms / 346 ms |
| `lodestar_indexers` | 185 | 4.4 s / 3.5 s | 21.5 s / 10.1 s | 717 ms / 477 ms |
| `lodestar_network` | 1 | 5.7 s / 4.7 s | 43.3 s / 16.8 s | 1.0 s / 796 ms |
| `lodestar_network_params` | 0 | 338 ms / 61 ms | 1.6 s / 466 ms | 57 ms / 17 ms |
| `lodestar_provisions` | 72 | 1.1 s / 548 ms | 3.7 s / 1.5 s | 151 ms / 84 ms |
| `open_allocations` | 7,573 | 292 ms / 90 ms | 555 ms / 199 ms | 66 ms / 23 ms |
| `port_queue` | 3,848 | 470 ms / 234 ms | 701 ms / 217 ms | 54 ms / 33 ms |

Over the 22 both answered, burrmill-wasm took 43.6 s cold and 32.0 s warm against DuckDB's 158.8 s
and 76.1 s. DuckDB is quicker on five of the small views, by 200 ms at most. `lodestar_indexer_ledger`
ran for an hour under DuckDB, 3,554 s of CPU at 1.07 GiB resident, and was stopped without an answer;
burrmill-wasm returns its 1.7 M rows in 4.9 s at 963 MiB of wasm memory. Native Burrmill is 2 to 8
times quicker again than the wasm build.

In Chrome, over HTTP with 40 ms injected latency, `lodestar_curators`: burrmill-wasm 1.1 s cold and
213 ms warm, in 52 requests, each segment fetched whole and checked against its content address;
DuckDB-Wasm 10.1 s and 2.4 s, in 208 requests cold and 52 again warm. Same answer. The local server
speaks HTTP/1.1, six connections, which understates parallel fetching against R2's HTTP/2.

| | burrmill-wasm | DuckDB-Wasm (eh) |
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
- The mirror holds sealed segments only, so a tab sees a nest up to `sealed_through`.
- The browser figures are one view; all 23 in Chrome, and a second visit served from OPFS, are not yet measured.
- Comparison with a live nuthatch's own answers, as against Burrmill natively, is not yet run.
