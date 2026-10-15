// A nest bound in DuckDB as nuthatch 4.0.2 bound it (analytics.rs `hot_col_type`, `is_bigint`,
// `derived_bigint_cols`; engine_duck.rs `with_declared_base_cols`, `empty_view_ddl`, `bind_facts`),
// and its views split as nuthatch splits them. Shared by the Node harness and the page.

const counter = (c) => ["block_number", "log_index", "_seq", "block_timestamp"].includes(c);
const colType = (c) => (counter(c) ? "UBIGINT" : "VARCHAR");
const isBig = (s) => s === "word16" || s === "word32";

const derived = (cols) => cols.filter(([, s]) => isBig(s)).map(([c]) =>
  `, TRY_CAST("${c}" AS DECIMAL(38,0)) AS "${c}_dec", ("${c}" IS NOT NULL AND TRY_CAST("${c}" AS DECIMAL(38,0)) IS NULL) AS "${c}_overflow"`).join("");

const withDeclared = (from, cols) => cols.length
  ? `(SELECT * FROM ${from} UNION ALL BY NAME SELECT ${cols.map(([c]) => `CAST(NULL AS ${colType(c)}) AS "${c}"`).join(", ")} WHERE false)`
  : from;

/// `declared`: Map table -> [[column, storage]]. `files`: the table's segment paths or URLs.
export function bindDdl(table, declared, files) {
  const cols = declared.get(table) ?? [];
  if (!files.length) {
    if (!cols.length) return null;
    const sel = cols.flatMap(([c, s]) => [`CAST(NULL AS ${colType(c)}) AS "${c}"`,
      ...(isBig(s) ? [`CAST(NULL AS DECIMAL(38,0)) AS "${c}_dec"`, `CAST(NULL AS BOOLEAN) AS "${c}_overflow"`] : [])]);
    return `CREATE OR REPLACE VIEW "${table}" AS SELECT ${sel.join(", ")} WHERE false`;
  }
  const list = files.map((f) => `'${f.replaceAll("'", "''")}'`).join(", ");
  return `CREATE OR REPLACE VIEW "${table}" AS SELECT *${derived(cols)} FROM ${withDeclared(`read_parquet([${list}], union_by_name=true)`, cols)}`;
}

export function declaredColumns(schemaDoc) {
  return new Map((schemaDoc?.tables ?? []).map((t) => [t.table, t.columns.map((c) => [c.name, c.storage])]));
}

/// As nuthatch: split on `;` outside quotes, `--` comments dropped.
export function statements(sql) {
  const out = []; let cur = ""; let s = false, d = false, c = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (c) { if (ch === "\n") { c = false; cur += ch; } continue; }
    if (ch === "-" && !s && !d && sql[i + 1] === "-") { c = true; continue; }
    if (ch === "'" && !d) s = !s; else if (ch === '"' && !s) d = !d;
    else if (ch === ";" && !s && !d) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/// [[name, CREATE VIEW statement]] in load order, from the view files' texts in load order.
export function viewStatements(fileTexts) {
  return fileTexts.flatMap(statements)
    .map((s) => [/\bview\s+"?([a-z0-9_]+)"?\s+as\s/i.exec(s)?.[1]?.toLowerCase(), s])
    .filter(([n]) => n);
}
