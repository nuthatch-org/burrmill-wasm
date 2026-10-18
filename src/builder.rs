//! The nest builder (RFC-0066 S1): the nest `nuthatch init` would scaffold from what the page fetched,
//! and the identity a node gives it. The page does the fetching; every choice and every byte is made
//! by nuthatch's own crates, so the downloaded nest is the one a node indexes.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::nest::Result;

/// What the page resolved, as JSON: `init`'s inputs once the network has answered.
#[derive(Deserialize)]
pub struct Input {
    pub name: String,
    pub chain: String,
    pub chain_id: u64,
    pub rpc_urls: Vec<String>,
    #[serde(default = "yes")]
    pub block_timestamps: bool,
    pub contracts: Vec<ContractInput>,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize)]
pub struct ContractInput {
    pub alias: String,
    pub address: String,
    pub start_block: Option<u64>,
    pub abi: Value,
}

fn nest(input: Input) -> Result<nuthatch_scaffold::Nest> {
    let contracts = input
        .contracts
        .into_iter()
        .map(|c| {
            Ok(nuthatch_scaffold::Contract {
                address: nuthatch_scaffold::resolve::normalise_address(&c.address)
                    .map_err(|e| e.to_string())?,
                alias: c.alias,
                start_block: c.start_block,
                abi: c.abi,
            })
        })
        .collect::<Result<_>>()?;
    Ok(nuthatch_scaffold::Nest {
        name: input.name,
        chain: input.chain,
        chain_id: input.chain_id,
        rpc_urls: input.rpc_urls,
        block_timestamps: input.block_timestamps,
        contracts,
    })
}

/// Every file `init` writes for `input`, by path, as text.
pub fn scaffold(input: Input) -> Result<BTreeMap<String, String>> {
    let files = nuthatch_scaffold::files(&nest(input)?).map_err(|e| format!("{e:#}"))?;
    files
        .into_iter()
        .map(|(p, b)| Ok((p, String::from_utf8(b).map_err(|e| e.to_string())?)))
        .collect()
}

/// The NID and data identity of the nest `input` scaffolds, holding `files` (as edited on the page).
/// The decode is pinned by the config and ABIs, which the page does not edit.
pub fn identity(input: Input, files: BTreeMap<String, String>) -> Result<(String, String)> {
    let nest = nest(input)?;
    let registry = nuthatch_scaffold::registry(&nest).map_err(|e| format!("{e:#}"))?;
    let m = nuthatch_identity::manifest(
        nest.name,
        if nest.block_timestamps { 1 } else { 2 },
        // Not part of the NID or the data identity.
        "tab".into(),
        hex::encode(registry.hash()),
        files.into_iter().map(|(p, t)| (p, t.into_bytes())),
    )
    .map_err(|e| format!("{e:#}"))?;
    Ok((m.nid(), m.data_identity()))
}

/// `init`'s alias for a contract: the one asked for, else its name slugified, else `cN`.
pub fn alias(
    provided: Option<&str>,
    contract_name: Option<&str>,
    taken: &[String],
) -> Result<String> {
    nuthatch_scaffold::resolve::pick_alias(provided, contract_name, &Default::default(), taken)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> Input {
        serde_json::from_value(serde_json::json!({
            "name": "pair",
            "chain": "mainnet",
            "chain_id": 1,
            "rpc_urls": ["https://ethereum-rpc.publicnode.com"],
            "contracts": [{
                "alias": "uniswap_v2pair",
                "address": "0x9d593420cC4936B8a8435cDFa0D6BBde9BDff9a4",
                "start_block": 26212134,
                "abi": serde_json::from_str::<Value>(include_str!("fixtures/pair-abi.json")).unwrap(),
            }],
        }))
        .unwrap()
    }

    /// The NID `nuthatch dev --dir` reported on 2026-10-18 for the nest `nuthatch init` 5.7.1 wrote
    /// for this pair.
    #[test]
    fn the_tab_gives_the_nid_a_node_gives() {
        let files = scaffold(pair()).unwrap();
        assert_eq!(files.len(), 9);
        let (nid, data) = identity(pair(), files).unwrap();
        assert_eq!(
            nid,
            "d1d2f195ea47fb02af03d523410e7f2b13a69bcc96302bbf37322dbe47c1d686"
        );
        assert_eq!(
            data,
            "b28a5043b11263e8adb9e24f5c02535b2c34d7e561e010348db3907941199c57"
        );
    }

    #[test]
    fn an_edited_view_moves_the_nid_and_not_the_data() {
        let mut files = scaffold(pair()).unwrap();
        let (nid, data) = identity(pair(), files.clone()).unwrap();
        files.insert(
            "views/20-swaps.sql".into(),
            "CREATE VIEW swaps AS SELECT 1;\n".into(),
        );
        let (nid2, data2) = identity(pair(), files).unwrap();
        assert_ne!(nid, nid2);
        assert_eq!(data, data2);
    }

    #[test]
    fn aliases_are_init_s() {
        assert_eq!(
            alias(None, Some("UniswapV2Pair"), &[]).unwrap(),
            "uniswap_v2pair"
        );
        assert_eq!(
            alias(None, Some("UniswapV2Pair"), &["uniswap_v2pair".into()]).unwrap(),
            "uniswap_v2pair_2"
        );
        assert_eq!(alias(None, None, &[]).unwrap(), "c0");
    }
}
