//! An object store whose bytes come from JavaScript: `size(key)` and `read(key, offset, length)`,
//! each answering a promise. Over HTTP that is a range request; in Node, a file read; with a cache,
//! whatever the cache holds. Read-only, and nothing is listed: the manifest names every key.

use std::fmt;
use std::ops::Range;

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use futures::stream::BoxStream;
use js_sys::{Function, Promise, Uint8Array};
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetRange, GetResult, GetResultPayload, ListResult, MultipartUpload,
    ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions, PutPayload, PutResult, Result,
};
use send_wrapper::SendWrapper;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

const NAME: &str = "JsStore";

/// A tab has one thread, so wrapping its JavaScript handles as `Send` is sound there and only there.
pub struct JsStore {
    size: SendWrapper<Function>,
    read: SendWrapper<Function>,
}

impl JsStore {
    pub fn new(size: Function, read: Function) -> Self {
        Self {
            size: SendWrapper::new(size),
            read: SendWrapper::new(read),
        }
    }

    async fn size_of(&self, key: &str) -> Result<u64> {
        let promise = self.size.call1(&JsValue::NULL, &JsValue::from_str(key));
        let n = SendWrapper::new(settle(promise)).await?;
        n.as_f64()
            .map(|n| n as u64)
            .ok_or_else(|| generic(format!("size({key}) did not answer a number")))
    }

    async fn read_range(&self, key: &str, range: Range<u64>) -> Result<Bytes> {
        let promise = self.read.call3(
            &JsValue::NULL,
            &JsValue::from_str(key),
            &JsValue::from_f64(range.start as f64),
            &JsValue::from_f64((range.end - range.start) as f64),
        );
        let got = SendWrapper::new(settle(promise)).await?;
        let bytes = got
            .dyn_into::<Uint8Array>()
            .map_err(|_| generic(format!("read({key}) did not answer a Uint8Array")))?;
        if bytes.length() as u64 != range.end - range.start {
            return Err(generic(format!(
                "read({key}, {}, {}) answered {} bytes",
                range.start,
                range.end - range.start,
                bytes.length()
            )));
        }
        Ok(Bytes::from(bytes.to_vec()))
    }
}

async fn settle(called: std::result::Result<JsValue, JsValue>) -> Result<JsValue> {
    let value = called.map_err(js_err)?;
    let promise: Promise = Promise::resolve(&value);
    JsFuture::from(promise).await.map_err(js_err)
}

fn js_err(e: JsValue) -> object_store::Error {
    generic(e.as_string().unwrap_or_else(|| format!("{e:?}")))
}

fn generic(msg: String) -> object_store::Error {
    object_store::Error::Generic {
        store: NAME,
        source: msg.into(),
    }
}

fn unsupported(operation: &str) -> object_store::Error {
    object_store::Error::NotImplemented {
        operation: operation.into(),
        implementer: NAME.into(),
    }
}

impl fmt::Display for JsStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(NAME)
    }
}

impl fmt::Debug for JsStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(NAME)
    }
}

#[async_trait]
impl ObjectStore for JsStore {
    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        let key = location.as_ref();
        let size = SendWrapper::new(self.size_of(key)).await?;
        let meta = ObjectMeta {
            location: location.clone(),
            last_modified: Default::default(),
            size,
            e_tag: None,
            version: None,
        };
        let range = match &options.range {
            None => 0..size,
            Some(GetRange::Bounded(r)) => r.start..r.end.min(size),
            Some(GetRange::Offset(o)) => *o..size,
            Some(GetRange::Suffix(n)) => size.saturating_sub(*n)..size,
        };
        if range.start > range.end || (range.start >= size && size > 0) {
            return Err(generic(format!("{key}: range {range:?} outside {size} bytes")));
        }
        let payload = if options.head || range.is_empty() {
            futures::stream::empty().boxed()
        } else {
            let bytes = SendWrapper::new(self.read_range(key, range.clone())).await?;
            futures::stream::once(async move { Ok(bytes) }).boxed()
        };
        Ok(GetResult {
            payload: GetResultPayload::Stream(payload),
            meta,
            range,
            attributes: Default::default(),
        })
    }

    async fn get_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        let key = location.as_ref();
        let reads = ranges.iter().map(|r| self.read_range(key, r.clone()));
        SendWrapper::new(futures::future::try_join_all(reads)).await
    }

    async fn put_opts(&self, _: &Path, _: PutPayload, _: PutOptions) -> Result<PutResult> {
        Err(unsupported("put_opts"))
    }

    async fn put_multipart_opts(
        &self,
        _: &Path,
        _: PutMultipartOptions,
    ) -> Result<Box<dyn MultipartUpload>> {
        Err(unsupported("put_multipart_opts"))
    }

    fn delete_stream(
        &self,
        _: BoxStream<'static, Result<Path>>,
    ) -> BoxStream<'static, Result<Path>> {
        futures::stream::once(async { Err(unsupported("delete_stream")) }).boxed()
    }

    fn list(&self, _: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        futures::stream::once(async { Err(unsupported("list")) }).boxed()
    }

    async fn list_with_delimiter(&self, _: Option<&Path>) -> Result<ListResult> {
        Err(unsupported("list_with_delimiter"))
    }

    async fn copy_opts(&self, _: &Path, _: &Path, _: CopyOptions) -> Result<()> {
        Err(unsupported("copy_opts"))
    }
}
