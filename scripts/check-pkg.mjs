// Refuses a pkg/web that does not match the source: one built before the last change to src/ or
// Cargo.*, or one missing a name a playground page takes from it. A stale module still loads the
// page, and its worker then dies on a missing export with nothing on screen (the play outage of
// 2026-10-21), so this runs before anything is copied out of pkg/web.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = join(root, "pkg/web");
const glue = join(pkg, "burrmill_wasm.js");
const wasm = join(pkg, "burrmill_wasm_bg.wasm");
const fail = (why) => { console.error(`pkg/web is stale: ${why}\nrun scripts/build.sh first`); process.exit(1); };

if (!existsSync(glue) || !existsSync(wasm)) fail("it has no burrmill_wasm.js and burrmill_wasm_bg.wasm");

const built = statSync(wasm).mtimeMs;
const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sources(join(dir, e.name)) : [join(dir, e.name)]);
const newer = [...sources(join(root, "src")), ...["Cargo.toml", "Cargo.lock", "build.rs"].map((f) => join(root, f)).filter(existsSync)]
  .filter((f) => statSync(f).mtimeMs > built)
  .map((f) => f.slice(root.length));
if (newer.length) fail(`changed since it was built: ${newer.join(", ")}`);

const text = readFileSync(glue, "utf8");
const exported = new Set([
  ...[...text.matchAll(/^export (?:async )?(?:class|function|const|let) ([\w$]+)/gm)].map((m) => m[1]),
  ...[...text.matchAll(/^export \{([^}]*)\}/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop())),
]);

// What each page takes: named imports, members of a namespace import, and members of `w`, the name
// the module goes by where it is passed in as a parameter (resolve.js, index-it.js).
const play = join(root, "web/play");
const wanted = new Map();
const want = (name, file) => wanted.set(name, [...(wanted.get(name) ?? []), file]);
for (const file of readdirSync(play).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(play, file), "utf8");
  const spaces = [];
  for (const [, clause] of src.matchAll(/import\s+([^;]*?)\s+from\s+["']\.\/pkg\/burrmill_wasm\.js["']/g)) {
    const named = clause.match(/\{([^}]*)\}/);
    if (named) for (const s of named[1].split(",").map((s) => s.trim()).filter(Boolean)) want(s.split(/\s+as\s+/)[0], file);
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) spaces.push(ns[1]);
    if (/^[\w$]+\s*(,|$)/.test(clause)) want("default", file);
  }
  if (/function\s*[\w$]*\s*\([^)]*(?<![\w$])w(?![\w$])[^)]*\)/.test(src)) spaces.push("w");
  for (const ns of new Set(spaces)) {
    for (const [, name] of src.matchAll(new RegExp(`(?<![\\w$.])${ns}\\.([\\w$]+)`, "g"))) want(name, file);
  }
}

const missing = [...wanted].filter(([name]) => !exported.has(name));
if (missing.length) fail(`burrmill_wasm.js does not export ${missing.map(([n, f]) => `${n} (${[...new Set(f)].join(", ")})`).join(", ")}`);
console.log(`pkg/web: ${wanted.size} names the pages use, all exported; built after every source change`);
