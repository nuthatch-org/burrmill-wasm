//! Sealing in the tab (RFC-0065 S4): finalized tail rows cut and written to segments by the rule a
//! native nest seals with, so each segment hashes to the one the nest publishes for the same range.
//!
//! A port of the tip path's `maybe_seal` and `seal_range` over rows held in memory rather than a hot
//! store. The rule itself (the cut, the table floors, the bytes) is `nuthatch-seal`'s, not copied.

use std::collections::BTreeMap;

use nuthatch_seal::cut::{CutScan, SEAL_TABLE_FLOOR, aged, block_timestamp, provisional};
use nuthatch_seal::{content_hash, rows_to_batch, segment_rows, sort_rows_for_seal, write_parquet};
use serde_json::Value;

use crate::nest::Result;

/// One segment a seal wrote, or a provisional one the age rule made final without rewriting.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Sealed {
    pub table: String,
    pub hash: String,
    pub from_block: u64,
    pub to_block: u64,
    pub rows: usize,
    pub provisional: bool,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

/// A table's provisional segment, kept as its bytes: the nest folds by reading the file back, so the
/// tab does too.
#[derive(Clone)]
struct Tail {
    from_block: u64,
    to_block: u64,
    bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct Sealer {
    seal_span: u64,
    floor: usize,
    /// Every row at or below this block is sealed, here or on the mirror.
    watermark: u64,
    tails: BTreeMap<String, Tail>,
    /// Rows past the watermark as `(block, log_index, json)`, in that order.
    held: Vec<(u64, u64, String)>,
}

impl Sealer {
    /// Resume from a nest's seal watermark: the seed snapshot's `complete_through`.
    pub fn new(watermark: u64, seal_span: u64) -> Sealer {
        Sealer {
            seal_span,
            floor: SEAL_TABLE_FLOOR,
            watermark,
            tails: BTreeMap::new(),
            held: Vec::new(),
        }
    }

    pub fn watermark(&self) -> u64 {
        self.watermark
    }

    /// A table's provisional tail from the seed snapshot, refused unless it hashes to `hash`.
    pub fn add_tail(
        &mut self,
        table: &str,
        from_block: u64,
        to_block: u64,
        bytes: Vec<u8>,
        hash: &str,
    ) -> Result<()> {
        let got = content_hash(&bytes);
        if got != hash {
            return Err(format!("{table}'s tail hashes to {got}, not {hash}"));
        }
        self.tails.insert(
            table.to_string(),
            Tail {
                from_block,
                to_block,
                bytes,
            },
        );
        Ok(())
    }

    /// Drop every held row: a refresh refetches from the watermark, and rows not yet final may have
    /// been reorged since.
    pub fn clear(&mut self) {
        self.held.clear();
    }

    /// Decoded rows (table to rows, as `Decoder` answers them). Rows at or below the watermark are
    /// dropped, and a row already held is a duplicate unless it differs, which is refused.
    pub fn push(&mut self, rows: &BTreeMap<String, Vec<Value>>) -> Result<usize> {
        let mut added = 0;
        for row in rows.values().flatten() {
            let block = row["block_number"]
                .as_u64()
                .ok_or("a row without block_number")?;
            let index = row["log_index"].as_u64().ok_or("a row without log_index")?;
            if block <= self.watermark {
                continue;
            }
            let json = row.to_string();
            let at = self.held.partition_point(|r| (r.0, r.1) < (block, index));
            match self.held.get(at) {
                Some(r) if (r.0, r.1) == (block, index) => {
                    if r.2 != json {
                        return Err(format!(
                            "block {block} log {index} came back with different content"
                        ));
                    }
                }
                _ => {
                    self.held.insert(at, (block, index, json));
                    added += 1;
                }
            }
        }
        Ok(added)
    }

    /// Seal every cut that is complete at or below `ceiling`, the block both RPCs call finalized.
    pub fn seal(&mut self, ceiling: u64) -> Result<Vec<Sealed>> {
        let mut out = Vec::new();
        let mut from = self.watermark + 1;
        loop {
            if ceiling < from {
                return Ok(out);
            }
            let mut scan = CutScan::new(ceiling, self.seal_span);
            for r in self.held.iter().take_while(|r| r.0 <= ceiling) {
                if !scan.push_at(r.2.len(), r.0) {
                    break;
                }
            }
            if let Some(first) = scan.first()
                && first > from
            {
                self.watermark = first - 1;
                from = first;
            }
            let cut = match scan.cut() {
                None if scan.first().is_none() => {
                    self.watermark = ceiling;
                    return Ok(out);
                }
                None => return Ok(out),
                Some(cut) => cut,
            };
            let n = self.held.partition_point(|r| r.0 <= cut);
            let rows: Vec<String> = self.held.drain(..n).map(|r| r.2).collect();
            self.seal_range(&rows, from, cut, &mut out)?;
            self.watermark = cut;
            from = cut + 1;
        }
    }

    /// `seal::seal_range_with_snapshot`, less the filesystem and the catalogue.
    fn seal_range(
        &mut self,
        json: &[String],
        from: u64,
        to: u64,
        out: &mut Vec<Sealed>,
    ) -> Result<()> {
        let mut by_table: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut cut_time = None;
        for j in json {
            let v: Value = serde_json::from_str(j).map_err(|e| e.to_string())?;
            cut_time = cut_time.max(block_timestamp(&v));
            let table = v
                .get("table")
                .and_then(Value::as_str)
                .unwrap_or("rows")
                .to_string();
            by_table.entry(table).or_default().push(v);
        }
        if by_table.is_empty() {
            return Ok(());
        }
        let touched: Vec<String> = by_table.keys().cloned().collect();
        for (table, mut rows) in by_table {
            sort_rows_for_seal(&mut rows);
            let (rows, from) = match self.tails.remove(&table) {
                None => (rows, from),
                Some(t) => {
                    let mut all = segment_rows(t.bytes.into()).map_err(|e| format!("{e:#}"))?;
                    all.extend(rows);
                    sort_rows_for_seal(&mut all);
                    (all, t.from_block)
                }
            };
            let batch = rows_to_batch(&rows).map_err(|e| format!("{e:#}"))?;
            let bytes = write_parquet(&batch).map_err(|e| format!("{e:#}"))?;
            let hash = content_hash(&bytes);
            let held = provisional(&rows, self.floor, cut_time);
            if held {
                self.tails.insert(
                    table.clone(),
                    Tail {
                        from_block: from,
                        to_block: to,
                        bytes: bytes.clone(),
                    },
                );
            }
            out.push(Sealed {
                table,
                hash,
                from_block: from,
                to_block: to,
                rows: rows.len(),
                provisional: held,
                bytes,
            });
        }
        // A quiet table's tail closes on the age rule at another table's cut, its file unchanged.
        let quiet: Vec<String> = self
            .tails
            .keys()
            .filter(|t| !touched.contains(t))
            .cloned()
            .collect();
        for table in quiet {
            let rows = segment_rows(self.tails[&table].bytes.clone().into())
                .map_err(|e| format!("{e:#}"))?;
            if aged(&rows, cut_time) {
                let t = self.tails.remove(&table).expect("listed above");
                out.push(Sealed {
                    hash: content_hash(&t.bytes),
                    table,
                    from_block: t.from_block,
                    to_block: t.to_block,
                    rows: rows.len(),
                    provisional: false,
                    bytes: t.bytes,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(table: &str, block: u64, index: u64) -> Value {
        json!({"table": table, "block_number": block, "log_index": index, "block_timestamp": 1_700_000_000 + block * 12, "value": "1"})
    }

    fn batch(rows: Vec<Value>) -> BTreeMap<String, Vec<Value>> {
        let mut m: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for r in rows {
            m.entry(r["table"].as_str().unwrap().to_string())
                .or_default()
                .push(r);
        }
        m
    }

    #[test]
    fn nothing_seals_until_the_span_is_finalized() {
        let mut s = Sealer::new(100, 10);
        s.push(&batch((101..=115).map(|b| row("a__x", b, 0)).collect()))
            .unwrap();
        assert!(s.seal(109).unwrap().is_empty());
        let sealed = s.seal(115).unwrap();
        assert_eq!(sealed.len(), 1);
        assert_eq!(
            (sealed[0].from_block, sealed[0].to_block, sealed[0].rows),
            (101, 110, 10)
        );
        assert_eq!(s.watermark(), 110);
    }

    #[test]
    fn a_tail_is_folded_into_its_tables_next_cut() {
        let mut s = Sealer::new(100, 10);
        s.push(&batch((101..=125).map(|b| row("a__x", b, 0)).collect()))
            .unwrap();
        let first = s.seal(115).unwrap();
        assert!(first[0].provisional);
        let second = s.seal(125).unwrap();
        assert_eq!(
            (second[0].from_block, second[0].to_block, second[0].rows),
            (101, 120, 20)
        );

        let mut once = (101..=120).map(|b| row("a__x", b, 0)).collect::<Vec<_>>();
        assert_eq!(
            second[0].bytes,
            nuthatch_seal::seal_rows(&mut once).unwrap()
        );
    }

    /// The current segments after a run of seals: every final one, and each table's latest tail.
    fn current(runs: &[Vec<Sealed>]) -> BTreeMap<(String, bool, u64), String> {
        let mut out = BTreeMap::new();
        for s in runs.iter().flatten() {
            out.retain(|(t, tail, _): &(String, bool, u64), _| !(*tail && *t == s.table));
            out.insert((s.table.clone(), s.provisional, s.to_block), s.hash.clone());
        }
        out
    }

    /// RFC-0066 S2: a tab left open pushes and seals again each time finality moves, and must end
    /// with the segments a single seal to the same block writes, full and tail alike.
    #[test]
    fn sealing_as_finality_moves_matches_one_seal() {
        let rows = |from: u64, to: u64| {
            let mut v = Vec::new();
            for b in from..=to {
                v.extend((0..120).map(|i| row("a__dense", b, i)));
                if b % 7 == 0 {
                    v.push(row("a__sparse", b, 500));
                }
            }
            batch(v)
        };
        let mut once = Sealer::new(100, 10);
        once.push(&rows(101, 145)).unwrap();
        let one = current(&[once.seal(145).unwrap()]);

        let mut steps = Sealer::new(100, 10);
        steps.push(&rows(101, 117)).unwrap();
        let first = steps.seal(117).unwrap();
        steps.push(&rows(118, 145)).unwrap();
        let second = steps.seal(145).unwrap();
        let two = current(&[first, second]);

        assert!(one.keys().any(|(_, tail, _)| !tail) && one.keys().any(|(_, tail, _)| *tail));
        assert_eq!(one, two);
    }

    #[test]
    fn a_row_that_comes_back_different_is_refused() {
        let mut s = Sealer::new(0, 10);
        s.push(&batch(vec![row("a__x", 5, 0)])).unwrap();
        let mut other = row("a__x", 5, 0);
        other["value"] = json!("2");
        assert!(s.push(&batch(vec![other])).is_err());
        assert_eq!(s.push(&batch(vec![row("a__x", 5, 0)])).unwrap(), 0);
    }
}
