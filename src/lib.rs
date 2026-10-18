//! Burrmill compiled for a browser tab. `nest` is the work and runs on both targets; the rest is the
//! JavaScript surface.

mod civil;
pub mod chain;
pub mod nest;
pub mod receipts;
pub mod sealer;
pub mod tail;

#[cfg(target_arch = "wasm32")]
mod js_store;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use std::rc::Rc;
    use std::sync::Arc;

    use futures::lock::Mutex;
    use js_sys::{Function, Promise};
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::future_to_promise;

    use crate::js_store::JsStore;
    use crate::nest::Nest;

    /// A published nest. Statements run one at a time, in the order they were asked.
    #[wasm_bindgen(js_name = Nest)]
    pub struct JsNest(Rc<Mutex<Nest>>);

    #[wasm_bindgen(js_class = Nest)]
    impl JsNest {
        /// `size(key)` and `read(key, offset, length)` answer promises of a number and of a
        /// `Uint8Array`. `prefix` is the dataset's directory in that store.
        #[wasm_bindgen(constructor)]
        pub fn new(
            size: Function,
            read: Function,
            prefix: &str,
            manifest: &str,
            schema: Option<String>,
        ) -> Result<JsNest, JsError> {
            let store = Arc::new(JsStore::new(size, read));
            let nest = Nest::open(store, prefix, manifest, schema.as_deref()).map_err(err)?;
            Ok(JsNest(Rc::new(Mutex::new(nest))))
        }

        /// One `views/*.sql` file, in load order. Answers how many views it declared.
        #[wasm_bindgen(js_name = addViews)]
        pub fn add_views(&self, sql: &str) -> Result<usize, JsError> {
            let mut nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            Ok(nest.add_views(sql))
        }

        pub fn tables(&self) -> Result<Vec<String>, JsError> {
            let nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            Ok(nest.tables())
        }

        pub fn views(&self) -> Result<Vec<String>, JsError> {
            let nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            Ok(nest.views())
        }

        /// The nest tables and authored views `sql` reaches, as `[tables, views]`: what this binds
        /// before running it, for another engine to be given the same.
        pub fn reach(&self, sql: &str) -> Result<Vec<js_sys::Array>, JsError> {
            let nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            let (tables, views) = nest.reach(sql).map_err(err)?;
            let arr = |s: std::collections::BTreeSet<String>| {
                s.into_iter().map(JsValue::from).collect::<js_sys::Array>()
            };
            Ok(vec![arr(tables), arr(views)])
        }

        /// Rows as nuthatch's `/sql` encodes them: a JSON array of objects, as text.
        pub fn query(&self, sql: String) -> Promise {
            let nest = Rc::clone(&self.0);
            future_to_promise(async move {
                let mut nest = nest.lock().await;
                let text = nest
                    .query_text(&sql, true)
                    .await
                    .map_err(|e| JsValue::from(err(e)))?;
                Ok(JsValue::from_str(&text))
            })
        }
    }

    #[wasm_bindgen(js_class = Nest)]
    impl JsNest {
        /// Each table's last sealed block on the mirror, as a JSON object.
        pub fn covered(&self) -> Result<String, JsError> {
            let nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            serde_json::to_string(&nest.covered()).map_err(err)
        }

        /// Replace the unsealed rows with `rows` (a JSON object of table to rows, as `Decoder`
        /// answers them). Answers how many rows were past their table's last seal and kept.
        #[wasm_bindgen(js_name = setTail)]
        pub fn set_tail(&self, rows: &str) -> Result<usize, JsError> {
            let mut nest = self
                .0
                .try_lock()
                .ok_or_else(|| err("a statement is running"))?;
            let rows = serde_json::from_str(rows).map_err(err)?;
            Ok(nest.set_tail(rows))
        }
    }

    /// nuthatch's decoder for one nest, built from its `nuthatch.toml` and ABI files.
    #[wasm_bindgen(js_name = Decoder)]
    pub struct JsDecoder(crate::tail::Decoder);

    #[wasm_bindgen(js_class = Decoder)]
    impl JsDecoder {
        /// `abis` is a JSON object of each ABI path the config names to that file's text.
        #[wasm_bindgen(constructor)]
        pub fn new(config: &str, abis: &str) -> Result<JsDecoder, JsError> {
            let abis = serde_json::from_str(abis).map_err(err)?;
            Ok(JsDecoder(
                crate::tail::Decoder::from_nest(config, &abis).map_err(err)?,
            ))
        }

        /// The `eth_getLogs` filter, without its block range, as JSON.
        pub fn filter(&self) -> String {
            self.0.filter().to_string()
        }

        pub fn timestamps(&self) -> bool {
            self.0.timestamps()
        }

        /// `logs` as `eth_getLogs` returns them and `times` a JSON object of block number to unix
        /// seconds. Answers `{rows, logs, undecoded, removed}` as JSON.
        pub fn decode(&self, logs: &str, times: &str) -> Result<String, JsError> {
            let logs: Vec<serde_json::Value> = serde_json::from_str(logs).map_err(err)?;
            let times: std::collections::HashMap<String, u64> =
                serde_json::from_str(times).map_err(err)?;
            let times = times
                .into_iter()
                .filter_map(|(k, v)| Some((k.parse().ok()?, v)))
                .collect();
            let out = self.0.decode(&logs, &times).map_err(err)?;
            serde_json::to_string(&out).map_err(err)
        }
    }

    /// The tab's sealer for one nest, resumed from its seed snapshot. Block numbers cross as numbers,
    /// which hold them exactly below 2^53.
    #[wasm_bindgen(js_name = Sealer)]
    pub struct JsSealer {
        sealer: crate::sealer::Sealer,
        last: Vec<crate::sealer::Sealed>,
    }

    #[wasm_bindgen(js_class = Sealer)]
    impl JsSealer {
        #[wasm_bindgen(constructor)]
        pub fn new(watermark: f64, seal_span: f64) -> JsSealer {
            JsSealer {
                sealer: crate::sealer::Sealer::new(watermark as u64, seal_span as u64),
                last: Vec::new(),
            }
        }

        pub fn watermark(&self) -> f64 {
            self.sealer.watermark() as f64
        }

        #[wasm_bindgen(js_name = addTail)]
        pub fn add_tail(
            &mut self,
            table: &str,
            from_block: f64,
            to_block: f64,
            bytes: Vec<u8>,
            hash: &str,
        ) -> Result<(), JsError> {
            self.sealer
                .add_tail(table, from_block as u64, to_block as u64, bytes, hash)
                .map_err(err)
        }

        pub fn clear(&mut self) {
            self.sealer.clear();
        }

        /// `rows` as `Decoder` answers them. Answers how many were new.
        pub fn push(&mut self, rows: &str) -> Result<usize, JsError> {
            let rows = serde_json::from_str(rows).map_err(err)?;
            self.sealer.push(&rows).map_err(err)
        }

        /// Seal through `ceiling`. Answers the segments as a JSON array; `bytes(i)` is the i-th's file.
        pub fn seal(&mut self, ceiling: f64) -> Result<String, JsError> {
            self.last = self.sealer.seal(ceiling as u64).map_err(err)?;
            serde_json::to_string(&self.last).map_err(err)
        }

        /// How many segments `seal(ceiling)` would write, without writing them: whether there is
        /// anything to verify the chain for.
        pub fn reach(&self, ceiling: f64) -> Result<usize, JsError> {
            Ok(self.sealer.clone().seal(ceiling as u64).map_err(err)?.len())
        }

        pub fn bytes(&self, i: usize) -> Option<Vec<u8>> {
            self.last.get(i).map(|s| s.bytes.clone())
        }
    }

    /// `headers` (a JSON array as `eth_getBlockByNumber` answers them) linked down from `top`, a block
    /// hash the light client verified. Answers each block's hash by number, as JSON.
    #[wasm_bindgen(js_name = verifyChain)]
    pub fn verify_chain(headers: &str, top: &str) -> Result<String, JsError> {
        let headers: Vec<serde_json::Value> = serde_json::from_str(headers).map_err(err)?;
        let top = top.parse().map_err(err)?;
        let chain = crate::chain::verify(&headers, top).map_err(err)?;
        serde_json::to_string(&chain).map_err(err)
    }

    /// A block's receipts (a JSON array as `eth_getBlockReceipts` answers them) checked against `root`,
    /// a verified header's `receiptsRoot`. Answers all the block's logs in order, as JSON.
    #[wasm_bindgen(js_name = verifyReceipts)]
    pub fn verify_receipts(receipts: &str, root: &str) -> Result<String, JsError> {
        let receipts: Vec<serde_json::Value> = serde_json::from_str(receipts).map_err(err)?;
        let logs = crate::receipts::verify(&receipts, root.parse().map_err(err)?).map_err(err)?;
        let logs: Vec<_> = logs
            .iter()
            .map(|l| serde_json::json!({ "address": l.address, "topics": l.topics(), "data": l.data.data }))
            .collect();
        serde_json::to_string(&logs).map_err(err)
    }

    /// A panic reaches the console with its message, not as a bare `unreachable`.
    #[wasm_bindgen(start)]
    fn start() {
        console_error_panic_hook::set_once();
    }

    #[wasm_bindgen(js_class = Nest)]
    impl JsNest {
        /// As `query`, one encoded row per line: the exact bytes, for comparing answers without a
        /// JavaScript parse rounding an integer past 2^53.
        #[wasm_bindgen(js_name = queryLines)]
        pub fn query_lines(&self, sql: String) -> Promise {
            let nest = Rc::clone(&self.0);
            future_to_promise(async move {
                let mut nest = nest.lock().await;
                let text = nest
                    .query_text(&sql, false)
                    .await
                    .map_err(|e| JsValue::from(err(e)))?;
                Ok(JsValue::from_str(&text))
            })
        }
    }

    /// Arrow IPC (a stream) encoded as nuthatch's `/sql` encodes rows, one per line: how another
    /// engine's answer is put in the same bytes as this one's, to be compared.
    #[wasm_bindgen(js_name = encodeIpcLines)]
    pub fn encode_ipc_lines(ipc: &[u8]) -> Result<String, JsError> {
        let cursor = std::io::Cursor::new(ipc);
        // DuckDB-Wasm's `runQuery` answers the file format, arrow-js's `tableToIPC` the stream.
        let batches: Box<dyn Iterator<Item = Result<_, arrow::error::ArrowError>>> =
            if ipc.starts_with(b"ARROW1") {
                Box::new(arrow::ipc::reader::FileReader::try_new(cursor, None).map_err(err)?)
            } else {
                Box::new(arrow::ipc::reader::StreamReader::try_new(cursor, None).map_err(err)?)
            };
        let mut text = String::new();
        for batch in batches {
            let batch = batch.map_err(err)?;
            let civil = crate::civil::Columns::of(&batch.schema());
            for mut r in burrmill::df::encode::rows(&batch).map_err(err)? {
                civil.rewrite(&mut r);
                text.push_str(&serde_json::to_string(&r).map_err(err)?);
                text.push('\n');
            }
        }
        Ok(text)
    }

    /// The module's linear memory, for a page that shows what the engine holds.
    #[wasm_bindgen(js_name = wasmMemory)]
    pub fn wasm_memory() -> JsValue {
        wasm_bindgen::memory()
    }

    fn err(e: impl std::fmt::Display) -> JsError {
        JsError::new(&e.to_string())
    }
}
