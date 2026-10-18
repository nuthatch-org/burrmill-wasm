//! A block's receipts checked against its verified header (RFC-0065 §6): rebuilt from the untrusted
//! RPC's JSON, they must hash to the header's `receiptsRoot`, and then every log in the block is known.

use alloy_consensus::proofs::calculate_receipt_root;
use alloy_consensus::{Eip658Value, Receipt, ReceiptEnvelope, ReceiptWithBloom};
use alloy_primitives::{Address, B256, Bytes, Log};
use serde_json::Value;

use crate::nest::Result;

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| format!("a receipt without {k}"))
}
fn quantity(v: &Value, k: &str) -> Result<u64> {
    u64::from_str_radix(field(v, k)?.trim_start_matches("0x"), 16).map_err(|e| format!("{k}: {e}"))
}

/// `receipts` as `eth_getBlockReceipts` answers them, in transaction order. Answers every log of the
/// block, in order, once the receipts hash to `root`.
pub fn verify(receipts: &[Value], root: B256) -> Result<Vec<Log>> {
    let mut envelopes = Vec::with_capacity(receipts.len());
    let mut all = Vec::new();
    for r in receipts {
        let mut logs = Vec::new();
        for l in r.get("logs").and_then(Value::as_array).ok_or("a receipt without logs")? {
            let address: Address = field(l, "address")?.parse().map_err(|e| format!("address: {e}"))?;
            let topics = l
                .get("topics")
                .and_then(Value::as_array)
                .ok_or("a log without topics")?
                .iter()
                .map(|t| t.as_str().ok_or("a topic that is not a string")?.parse::<B256>().map_err(|e| e.to_string()))
                .collect::<Result<Vec<_>>>()?;
            let data: Bytes = field(l, "data")?.parse().map_err(|e| format!("data: {e}"))?;
            logs.push(Log::new(address, topics, data).ok_or("a log with more than four topics")?);
        }
        all.extend(logs.iter().cloned());
        // Before Byzantium a receipt carried a state root; every block a tab can verify is after it.
        let receipt = Receipt { status: Eip658Value::Eip658(quantity(r, "status")? == 1), cumulative_gas_used: quantity(r, "cumulativeGasUsed")?, logs };
        let bloomed = ReceiptWithBloom::from(receipt);
        envelopes.push(match quantity(r, "type")? {
            0 => ReceiptEnvelope::Legacy(bloomed),
            1 => ReceiptEnvelope::Eip2930(bloomed),
            2 => ReceiptEnvelope::Eip1559(bloomed),
            3 => ReceiptEnvelope::Eip4844(bloomed),
            4 => ReceiptEnvelope::Eip7702(bloomed),
            t => return Err(format!("a receipt of type {t}, which this crate does not know")),
        });
    }
    let got = calculate_receipt_root(&envelopes);
    if got != root {
        return Err(format!("the receipts hash to {got}, not the verified header's {root}"));
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipts() -> Vec<Value> {
        serde_json::from_str(include_str!("fixtures/receipts-26214986.json")).unwrap()
    }
    fn root() -> B256 {
        let h: Vec<Value> = serde_json::from_str(include_str!("fixtures/headers.json")).unwrap();
        h[1]["receiptsRoot"].as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn a_mainnet_block_s_receipts_hash_to_its_header() {
        let r = receipts();
        let logs = verify(&r, root()).unwrap();
        let count: usize = r.iter().map(|x| x["logs"].as_array().unwrap().len()).sum();
        assert_eq!(logs.len(), count);
    }

    #[test]
    fn an_altered_log_is_refused() {
        let mut r = receipts();
        let i = r.iter().position(|x| !x["logs"].as_array().unwrap().is_empty()).unwrap();
        r[i]["logs"][0]["data"] = Value::from("0x01");
        assert!(verify(&r, root()).unwrap_err().contains("hash to"));
    }

    #[test]
    fn a_removed_log_is_refused() {
        let mut r = receipts();
        let i = r.iter().position(|x| !x["logs"].as_array().unwrap().is_empty()).unwrap();
        r[i]["logs"].as_array_mut().unwrap().remove(0);
        assert!(verify(&r, root()).unwrap_err().contains("hash to"));
    }
}
