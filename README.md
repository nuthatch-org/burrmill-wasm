# burrmill-wasm

Burrmill, nuthatch's query engine, compiled to `wasm32-unknown-unknown` and run in a browser tab.

The aim is a static page that is a nest client: it fetches a nest's sealed, content-addressed Parquet
segments over HTTP (the R2 mirror, or any operator's), checks each against its hash, and answers the
nest's authored views in the tab. No server, no account, nothing to phone home to.

The bar is DuckDB-Wasm on nuthatch's own workload, not in general: the authored views of real
nests, byte-identical answers, cold and warm time, bytes fetched, and the bundle a visitor downloads.

Status: spike. Burrmill's default graph builds for wasm32; the DataFusion engine does not yet.
