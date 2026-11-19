import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { createDb } from "@paperclipai/db";

type HarnessDb = Pick<ReturnType<typeof createDb>, "$client">;
type Row = Record<string, unknown>;
type Column = {
  table_schema: string; table_name: string; column_name: string; ordinal_position: number;
  data_type: string; udt_name: string; is_nullable: string;
  character_maximum_length: number | null; numeric_precision: number | null;
  numeric_scale: number | null; datetime_precision: number | null;
  is_identity: string; is_generated: string;
};
type ForeignKey = {
  name: string; child_table: string; parent_table: string;
  child_columns: string[]; parent_columns: string[];
  deferrable: boolean; deferred: boolean;
};
type PrimaryKey = { table_name: string; columns: string[] };
export type CapturedManifest = {
  format: "paperclip.capture.v1"; server: string; company: string; issue: string;
  schema_columns: Column[]; schema_fingerprint: string;
  foreign_keys: ForeignKey[]; primary_keys: PrimaryKey[];
  row_counts: Record<string, number>; file_sha256: Record<string, string>;
  redactions: { table: string; path: string[]; action: string; rule?: string }[];
  sql: string; sql_sha256: string;
};
export type ColumnMappingOverride = {
  /** Pin BOTH schemas; this is a deliberate migration, never a wildcard bypass. */
  sourceFingerprint: string;
  targetFingerprint: string;
  /** Every changed table needs an explicit entry. null deliberately drops a column. */
  tables: Record<string, Record<string, string | null>>;
};

// JSON.parse's source reviver preserves arbitrary-precision JSON numbers. In particular,
// bigint run-event primary keys must not silently round through JavaScript's Number.
class JsonNumber {
  constructor(readonly source: string) {}
}
function parseLossless(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && context?.source &&
        (!Number.isSafeInteger(value) || String(value) !== context.source)) {
      return new JsonNumber(context.source);
    }
    return value;
  });
}
function serialize(value: unknown): string {
  if (value instanceof JsonNumber) return value.source;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${serialize((value as Row)[key])}`).join(",")}}`;
}
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Invalid fixture SQL identifier");
  return `"${name}"`;
}
const qualified = (name: string) => `public.${identifier(name)}`;
const key = (row: Row, columns: string[]) => serialize(columns.map(c => row[c]));
const present = (value: unknown) => value !== null && value !== undefined;
const columnSql = `SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,
 character_maximum_length,numeric_precision,numeric_scale,datetime_precision,is_identity,is_generated
 FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
 ORDER BY table_name,ordinal_position`;
const fkSql = `SELECT co.conname AS name,cl.relname AS child_table,pa.relname AS parent_table,
 co.condeferrable AS deferrable,co.condeferred AS deferred,
 array(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(n,o)
 JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.n ORDER BY k.o) AS child_columns,
 array(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(n,o)
 JOIN pg_attribute a ON a.attrelid=co.confrelid AND a.attnum=k.n ORDER BY k.o) AS parent_columns
 FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid
 JOIN pg_namespace ns ON ns.oid=cl.relnamespace JOIN pg_class pa ON pa.oid=co.confrelid
 WHERE co.contype='f' AND ns.nspname='public' AND cl.relname=ANY($1::text[])
 ORDER BY cl.relname,co.conname`;
const pkSql = `SELECT cl.relname AS table_name,
 array(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(n,o)
 JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.n ORDER BY k.o) AS columns
 FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid
 JOIN pg_namespace ns ON ns.oid=cl.relnamespace
 WHERE co.contype='p' AND ns.nspname='public' AND cl.relname=ANY($1::text[])`;

export async function readCapturedFixture(dir: string) {
  const manifest = JSON.parse(await readFile(join(dir, "MANIFEST.json"), "utf8")) as CapturedManifest;
  if (manifest.format !== "paperclip.capture.v1") throw new Error("Unsupported capture format");
  if (digest(serialize(manifest.schema_columns)) !== manifest.schema_fingerprint) {
    throw new Error("Capture schema fingerprint is corrupt");
  }
  if (digest(manifest.sql) !== manifest.sql_sha256) throw new Error("Capture SQL digest is corrupt");
  const rows: Record<string, Row[]> = {};
  for (const [table, count] of Object.entries(manifest.row_counts)) {
    identifier(table);
    const name = `${table}.json`, text = await readFile(join(dir, name), "utf8");
    if (digest(text) !== manifest.file_sha256[name]) throw new Error(`Capture file digest mismatch: ${name}`);
    const parsed = parseLossless(text);
    if (!Array.isArray(parsed) || parsed.length !== count || parsed.some(r => !r || Array.isArray(r) || typeof r !== "object")) {
      throw new Error(`Capture row count/format mismatch: ${table}`);
    }
    rows[table] = parsed as Row[];
  }
  return { manifest, rows };
}

/** Test-support ONLY. Supply a fresh, migrated real-PG harness, never a live DB.
 * No upserts, regenerated IDs, disabled triggers, deferred constraints or schema writes.
 * A collision or an unbreakable NOT NULL cycle rolls back the entire fixture.
 */
export async function loadCapturedFixture(
  db: HarnessDb, dir: string, options: { columnMapping?: ColumnMappingOverride } = {},
): Promise<{ manifest: CapturedManifest; inserted: Record<string, number>; restoredEdges: number }> {
  const { manifest, rows } = await readCapturedFixture(dir);
  const tables = Object.keys(rows).sort();
  return db.$client.begin(async tx => {
    const columns = await tx.unsafe<Column[]>(columnSql, [tables]);
    const fingerprint = digest(serialize(columns));
    const mapping = options.columnMapping;
    if (fingerprint !== manifest.schema_fingerprint) {
      if (!mapping || mapping.sourceFingerprint !== manifest.schema_fingerprint || mapping.targetFingerprint !== fingerprint) {
        throw new Error(`Harness schema fingerprint mismatch: capture=${manifest.schema_fingerprint} harness=${fingerprint}; explicit columnMapping required`);
      }
      for (const table of tables) {
        if (serialize(columns.filter(c => c.table_name === table)) !== serialize(manifest.schema_columns.filter(c => c.table_name === table)) && !Object.hasOwn(mapping.tables, table)) {
          throw new Error(`Explicit column mapping missing for changed table: ${table}`);
        }
      }
    } else if (mapping) {
      throw new Error("Column mapping is only allowed for an explicitly pinned schema mismatch");
    }
    const fks = await tx.unsafe<ForeignKey[]>(fkSql, [tables]);
    const pks = await tx.unsafe<PrimaryKey[]>(pkSql, [tables]);
    const pkByTable = new Map(pks.map(p => [p.table_name, p.columns]));
    type Node = { table: string; original: Row; initial: Row; edges: Edge[] };
    type Edge = { parent: Node; fk: ForeignKey; breakColumn?: string };
    const nodes: Node[] = [], byTable = new Map<string, Node[]>();
    for (const table of tables) {
      const primary = pkByTable.get(table);
      if (!primary) throw new Error(`No primary key for captured table: ${table}`);
      const known = new Set(columns.filter(c => c.table_name === table).map(c => c.column_name));
      const mappedPrimary = manifest.primary_keys.find(p => p.table_name === table)?.columns ?? [];
      for (const old of rows[table]) {
        const row: Row = {};
        for (const [name, value] of Object.entries(old)) {
          const target = mapping && Object.hasOwn(mapping.tables[table] ?? {}, name) ? mapping.tables[table][name] : name;
          if (target === null) {
            if (mappedPrimary.includes(name)) throw new Error(`Cannot drop captured primary key: ${table}.${name}`);
            continue;
          }
          if (!known.has(target)) throw new Error(`Unknown harness column: ${table}.${target}`);
          if (Object.hasOwn(row, target)) throw new Error(`Column mapping collision: ${table}.${target}`);
          row[target] = value;
        }
        if (primary.some(c => !present(row[c]))) throw new Error(`Missing captured primary key: ${table}`);
        // The fixture exports user IDs ONLY. Required harness fields contain no real
        // names/emails; these stubs are never used for auth and are not re-exported.
        if (table === "user") {
          if (Object.keys(old).some(c => c !== "id")) throw new Error("User capture must contain IDs only");
          for (const field of ["name", "email", "email_verified", "created_at", "updated_at"]) {
            if (!manifest.redactions?.some(r => r.table === "user" && r.path.length === 1 && r.path[0] === field && r.action === "synthesized for load, not captured")) {
              throw new Error(`User load-only synthesis is missing from MANIFEST redactions: ${field}`);
            }
          }
          row.name = `captured-user-${String(row.id).slice(0, 8)}`;
          row.email = `captured-${String(row.id).slice(0, 8)}@capture.invalid`;
          // email_verified is omitted: PostgreSQL supplies DEFAULT false.
          row.created_at = "1970-01-01T00:00:00Z";
          row.updated_at = "1970-01-01T00:00:00Z";
        }
        const node: Node = { table, original: row, initial: { ...row }, edges: [] };
        nodes.push(node);
        const bucket = byTable.get(table) ?? [];
        if (bucket.some(n => key(n.original, primary) === key(row, primary))) throw new Error(`Duplicate captured primary key: ${table}`);
        bucket.push(node); byTable.set(table, bucket);
      }
    }
    const patches = new Map<Node, Set<string>>();
    const nullable = new Set(columns.filter(c => c.is_nullable === "YES").map(c => `${c.table_name}.${c.column_name}`));
    for (const node of nodes) {
      for (const fk of fks.filter(f => f.child_table === node.table)) {
        if (!fk.child_columns.every(c => present(node.original[c]))) continue;
        const parent = (byTable.get(fk.parent_table) ?? []).find(n => key(n.original, fk.parent_columns) === key(node.original, fk.child_columns));
        if (!parent) throw new Error(`Capture FK closure missing: ${fk.name} ${fk.child_table}(${fk.child_columns}) -> ${fk.parent_table}(${fk.parent_columns})`);
        const breakColumn = fk.child_columns.find(c => nullable.has(`${node.table}.${c}`) && !pkByTable.get(node.table)!.includes(c));
        if (parent !== node) node.edges.push({ parent, fk, breakColumn });
      }
    }
    // Keep noncyclic nullable FKs exact: e.g. conversation_agent_id participates
    // in a CHECK and must stay paired with the captured conversation identity.
    // Only break a nullable, non-PK edge that actually belongs to a row-level
    // cycle. All planning completes before the first INSERT, with constraints ON.
    const order: Node[] = [], remaining = new Set(nodes);
    const active = (node: Node) => node.edges.filter(e => remaining.has(e.parent) && e.fk.child_columns.every(c => present(node.initial[c])));
    const reaches = (node: Node, target: Node, seen = new Set<Node>()): boolean => {
      if (node === target) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return active(node).some(e => reaches(e.parent, target, seen));
    };
    while (remaining.size) {
      const ready = [...remaining].filter(n => active(n).length === 0);
      if (ready.length) {
        for (const node of ready) { remaining.delete(node); order.push(node); }
        continue;
      }
      const cycleEdges = [...remaining].flatMap(node => active(node)
        .filter(edge => reaches(edge.parent, node)).map(edge => ({ node, edge })));
      const candidate = cycleEdges.find(({ edge }) => edge.breakColumn);
      if (!candidate) {
        const edge = cycleEdges[0].edge.fk;
        throw new Error(`NOT NULL FK cycle: ${edge.name} ${edge.child_table}(${edge.child_columns}) -> ${edge.parent_table}(${edge.parent_columns}); stopped without constraint changes`);
      }
      const { node, edge } = candidate, column = edge.breakColumn!;
      // MATCH SIMPLE composites are broken by one NULL; restore exact original
      // values only after every referenced row exists, within this transaction.
      node.initial[column] = null;
      const patch = patches.get(node) ?? new Set<string>();
      patch.add(column); patches.set(node, patch);
    }
    const guarded = async (table: string, query: string, args: string[]) => {
      try { await tx.unsafe(query, args); }
      catch (error) {
        const metadata = error as { code?: string; column_name?: string; constraint_name?: string };
        const code = /^[A-Z0-9]{5}$/.test(metadata.code ?? "") ? metadata.code : "unknown";
        const column = /^[a-z_][a-z0-9_]*$/.test(metadata.column_name ?? "") ? metadata.column_name : "unavailable";
        const constraint = /^[a-z_][a-z0-9_]*$/.test(metadata.constraint_name ?? "") ? metadata.constraint_name : "unavailable";
        throw new Error(`Captured fixture write failed: public.${table}; SQLSTATE ${code}; column=${column}; constraint=${constraint}; row/detail suppressed`);
      }
    };
    for (const node of order) {
      const names = Object.keys(node.initial).sort();
      const select = names.map(identifier).join(",");
      await guarded(node.table,
        `INSERT INTO ${qualified(node.table)} (${select}) SELECT ${select} FROM jsonb_populate_record(NULL::${qualified(node.table)},$1::jsonb)`,
        [serialize(node.initial)]);
    }
    for (const [node, patched] of patches) {
      const names = [...patched].sort(), primary = pkByTable.get(node.table)!;
      await guarded(node.table,
        `UPDATE ${qualified(node.table)} t SET ${names.map(c => `${identifier(c)}=v.${identifier(c)}`).join(",")}
         FROM jsonb_populate_record(NULL::${qualified(node.table)},$1::jsonb) v
         WHERE ${primary.map(c => `t.${identifier(c)}=v.${identifier(c)}`).join(" AND ")}`,
        [serialize(node.original)]);
    }
    return { manifest, inserted: manifest.row_counts, restoredEdges: [...patches.values()].reduce((n, columns) => n + columns.size, 0) };
  });
}

/** Re-execute the capture's original selection/redaction statement in a real read-only
 * transaction, then compare per-table JSONB MULTISETS in PG (no Number precision loss).
 * Only the psql client directive and transaction wrapper move to the driver API;
 * the full WITH...SELECT statement is byte-identical to the MANIFEST SQL.
 */
export async function assertCapturedRoundTrip(db: HarnessDb, dir: string): Promise<Record<string, number>> {
  const { manifest } = await readCapturedFixture(dir);
  const marker = "WITH RECURSIVE\n", end = "\nCOMMIT;\n";
  const start = manifest.sql.indexOf(marker);
  if (start < 0 || !manifest.sql.endsWith(end)) throw new Error("Unrecognized capture SQL wrapper");
  const statement = manifest.sql.slice(start, -end.length);
  if (!statement.endsWith(";") || statement.slice(0, -1).includes(";")) {
    throw new Error("Capture SQL must contain exactly one selection statement");
  }
  return db.$client.begin("isolation level repeatable read read only", async tx => {
    // Harness-only budget; the live export routes remain capped at 15 seconds.
    await tx.unsafe("SET LOCAL statement_timeout='60s'");
    const raw = await tx.unsafe(statement).raw().catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      throw new Error(`Captured re-export failed: SQLSTATE ${/^[A-Z0-9]{5}$/.test(code ?? "") ? code : "unknown"}; SQL/detail suppressed`);
    });
    const response = parseLossless(raw[0][0].toString("utf8")) as { rows?: Record<string, unknown[]>; refused?: boolean };
    if (response.refused || !response.rows) throw new Error("Round-trip capture SQL refused the loaded fixture");
    const counts: Record<string, number> = {};
    const unexpected = Object.keys(response.rows).filter(t => !Object.hasOwn(manifest.row_counts, t));
    if (unexpected.length) throw new Error(`Round-trip returned unexpected tables: ${unexpected.join(",")}`);
    for (const table of Object.keys(manifest.row_counts).sort()) {
      const expected = await readFile(join(dir, `${table}.json`), "utf8");
      const actual = serialize(response.rows[table] ?? []);
      const [delta] = await tx.unsafe<{ missing: number; extra: number }[]>(`WITH expected AS (SELECT value FROM jsonb_array_elements($1::jsonb)),
        actual AS (SELECT value FROM jsonb_array_elements($2::jsonb))
        SELECT (SELECT count(*)::int FROM (TABLE expected EXCEPT ALL TABLE actual) m) AS missing,
               (SELECT count(*)::int FROM (TABLE actual EXCEPT ALL TABLE expected) e) AS extra`, [expected, actual]);
      if (delta.missing || delta.extra) throw new Error(`Round-trip mismatch: ${table}; missing=${delta.missing} extra=${delta.extra}`);
      counts[table] = response.rows[table]?.length ?? 0;
    }
    return counts;
  });
}
