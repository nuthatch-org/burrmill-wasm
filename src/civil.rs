//! Dates and timestamps as nuthatch's `/sql` writes them. Burrmill's encoder keeps the DuckDB-era
//! `Debug` text (`Date32(20731)`, `Timestamp(Microsecond, …)`), which nuthatch rewrites after it
//! (#1852, `engine_burrmill.rs`); this is the same rewrite, chosen by Arrow type as there.

use arrow::datatypes::{DataType, Schema};
use serde_json::Value;

#[derive(Clone, Copy)]
enum Temporal {
    Date,
    Timestamp,
}

pub struct Columns(Vec<(String, Temporal)>);

impl Columns {
    pub fn of(schema: &Schema) -> Self {
        Columns(
            schema
                .fields()
                .iter()
                .filter_map(|f| match f.data_type() {
                    DataType::Date32 => Some((f.name().clone(), Temporal::Date)),
                    DataType::Timestamp(..) => Some((f.name().clone(), Temporal::Timestamp)),
                    _ => None,
                })
                .collect(),
        )
    }

    pub fn rewrite(&self, row: &mut Value) {
        let Some(obj) = row.as_object_mut() else {
            return;
        };
        for (name, kind) in &self.0 {
            let Some(Value::String(s)) = obj.get_mut(name) else {
                continue;
            };
            let civil = match kind {
                Temporal::Date => iso_date(s),
                Temporal::Timestamp => rfc3339(s),
            };
            if let Some(civil) = civil {
                *s = civil;
            }
        }
    }
}

fn iso_date(debug: &str) -> Option<String> {
    let days: i64 = debug
        .strip_prefix("Date32(")?
        .strip_suffix(')')?
        .parse()
        .ok()?;
    let (y, m, d) = civil_from_days(days);
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn rfc3339(debug: &str) -> Option<String> {
    let (unit, ticks) = debug
        .strip_prefix("Timestamp(")?
        .strip_suffix(')')?
        .split_once(", ")?;
    let ticks: i64 = ticks.parse().ok()?;
    let digits = match unit {
        "Second" => 0,
        "Millisecond" => 3,
        "Microsecond" => 6,
        "Nanosecond" => 9,
        _ => return None,
    };
    let per_sec = 10i64.pow(digits);
    let (secs, frac) = (ticks.div_euclid(per_sec), ticks.rem_euclid(per_sec));
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let mut out = format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    );
    if frac != 0 {
        let f = format!("{frac:0width$}", width = digits as usize);
        out.push('.');
        out.push_str(f.trim_end_matches('0'));
    }
    out.push('Z');
    Some(out)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u32;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    // nuthatch's own cases, from engine_burrmill.rs.
    #[test]
    fn renders_as_nuthatch_does() {
        for (debug, want) in [
            ("Timestamp(Second, 1791203696)", "2026-10-05T12:34:56Z"),
            (
                "Timestamp(Millisecond, 1791203696007)",
                "2026-10-05T12:34:56.007Z",
            ),
            (
                "Timestamp(Microsecond, 1791203696250000)",
                "2026-10-05T12:34:56.25Z",
            ),
            (
                "Timestamp(Nanosecond, -1)",
                "1969-12-31T23:59:59.999999999Z",
            ),
            ("Timestamp(Second, 0)", "1970-01-01T00:00:00Z"),
        ] {
            assert_eq!(rfc3339(debug).as_deref(), Some(want), "{debug}");
        }
        assert_eq!(iso_date("Date32(-719162)").as_deref(), Some("0001-01-01"));
        assert_eq!(rfc3339("Timestamp(Minute, 1)"), None);
    }
}
