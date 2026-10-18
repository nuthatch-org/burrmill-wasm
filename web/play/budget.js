// The engine's working-memory budget on this device. Over it a statement is refused, where unbounded
// it grows the tab until the browser kills it: a phone at around a gigabyte. Elsewhere it is nuthatch's
// 2 GB per active-chain cursor, which a tab following a chain is.
// Measured 2026-10-18: the heaviest Lodestar view peaks near 2 GiB unbounded and is refused at 600 MiB
// with the module at 836 MiB; a light view runs in the same time either way. Under 2 GiB the same view
// completes with the module at 1,956 MiB.
export const SMALL_MIB = 600;
export const LARGE_MIB = 2048;

export function budgetMiB() {
  const nav = globalThis.navigator ?? {};
  const ua = nav.userAgent ?? "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  const small = ios || /Android/.test(ua) || (nav.deviceMemory !== undefined && nav.deviceMemory <= 4);
  return small ? SMALL_MIB : LARGE_MIB;
}

// The engine's refusal, said for the person who ran the query.
export function explainRefusal(message) {
  if (!/Out of Memory Error|Resources exhausted/i.test(message)) return message;
  return `This query needs more working memory than this tab allows on this device (${budgetMiB()} MiB), so it was stopped before it could crash the tab. Narrow it with WHERE or LIMIT, or run it on a desktop.`;
}
