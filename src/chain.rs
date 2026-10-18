//! The tab's header chain (RFC-0065 S5): headers from an untrusted RPC, each hashed here and linked by
//! its parent hash down from a block hash the light client verified, so every block under it is canonical.

use std::collections::BTreeMap;

use alloy_consensus::Header;
use alloy_primitives::B256;
use serde_json::Value;

use crate::nest::Result;

/// `headers` as `eth_getBlockByNumber` returns them, consecutive in any order, the highest hashing to
/// `top`. Answers each block's hash by number.
pub fn verify(headers: &[Value], top: B256) -> Result<BTreeMap<u64, B256>> {
    let mut chain = BTreeMap::new();
    for v in headers {
        let h: Header = serde_json::from_value(v.clone()).map_err(|e| format!("a header does not parse: {e}"))?;
        let hash = h.hash_slow();
        // A header from a fork this crate does not know hashes differently, which would otherwise read as a forgery.
        if let Some(claimed) = v.get("hash").and_then(Value::as_str) {
            if claimed.parse::<B256>().ok() != Some(hash) {
                return Err(format!("block {} hashes to {hash}, not the {claimed} its RPC gave", h.number).into());
            }
        }
        if chain.insert(h.number, (hash, h.parent_hash)).is_some() {
            return Err(format!("block {} is given twice", h.number).into());
        }
    }
    let Some((&last, &(hash, _))) = chain.last_key_value() else { return Ok(BTreeMap::new()) };
    if hash != top {
        return Err(format!("block {last} is {hash}; the light client verified {top}").into());
    }
    let mut child = None::<(u64, B256)>;
    for (&n, &(hash, parent)) in chain.iter().rev() {
        if let Some((c, expect)) = child {
            if n + 1 != c {
                return Err(format!("no header for block {}", n + 1).into());
            }
            if hash != expect {
                return Err(format!("block {c}'s parent is {expect}, but block {n} hashes to {hash}").into());
            }
        }
        child = Some((n, parent));
    }
    Ok(chain.into_iter().map(|(n, (h, _))| (n, h)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers() -> Vec<Value> {
        serde_json::from_str(include_str!("fixtures/headers.json")).unwrap()
    }
    fn top(h: &[Value]) -> B256 {
        h[2]["hash"].as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn three_mainnet_blocks_link_to_the_verified_top() {
        let h = headers();
        let chain = verify(&h, top(&h)).unwrap();
        assert_eq!(chain.keys().copied().collect::<Vec<_>>(), [26214985, 26214986, 26214987]);
        assert_eq!(chain[&26214985], h[0]["hash"].as_str().unwrap().parse::<B256>().unwrap());
    }

    #[test]
    fn a_top_the_light_client_did_not_verify_is_refused() {
        let h = headers();
        let e = verify(&h, B256::repeat_byte(7)).unwrap_err().to_string();
        assert!(e.contains("the light client verified"), "{e}");
    }

    #[test]
    fn an_altered_header_is_refused_even_with_its_hash_rewritten() {
        let mut h = headers();
        h[0]["receiptsRoot"] = Value::from(format!("{}", B256::repeat_byte(1)));
        let e = verify(&h, top(&h)).unwrap_err().to_string();
        assert!(e.contains("not the"), "{e}");
        let forged: Header = serde_json::from_value(h[0].clone()).unwrap();
        h[0]["hash"] = Value::from(forged.hash_slow().to_string());
        let e = verify(&h, top(&h)).unwrap_err().to_string();
        assert!(e.contains("block 26214986's parent"), "{e}");
    }

    #[test]
    fn a_missing_block_is_refused() {
        let mut h = headers();
        let t = top(&h);
        h.remove(1);
        let e = verify(&h, t).unwrap_err().to_string();
        assert!(e.contains("no header for block 26214986"), "{e}");
    }
}
