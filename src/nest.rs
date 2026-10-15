//! A published nest, bound as nuthatch binds it, one table at a time and only when a statement
//! reaches it.
//!
//! The mirror holds what this needs: `manifest.json` (each table's segments by content address),
//! `schema.json` (each table's declared columns) and the segments at `<table>/<hash>.parquet`. The
//! authored views come from the nest's repository at the published commit.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use burrmill::Engine;
use object_store::ObjectStore;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
struct Manifest {
    tables: BTreeMap<String, Vec<Segment>>,
}

#[derive(Debug, Deserialize)]
struct Segment {
    hash: String,
}

#[derive(Debug, Deserialize)]
struct SchemaDoc {
    #[serde(default)]
    tables: Vec<TableSchema>,
}

#[derive(Debug, Deserialize)]
struct TableSchema {
    table: String,
    #[serde(default)]
    columns: Vec<Column>,
}

#[derive(Debug, Deserialize)]
struct Column {
    name: String,
    storage: String,
}

pub struct Nest {
    engine: Engine,
    store: Arc<dyn ObjectStore>,
    /// Prepended to every key: the dataset's directory in the store.
    prefix: String,
    segments: BTreeMap<String, Vec<String>>,
    declared: BTreeMap<String, Vec<(String, String)>>,
    /// In load order, lowercased names: a view builds only on views before it.
    views: Vec<(String, String)>,
    bound: BTreeSet<String>,
    defined: BTreeSet<String>,
}

pub type Result<T> = std::result::Result<T, String>;

impl Nest {
    pub fn open(
        store: Arc<dyn ObjectStore>,
        prefix: &str,
        manifest: &str,
        schema: Option<&str>,
    ) -> Result<Self> {
        let manifest: Manifest =
            serde_json::from_str(manifest).map_err(|e| format!("manifest.json: {e}"))?;
        let declared = match schema {
            Some(s) => serde_json::from_str::<SchemaDoc>(s)
                .map_err(|e| format!("schema.json: {e}"))?
                .tables
                .into_iter()
                .map(|t| {
                    let cols = t.columns.into_iter().map(|c| (c.name, c.storage)).collect();
                    (t.table, cols)
                })
                .collect(),
            None => BTreeMap::new(),
        };
        let engine = Engine::open_empty().map_err(|e| e.to_string())?;
        engine
            .attach_store(Arc::clone(&store))
            .map_err(|e| e.to_string())?;
        let prefix = match prefix.trim_matches('/') {
            "" => String::new(),
            p => format!("{p}/"),
        };
        Ok(Self {
            engine,
            store,
            prefix,
            segments: manifest
                .tables
                .into_iter()
                .map(|(t, segs)| (t, segs.into_iter().map(|s| s.hash).collect()))
                .collect(),
            declared,
            views: Vec::new(),
            bound: BTreeSet::new(),
            defined: BTreeSet::new(),
        })
    }

    /// One `views/*.sql` file, added after those before it, as nuthatch loads them.
    pub fn add_views(&mut self, sql: &str) -> usize {
        let before = self.views.len();
        for stmt in split_sql_statements(sql) {
            if let (Some(name), Some(body)) = (view_name(&stmt), view_body(&stmt)) {
                self.views.push((name, body.to_string()));
            }
        }
        self.views.len() - before
    }

    pub fn tables(&self) -> Vec<String> {
        let mut t: BTreeSet<String> = self.segments.keys().cloned().collect();
        t.extend(self.declared.keys().cloned());
        t.into_iter().collect()
    }

    pub fn views(&self) -> Vec<String> {
        self.views.iter().map(|(n, _)| n.clone()).collect()
    }

    /// Rows as nuthatch's `/sql` encodes them, one JSON object each.
    pub async fn query(&mut self, sql: &str) -> Result<Vec<Value>> {
        let mut rows = Vec::new();
        self.query_each(sql, |r| {
            rows.push(r);
            Ok(())
        })
        .await?;
        Ok(rows)
    }

    /// As `query`, written out as text, one row per line or as a JSON array. Each batch is encoded
    /// as it arrives and dropped, so the text is the only copy of the answer the tab holds: holding
    /// every row as a `Value` first took one view to 3.75 GiB of a 4 GiB address space.
    pub async fn query_text(&mut self, sql: &str, array: bool) -> Result<String> {
        let mut text = String::from(if array { "[" } else { "" });
        let mut first = true;
        self.query_each(sql, |r| {
            if array && !first {
                text.push(',');
            }
            first = false;
            text.push_str(&serde_json::to_string(&r).map_err(|e| e.to_string())?);
            if !array {
                text.push('\n');
            }
            Ok(())
        })
        .await?;
        if array {
            text.push(']');
        }
        Ok(text)
    }

    async fn query_each(&mut self, sql: &str, mut f: impl FnMut(Value) -> Result<()>) -> Result<()> {
        self.prepare(sql).await?;
        let mut failed = None;
        let mut each = |b: arrow::record_batch::RecordBatch| {
            for r in burrmill::df::encode::rows(&b)? {
                if let Err(e) = f(r) {
                    failed = Some(e);
                    return Err(burrmill::BurrmillError::Cancelled);
                }
            }
            Ok(())
        };
        #[cfg(target_arch = "wasm32")]
        let out = self.engine.sql_async_for_each(sql, &mut each).await;
        #[cfg(not(target_arch = "wasm32"))]
        let out = self.engine.sql_for_each(sql, &mut each);
        match (out, failed) {
            (_, Some(e)) => Err(e),
            (r, None) => r.map_err(|e| e.to_string()),
        }
    }

    /// Bind every table `sql` reaches, through the views it names, then define those views.
    async fn prepare(&mut self, sql: &str) -> Result<()> {
        let (tables, views) = self.reach(sql)?;
        for t in tables {
            if self.bound.contains(&t) {
                continue;
            }
            let keys = self.keys(&t).await?;
            let declared = self.declared.get(&t).cloned().unwrap_or_default();
            self.engine
                .register_store_facts(&t, &declared, keys, &[], (None, None))
                .await
                .map_err(|e| format!("{t}: {e}"))?;
            self.bound.insert(t);
        }
        for (name, body) in &self.views {
            if views.contains(name) && !self.defined.contains(name) {
                self.engine
                    .register_view(name, body)
                    .map_err(|e| format!("view {name}: {e}"))?;
                self.defined.insert(name.clone());
            }
        }
        Ok(())
    }

    /// The nest tables and authored views `sql` reaches, views widened to what they read.
    pub fn reach(&self, sql: &str) -> Result<(BTreeSet<String>, BTreeSet<String>)> {
        let names = burrmill::inspect::base_tables(sql)
            .ok_or_else(|| "not one parseable query".to_string())?;
        let mut frontier: Vec<String> = names.into_iter().collect();
        let (mut tables, mut views) = (BTreeSet::new(), BTreeSet::new());
        while let Some(n) = frontier.pop() {
            if let Some((_, body)) = self.views.iter().find(|(v, _)| *v == n) {
                if views.insert(n) {
                    frontier.extend(burrmill::inspect::base_tables(body).unwrap_or_default());
                }
            } else if self.segments.contains_key(&n) || self.declared.contains_key(&n) {
                tables.insert(n);
            }
        }
        Ok((tables, views))
    }

    /// Each segment's key and size, the sizes asked for together.
    async fn keys(&self, table: &str) -> Result<Vec<(String, u64)>> {
        let hashes = self.segments.get(table).map(Vec::as_slice).unwrap_or(&[]);
        let heads = hashes.iter().map(|h| {
            let key = format!("{}{table}/{h}.parquet", self.prefix);
            let store = Arc::clone(&self.store);
            async move {
                let path = object_store::path::Path::from(key.as_str());
                let meta = object_store::ObjectStoreExt::head(&store, &path)
                    .await
                    .map_err(|e| format!("{key}: {e}"))?;
                Ok::<_, String>((key, meta.size))
            }
        });
        futures::future::try_join_all(heads).await
    }

}

/// nuthatch's `split_sql_statements`: on `;` outside quotes, `--` comments dropped.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut in_s, mut in_d, mut in_c) = (false, false, false);
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        if in_c {
            if c == '\n' {
                in_c = false;
                cur.push(c);
            }
            continue;
        }
        match c {
            '-' if !in_s && !in_d && chars.peek() == Some(&'-') => {
                in_c = true;
                continue;
            }
            '\'' if !in_d => in_s = !in_s,
            '"' if !in_s => in_d = !in_d,
            ';' if !in_s && !in_d => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

/// nuthatch's `view_body`: the text after the first whole-word `as` past `view`.
fn view_body(create_view_sql: &str) -> Option<&str> {
    let lower = create_view_sql.to_ascii_lowercase();
    let (_, view_end) = find_keyword(&lower, "view", 0)?;
    let (_, as_end) = find_keyword(&lower, "as", view_end)?;
    Some(create_view_sql[as_end..].trim())
}

/// nuthatch's `view_name`, lowercased.
fn view_name(create_view_sql: &str) -> Option<String> {
    let lower = create_view_sql.to_ascii_lowercase();
    let (_, view_end) = find_keyword(&lower, "view", 0)?;
    let (as_at, _) = find_keyword(&lower, "as", view_end)?;
    let name = lower[view_end..as_at].trim().trim_matches('"').trim();
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .then(|| name.to_string())
}

fn find_keyword(haystack: &str, word: &str, from: usize) -> Option<(usize, usize)> {
    let bytes = haystack.as_bytes();
    let mut at = from;
    while let Some(i) = haystack[at..].find(word) {
        let start = at + i;
        let end = start + word.len();
        let before_ok = start > 0 && bytes[start - 1].is_ascii_whitespace();
        let after_ok = end < bytes.len() && bytes[end].is_ascii_whitespace();
        if before_ok && after_ok {
            return Some((start, end));
        }
        at = end;
    }
    None
}
