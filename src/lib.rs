//! Burrmill compiled for a browser tab. `nest` is the work and runs on both targets; the rest is the
//! JavaScript surface.

pub mod nest;

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
            let mut nest = self.0.try_lock().ok_or_else(|| err("a statement is running"))?;
            Ok(nest.add_views(sql))
        }

        pub fn tables(&self) -> Result<Vec<String>, JsError> {
            let nest = self.0.try_lock().ok_or_else(|| err("a statement is running"))?;
            Ok(nest.tables())
        }

        pub fn views(&self) -> Result<Vec<String>, JsError> {
            let nest = self.0.try_lock().ok_or_else(|| err("a statement is running"))?;
            Ok(nest.views())
        }

        /// Rows as nuthatch's `/sql` encodes them: a JSON array of objects, as text.
        pub fn query(&self, sql: String) -> Promise {
            let nest = Rc::clone(&self.0);
            future_to_promise(async move {
                let mut nest = nest.lock().await;
                let rows = nest.query(&sql).await.map_err(|e| JsValue::from(err(e)))?;
                let text = serde_json::to_string(&rows).map_err(|e| JsValue::from(err(e)))?;
                Ok(JsValue::from_str(&text))
            })
        }
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
                let rows = nest.query(&sql).await.map_err(|e| JsValue::from(err(e)))?;
                let mut text = String::new();
                for r in &rows {
                    text.push_str(&serde_json::to_string(r).map_err(|e| JsValue::from(err(e)))?);
                    text.push('\n');
                }
                Ok(JsValue::from_str(&text))
            })
        }
    }

    fn err(e: impl std::fmt::Display) -> JsError {
        JsError::new(&e.to_string())
    }
}
