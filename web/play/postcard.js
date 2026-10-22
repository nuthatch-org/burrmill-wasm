// RFC-0068: a postcard is a link to a published nest, pinned to a cut of its catalogue, with its
// query in the fragment, which no request carries. Shared by the page and its worker.

// Past this many characters a link gets a short form with its SQL kept beside the nest (§4).
export const LONG = 1500;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256hex = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));

export function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export const deflate = async (text) => b64url(await pipe(enc.encode(text), new CompressionStream("deflate-raw")));
export const inflate = async (s) => new TextDecoder().decode(await pipe(unb64url(s), new DecompressionStream("deflate-raw")));

/// `table:block,table:block`, in table order. A table with no entries has no cut.
export function formatCuts(cuts) {
  return Object.keys(cuts).sort().map((t) => `${t}:${cuts[t]}`).join(",");
}
export function parseCuts(s) {
  const cuts = {};
  if (s === "") return cuts;
  for (const part of s.split(",")) {
    const m = /^([A-Za-z0-9_]+):(\d+)$/.exec(part);
    if (!m) throw new Error(`this postcard's cut list is damaged: "${part.slice(0, 40)}" is not table:block`);
    cuts[m[1]] = Number(m[2]);
  }
  return cuts;
}

// The cut list travels deflated: a wide nest's 75 cuts are 2,914 characters plain and 1,159 packed.
export const encodeCuts = (cuts) => deflate(formatCuts(cuts));
export async function decodeCuts(c) {
  let text;
  try { text = await inflate(c); }
  catch { throw new Error("this postcard's cut list is damaged: it does not unpack, so the link was most likely cut short or altered when it was copied"); }
  return parseCuts(text);
}

const sealed = (entries) => (entries ?? []).filter((e) => !e.provisional);

/// Each table's highest sealed `to_block`: the cut a postcard made from this catalogue carries.
export function cutsOf(manifest) {
  const cuts = {};
  for (const [t, es] of Object.entries(manifest.tables)) {
    const s = sealed(es);
    if (s.length) cuts[t] = Math.max(...s.map((e) => e.to_block));
  }
  return cuts;
}

/// The catalogue as the link pins it. A table the link names no cut for admits nothing: it had no
/// entries when the link was made, and reading it as unbounded would fail the digest on an honest host.
/// `behind` names tables whose host catalogue ends short of the cut; `moved` those where it reaches the
/// cut but no segment ends there, so the nest was sealed again with other boundaries.
export function cutCatalogue(manifest, cuts) {
  const tables = {};
  const behind = [];
  const moved = [];
  for (const t of Object.keys(manifest.tables)) tables[t] = [];
  for (const [t, cut] of Object.entries(cuts)) {
    const s = sealed(manifest.tables[t]);
    const top = s.length ? Math.max(...s.map((e) => e.to_block)) : -1;
    if (top < cut) behind.push(t);
    else if (!s.some((e) => e.to_block === cut)) moved.push(t);
    tables[t] = s.filter((e) => e.to_block <= cut);
  }
  return { manifest: { ...manifest, tables }, behind, moved };
}

/// SHA-256 over `schema.json`'s bytes, then one sorted line per admitted entry, base64url.
export async function pinDigest(schemaBytes, tables) {
  const lines = Object.entries(tables).flatMap(([t, es]) => es.map((e) => `${t} ${e.hash} ${e.from_block} ${e.to_block} ${e.rows ?? "-"}\n`)).sort();
  const body = enc.encode(lines.join(""));
  const all = new Uint8Array(schemaBytes.length + body.length);
  all.set(schemaBytes, 0);
  all.set(body, schemaBytes.length);
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", all)));
}

/// What the fragment holds. `kind` is "postcard" (pinned), "base" (a published directory, unpinned) or
/// "nest" (a curated nest, unpinned). `c`, `q` and `w` are left encoded: deflated, or for `q` and `w`
/// `sha256:<hex>`.
export function parseFragment(hash) {
  const f = new URLSearchParams(hash.replace(/^#/, ""));
  const get = (k) => f.get(k) || null;
  const out = { q: get("q"), w: get("w") };
  if (get("v")) {
    if (get("v") !== "1") throw new Error(`this postcard is version ${get("v")}, newer than this page reads; reload for the newest page`);
    for (const k of ["d", "c", "h"]) if (!get(k)) throw new Error(`this postcard has no "${k}": it was cut short when it was copied`);
    if (!/^[0-9a-f]{64}$/.test(get("d"))) throw new Error("this postcard's data identity is not 64 hex digits");
    if (!/^[A-Za-z0-9_-]{43}$/.test(get("h"))) throw new Error("this postcard's digest is not 43 base64url characters");
    if (!/^[A-Za-z0-9_-]+$/.test(get("c"))) throw new Error("this postcard's cut list is damaged: it is not base64url");
    return { ...out, kind: "postcard", m: base(get("m")), d: get("d"), c: get("c"), h: get("h") };
  }
  if (get("m") && get("d")) {
    if (!/^[0-9a-f]{64}$/.test(get("d"))) throw new Error("the link's data identity is not 64 hex digits");
    return { ...out, kind: "base", m: base(get("m")), d: get("d") };
  }
  return { ...out, kind: "nest", nest: get("nest") };
}
function base(m) {
  if (!m) return null;
  const u = new URL(m);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`the link names ${u.protocol} as its host; a postcard reads over https`);
  return u.href.replace(/\/+$/, "");
}

/// The fragment for `link`, in a fixed order so equal links are equal strings.
export function formatFragment(link) {
  const parts = [];
  const put = (k, v) => { if (v !== null && v !== undefined && v !== "") parts.push(`${k}=${k === "m" ? encodeURIComponent(v) : v}`); };
  if (link.kind === "postcard") {
    put("v", "1"); put("m", link.m); put("d", link.d); put("c", link.c); put("h", link.h);
  } else if (link.kind === "base") {
    put("m", link.m); put("d", link.d);
  } else put("nest", link.nest);
  put("w", link.w); put("q", link.q);
  return parts.join("&");
}

/// A link's `q` or `w`: deflated text, or `sha256:<hex>` naming `<base>/queries/<hex>.sql`, refused
/// unless it hashes to the name.
export async function unfold(v, dir) {
  if (!v) return null;
  const m = /^sha256:([0-9a-f]{64})$/.exec(v);
  if (!m) return inflate(v);
  const url = `${dir}/queries/${m[1]}.sql`;
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`the link's SQL is kept at ${url}, which answered HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const got = await sha256hex(bytes);
  if (got !== m[1]) throw new Error(`refused ${url}: it hashes to ${got.slice(0, 12)}…, not the ${m[1].slice(0, 12)}… the link names, so it has changed since the link was made`);
  return new TextDecoder().decode(bytes);
}

const VIEW = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+AS\b/gi;

/// The view statements `sql` reaches, directly or through other views, in their files' order.
export function viewsFor(files, sql) {
  const stmts = [];
  for (const f of files) {
    const heads = [...f.text.matchAll(VIEW)];
    heads.forEach((m, i) => stmts.push({ name: m[1], text: f.text.slice(m.index, heads[i + 1]?.index ?? f.text.length).trim() }));
  }
  const names = new Set(stmts.map((s) => s.name));
  const uses = (text) => [...names].filter((n) => new RegExp(`(^|[^A-Za-z0-9_])"?${n}"?([^A-Za-z0-9_]|$)`).test(text.replace(/--[^\n]*/g, "")));
  const want = new Set();
  const visit = (text, self) => {
    for (const n of uses(text)) {
      if (n === self || want.has(n)) continue;
      want.add(n);
      visit(stmts.find((s) => s.name === n).text.replace(VIEW, ""), n);
    }
  };
  visit(sql, null);
  return stmts.filter((s) => want.has(s.name)).map((s) => s.text).join("\n\n");
}
