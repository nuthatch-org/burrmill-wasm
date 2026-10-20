//! The same `Nest` natively, over the same mirrored files, for the digests `bench/node.mjs` prints.
//! Usage: cargo run --release --example native -- data/alloc [view]

use std::sync::Arc;
use std::time::Instant;

use burrmill_wasm::nest::Nest;
use object_store::local::LocalFileSystem;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::fs::canonicalize(args.next().unwrap_or_else(|| "data/alloc".into())).unwrap();
    let only = args.next();
    let read = |f: &str| std::fs::read_to_string(dir.join(f));
    let manifest = read("manifest.json").unwrap();
    let schema = read("schema.json").ok();
    let mut files: Vec<_> = std::fs::read_dir(dir.join("views"))
        .map(|d| d.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().is_some_and(|x| x == "sql"));
    files.sort();
    let store = Arc::new(LocalFileSystem::new_with_prefix(&dir).unwrap());
    let open = || {
        let mut n = Nest::open(store.clone(), "", &manifest, schema.as_deref(), None).unwrap();
        for f in &files {
            n.add_views(&std::fs::read_to_string(f).unwrap());
        }
        n
    };
    for v in open().views() {
        if only.as_ref().is_some_and(|o| *o != v) {
            continue;
        }
        let mut nest = open();
        let sql = format!("SELECT * FROM \"{v}\"");
        let t = Instant::now();
        let got = futures::executor::block_on(nest.query_text(&sql, false));
        let cold = t.elapsed().as_millis();
        let line = match got {
            Ok(text) => {
                let mut lines: Vec<&str> = text.lines().collect();
                // Order-free, as bench/node.mjs hashes: sorted rows, joined by newlines.
                lines.sort();
                let text = lines.join("\n");
                let t = Instant::now();
                futures::executor::block_on(nest.query_text(&sql, false)).unwrap();
                let warm = t.elapsed().as_millis();
                let digest = sha256_16(text.as_bytes());
                format!(
                    r#"{{"view":"{v}","rows":{},"cold_ms":{cold},"warm_ms":{warm},"digest":"{digest}"}}"#,
                    lines.len()
                )
            }
            Err(e) => format!(
                r#"{{"view":"{v}","err":{}}}"#,
                serde_json::to_string(&e).unwrap()
            ),
        };
        println!("{line}");
    }
}

fn sha256_16(bytes: &[u8]) -> String {
    use sha2::Digest;
    let d = sha2::Sha256::digest(bytes);
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}
