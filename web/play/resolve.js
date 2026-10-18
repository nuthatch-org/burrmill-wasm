// What `nuthatch init` asks the network for one contract, asked from a tab: the chain id, a proxy's
// implementation, the ABI from Sourcify and the deploy block. Every choice made from the answers
// (the slots, the parse, the alias) is nuthatch's own code, passed in as `w` from the wasm module.

const SOURCIFY = "https://sourcify.dev/server/v2/contract";

async function call(rpc, method, params, fetchFn) {
  const r = await fetchFn(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`${method}: the RPC answered ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function chainId(rpc, fetchFn = fetch) {
  return parseInt(await call(rpc, "eth_chainId", [], fetchFn), 16);
}

// The implementation behind a proxy, in `init`'s order: EIP-1967 and its kin, `implementation()`
// on the address, then a beacon. Null when the address is not a proxy any of these name.
export async function implementation(rpc, address, w, fetchFn = fetch) {
  const slots = JSON.parse(w.proxySlots());
  const word = (slot) => call(rpc, "eth_getStorageAt", [address, slot, "latest"], fetchFn).catch(() => null);
  const ask = (to) => call(rpc, "eth_call", [{ to, data: slots.selector }, "latest"], fetchFn).catch(() => null);
  for (const slot of slots.implementation) {
    const found = w.implFromSlot((await word(slot)) ?? "");
    if (found) return found;
  }
  const direct = w.implFromSlot((await ask(address)) ?? "");
  if (direct) return direct;
  const beacon = w.implFromSlot((await word(slots.beacon)) ?? "");
  return beacon ? w.implFromSlot((await ask(beacon)) ?? "") ?? null : null;
}

async function sourcify(id, address, fields, fetchFn) {
  const r = await fetchFn(`${SOURCIFY}/${id}/${address}?fields=${fields}`);
  if (!r.ok) throw new Error(`Sourcify answered ${r.status} for ${address}`);
  return r.text();
}

// One contract resolved as `init` would: `{alias, address, start_block, abi, implementation, name}`.
// `start` overrides the deploy block, as `--start-block` does.
export async function resolveContract({ rpc, id, address, alias, start, taken, w, fetchFn = fetch }) {
  address = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${address} is not a 20-byte hex address`);
  const impl = await implementation(rpc, address, w, fetchFn);
  let parsed = impl ? await sourcify(id, impl, "abi,compilation", fetchFn).then((b) => JSON.parse(w.parseSourcify(b))).catch(() => null) : null;
  const fromImpl = parsed != null;
  parsed ??= JSON.parse(w.parseSourcify(await sourcify(id, address, "abi,compilation", fetchFn)));
  let start_block = start ?? null;
  if (start_block == null) {
    // `init` bisects eth_getCode for this, which needs old state a public RPC does not keep.
    const body = await sourcify(id, address, "deployment", fetchFn).then(JSON.parse).catch(() => null);
    const n = body?.deployment?.blockNumber;
    start_block = n != null ? Number(n) : null;
  }
  return {
    alias: w.pickAlias(alias || undefined, parsed.name ?? undefined, JSON.stringify(taken)),
    address,
    start_block,
    abi: parsed.abi,
    implementation: fromImpl ? impl : null,
    name: parsed.name ?? null,
  };
}
