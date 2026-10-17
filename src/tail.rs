//! The live tail (RFC-0065 S3): logs past the mirror's last seal, decoded by nuthatch's own decoder
//! into the rows nuthatch's hot store keeps, for Burrmill to union with the sealed segments.
//!
//! The registry is built as nuthatch's `registry::from_nest` builds it. Only the parts of a
//! `nuthatch.toml` that shape event rows are read; a nest declaring anything that adds rows of
//! another kind (templates, factories, calls, ipfs, extract, address history) is refused by name,
//! since its tail would be missing them.

use std::collections::{BTreeMap, HashMap};

use alloy_json_abi::JsonAbi;
use alloy_primitives::Address;
use nuthatch_decode::registry::{ContractSpec, DecodeRegistry};
use nuthatch_decode::rpc::Log;
use serde::Deserialize;
use serde_json::Value;

use crate::nest::Result;

/// Top-level keys that only route, alert or derive: they leave a nest's event rows as they are.
const ROW_NEUTRAL: &[&str] = &["nest", "contracts", "flags", "alerts", "webhooks"];

#[derive(Deserialize)]
struct Config {
    nest: NestSection,
    #[serde(default)]
    contracts: Vec<Contract>,
}

#[derive(Deserialize)]
struct NestSection {
    #[serde(default = "yes")]
    block_timestamps: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
struct Contract {
    alias: String,
    address: String,
    #[serde(default)]
    start_block: Option<u64>,
    abi: String,
    #[serde(default)]
    events: Vec<String>,
}

pub struct Decoder {
    registry: DecodeRegistry,
    /// Each contract's lowercase address and its start block: a log before it is not the nest's.
    starts: HashMap<String, u64>,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Decoded {
    /// Table to rows, each as `DecodedRow::to_json`, in (block, log_index) order.
    pub rows: BTreeMap<String, Vec<Value>>,
    pub logs: usize,
    pub undecoded: usize,
    pub removed: usize,
}

impl Decoder {
    /// `abis` maps each `abi = "..."` path in the config to that file's text.
    pub fn from_nest(config: &str, abis: &BTreeMap<String, String>) -> Result<Decoder> {
        let raw: toml::Table = config.parse().map_err(|e| format!("nuthatch.toml: {e}"))?;
        if let Some(k) = raw.keys().find(|k| !ROW_NEUTRAL.contains(&k.as_str())) {
            return Err(format!(
                "nuthatch.toml declares [{k}], which adds rows the live tail does not decode; \
                 this nest is served from its sealed segments only"
            ));
        }
        let cfg: Config = toml::from_str(config).map_err(|e| format!("nuthatch.toml: {e}"))?;
        let mut specs = Vec::with_capacity(cfg.contracts.len());
        let mut starts = HashMap::new();
        for c in &cfg.contracts {
            let text = abis
                .get(&c.abi)
                .ok_or_else(|| format!("contract `{}`: no ABI file {}", c.alias, c.abi))?;
            let abi: JsonAbi =
                serde_json::from_str(text).map_err(|e| format!("parsing ABI {}: {e}", c.abi))?;
            let address: Address = c
                .address
                .parse()
                .map_err(|e| format!("contract `{}`: address {}: {e}", c.alias, c.address))?;
            if address.is_zero() {
                return Err(format!("contract `{}` is the zero address", c.alias));
            }
            starts.insert(format!("{address:#x}"), c.start_block.unwrap_or_default());
            specs.push(ContractSpec {
                alias: c.alias.clone(),
                address,
                abi,
                events: c.events.clone(),
            });
        }
        let registry = DecodeRegistry::build(specs)
            .map_err(|e| format!("{e:#}"))?
            .with_timestamps(cfg.nest.block_timestamps);
        Ok(Decoder { registry, starts })
    }

    /// The `eth_getLogs` filter nuthatch sends for this nest: every address, any of its topic0s.
    pub fn filter(&self) -> Value {
        let addresses: Vec<String> = self
            .registry
            .addresses()
            .iter()
            .map(|a| format!("{a:#x}"))
            .collect();
        let topics: Vec<String> = self
            .registry
            .topic0s()
            .iter()
            .map(|t| format!("{t:#x}"))
            .collect();
        serde_json::json!({ "address": addresses, "topics": [topics] })
    }

    pub fn timestamps(&self) -> bool {
        self.registry.timestamps()
    }

    /// Decode `logs` (as `eth_getLogs` returns them) as nuthatch's backfill does: removed logs out,
    /// a log no decoder claims skipped, each row stamped with its block's timestamp from `times`
    /// (block number to unix seconds), then ordered by (block, log_index).
    pub fn decode(&self, logs: &[Value], times: &HashMap<u64, u64>) -> Result<Decoded> {
        let mut out = Decoded::default();
        let mut rows = Vec::new();
        for v in logs {
            out.logs += 1;
            if v.get("removed").and_then(Value::as_bool) == Some(true) {
                out.removed += 1;
                continue;
            }
            let log = parse_log(v)?;
            let start = self
                .starts
                .get(&log.address.to_ascii_lowercase())
                .copied()
                .unwrap_or_default();
            if log.block_number < start {
                continue;
            }
            match self.registry.decode(&log) {
                Ok(Some(r)) => rows.push(r),
                Ok(None) | Err(_) => out.undecoded += 1,
            }
        }
        rows.sort_by_key(|r| (r.block_number, r.log_index));
        for mut r in rows {
            if self.registry.timestamps() {
                r.block_timestamp = *times
                    .get(&r.block_number)
                    .ok_or_else(|| format!("no timestamp for block {}", r.block_number))?;
            }
            out.rows
                .entry(r.table.clone())
                .or_default()
                .push(r.to_json());
        }
        Ok(out)
    }
}

/// nuthatch's `rpc::parse_log`.
fn parse_log(v: &Value) -> Result<Log> {
    let field = |key: &str| -> Result<String> {
        v.get(key)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| format!("log missing field '{key}'"))
    };
    let hex = |s: String| -> Result<u64> {
        u64::from_str_radix(s.strip_prefix("0x").unwrap_or(&s), 16)
            .map_err(|_| format!("bad hex number '{s}'"))
    };
    let topics = v
        .get("topics")
        .and_then(Value::as_array)
        .map(|t| {
            t.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(Log {
        address: field("address")?,
        topics,
        data: field("data").unwrap_or_default(),
        block_number: hex(field("blockNumber")?)?,
        block_hash: field("blockHash").unwrap_or_default(),
        tx_hash: field("transactionHash")?,
        log_index: hex(field("logIndex")?)?,
    })
}
