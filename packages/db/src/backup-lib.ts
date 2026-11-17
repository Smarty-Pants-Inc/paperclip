import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { open as openFile, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
  /** Optional durability gate. A rejected archive must not prune history. */
  verifyBeforePrune?: (backupFile: string) => Promise<void>;
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
};

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
  violationReportFile?: string;
};

export type RestoreConstraintViolation = {
  schema: string;
  table: string;
  constraint: string;
  definition: string;
  action: "not_valid" | "skipped";
  count: number;
  samplePrimaryKeys: Record<string, unknown>[];
};

export type RunDatabaseRestoreResult = {
  constraintViolations: RestoreConstraintViolation[];
  violationReportFile: string | null;
  summary: string;
};

type TableConstraintDefinition = {
  constraint_name: string;
  schema_name: string;
  tablename: string;
  constraint_type: string;
  definition: string;
  check_expression: string | null;
  key_expressions: string[];
  exclusion_operators: string[];
  index_predicate: string | null;
  primary_key_columns: string[];
  violation_predicate?: string;
};

const CONSTRAINT_VIOLATION_PREFIX = "PAPERCLIP_CONSTRAINT_VIOLATION ";

function guardedConstraintStatement(constraint: TableConstraintDefinition): string {
  const table = quoteQualifiedName(constraint.schema_name, constraint.tablename);
  const add = `ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdentifier(constraint.constraint_name)} ${constraint.definition}`;
  if (/\bNOT VALID$/.test(constraint.definition) && constraint.constraint_type !== "f") return `${add};`;

  const canRemainNotValid = constraint.constraint_type === "c" || constraint.constraint_type === "f";
  let candidates = "";
  let predicate = constraint.violation_predicate ?? `(${constraint.check_expression}) IS FALSE`;
  if (constraint.constraint_type === "u" || constraint.constraint_type === "x") {
    const keys = constraint.key_expressions.map((expression, index) => `${expression} AS key_${index}`).join(", ");
    candidates = `candidates AS (SELECT tableoid AS relation_id, ctid AS row_id, ${keys} FROM ${table}${constraint.index_predicate ? ` WHERE ${constraint.index_predicate}` : ""}), `;
    const comparisons = constraint.key_expressions.map((_, index) => {
      const left = `a.key_${index}`;
      const right = `b.key_${index}`;
      if (constraint.constraint_type === "x") return `${left} ${constraint.exclusion_operators[index]} ${right}`;
      return constraint.definition.startsWith("UNIQUE NULLS NOT DISTINCT")
        ? `${left} IS NOT DISTINCT FROM ${right}` : `${left} = ${right}`;
    }).join(" AND ");
    predicate = `EXISTS (SELECT 1 FROM candidates a JOIN candidates b ON
      (a.relation_id, a.row_id) <> (b.relation_id, b.row_id) AND ${comparisons}
      WHERE a.relation_id = restored_row.tableoid AND a.row_id = restored_row.ctid)`;
  }
  const primaryKeys = constraint.primary_key_columns;
  const sample = primaryKeys.length === 0 ? "'[]'::json" : `(
    SELECT coalesce(json_agg(sample.key), '[]'::json) FROM (
      SELECT json_build_object(${primaryKeys.map(column => `${formatSqlLiteral(column)}, ${quoteIdentifier(column)}`).join(", ")}) AS key
      FROM violations ORDER BY ${primaryKeys.map(column => `violations.${quoteIdentifier(column)}`).join(", ")} LIMIT 5
    ) sample)`;
  const body = `DECLARE violation json; violation_action text := '${canRemainNotValid ? "not_valid" : "skipped"}';
BEGIN
  BEGIN
    ${add};
  EXCEPTION WHEN ${constraint.constraint_type === "c" ? "check_violation" : constraint.constraint_type === "x" ? "exclusion_violation" : constraint.constraint_type === "f" ? "foreign_key_violation OR invalid_foreign_key" : "unique_violation"} THEN
    ${canRemainNotValid ? `IF SQLSTATE = '42830' THEN violation_action := 'skipped'; ELSE ${add}${/\bNOT VALID$/.test(constraint.definition) ? "" : " NOT VALID"}; END IF;` : ""}
    WITH ${candidates}violations AS (SELECT restored_row.* FROM ${table} restored_row WHERE ${predicate})
    SELECT json_build_object(
      'schema', ${formatSqlLiteral(constraint.schema_name)},
      'table', ${formatSqlLiteral(constraint.tablename)},
      'constraint', ${formatSqlLiteral(constraint.constraint_name)},
      'definition', ${formatSqlLiteral(constraint.definition)},
      'action', violation_action,
      'count', (SELECT count(*) FROM violations),
      'samplePrimaryKeys', ${sample}
    ) INTO violation;
    RAISE WARNING '${CONSTRAINT_VIOLATION_PREFIX}%', violation;
  END;
END;`;
  return `DO ${formatSqlLiteral(body)};`;
}

type SequenceDefinition = {
  is_identity: boolean;
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: "YES" | "NO";
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
};

type TableDefinition = {
  schema_name: string;
  tablename: string;
};

type ExtensionDefinition = {
  extension_name: string;
  schema_name: string;
};

const DEFAULT_BACKUP_WRITE_BUFFER_BYTES = 1024 * 1024;
const BACKUP_DATA_CURSOR_ROWS = 100;
const BACKUP_CLI_STDERR_BYTES = 64 * 1024;
const BACKUP_BREAKPOINT_DETECT_BYTES = 64 * 1024;

const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO week key for grouping backups by calendar week (ISO 8601).
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthlyRetentionCutoff(nowMs: number, monthlyMonths: number): number {
  const months = Math.max(1, monthlyMonths);
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1);
}

/**
 * Tiered backup pruning:
 * - Daily tier: keep ALL backups from the last `dailyDays` days
 * - Weekly tier: keep the NEWEST backup per calendar week for `weeklyWeeks` weeks
 * - Monthly tier: keep the NEWEST backup per calendar month for `monthlyMonths` months
 * - Everything else is deleted
 */
function pruneOldBackups(backupDir: string, retention: BackupRetentionPolicy, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;

  const now = Date.now();
  const dailyCutoff = now - Math.max(1, retention.dailyDays) * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - Math.max(1, retention.weeklyWeeks) * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = monthlyRetentionCutoff(now, retention.monthlyMonths);

  type BackupEntry = { name: string; fullPath: string; mtimeMs: number };
  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    entries.push({ name, fullPath, mtimeMs: stat.mtimeMs });
  }

  // Sort newest first so the first entry per week/month bucket is the one we keep
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepWeekBuckets = new Set<string>();
  const keepMonthBuckets = new Set<string>();
  const toDelete: string[] = [];

  for (const entry of entries) {
    // Daily tier — keep everything within dailyDays
    if (entry.mtimeMs >= dailyCutoff) continue;

    const date = new Date(entry.mtimeMs);
    const week = isoWeekKey(date);
    const month = monthKey(date);

    // Weekly tier — keep newest per calendar week
    if (entry.mtimeMs >= weeklyCutoff) {
      if (keepWeekBuckets.has(week)) {
        toDelete.push(entry.fullPath);
      } else {
        keepWeekBuckets.add(week);
      }
      continue;
    }

    // Monthly tier — keep newest per calendar month
    if (entry.mtimeMs >= monthlyCutoff) {
      if (keepMonthBuckets.has(month)) {
        toDelete.push(entry.fullPath);
      } else {
        keepMonthBuckets.add(month);
      }
      continue;
    }

    // Beyond all retention tiers — delete
    toDelete.push(entry.fullPath);
  }

  for (const filePath of toDelete) {
    unlinkSync(filePath);
  }

  return toDelete.length;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatSqlLiteral(value: string): string {
  const sanitized = value.replace(/\u0000/g, "");
  let tag = "$paperclip$";
  while (sanitized.includes(tag)) {
    tag = `$paperclip_${Math.random().toString(36).slice(2, 8)}$`;
  }
  return `${tag}${sanitized}${tag}`;
}

function normalizeTableNameSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeTableSelector)
      .filter((value) => value.length > 0),
  );
}

function normalizeTableSelector(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.includes(".") ? trimmed : tableKey("public", trimmed);
}

function normalizeNullifyColumnMap(values: Record<string, string[]> | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!values) return out;
  for (const [tableName, columns] of Object.entries(values)) {
    const normalizedTable = normalizeTableSelector(tableName);
    if (normalizedTable.length === 0) continue;
    const normalizedColumns = new Set(
      columns
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    );
    if (normalizedColumns.size > 0) {
      out.set(normalizedTable, normalizedColumns);
    }
  }
  return out;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function nonSystemSchemaPredicate(identifier: string): string {
  // PostgreSQL reserves pg_ prefixes for system schemas, including temp/toast variants.
  return `${identifier} <> 'information_schema'
    AND ${identifier} NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function hasBackupTransforms(opts: RunDatabaseBackupOptions): boolean {
  return (opts.excludeTables?.length ?? 0) > 0 ||
    Object.keys(opts.nullifyColumns ?? {}).length > 0;
}

function formatPostgresArrayElement(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return formatPostgresArrayLiteral(value);
  const raw = value instanceof Date
    ? value.toISOString()
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  if (raw.length === 0 || /^null$/i.test(raw) || /[{}\s,"\\]/.test(raw)) {
    return `"${raw.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return raw;
}

function formatPostgresArrayLiteral(value: unknown[]): string {
  return `{${value.map(formatPostgresArrayElement).join(",")}}`;
}

function formatSqlValue(
  rawValue: unknown,
  columnName: string | undefined,
  nullifiedColumns: Set<string>,
  dataType?: string,
): string {
  const val = columnName && nullifiedColumns.has(columnName) ? null : rawValue;
  if (val === null || val === undefined) return "NULL";
  if (dataType === "json" || dataType === "jsonb") {
    return formatSqlLiteral(JSON.stringify(val));
  }
  if (dataType === "bytea" && val instanceof Uint8Array) {
    return `decode('${Buffer.from(val).toString("hex")}', 'hex')`;
  }
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return formatSqlLiteral(val.toISOString());
  if (Array.isArray(val)) return formatSqlLiteral(formatPostgresArrayLiteral(val));
  if (typeof val === "object") return formatSqlLiteral(JSON.stringify(val));
  return formatSqlLiteral(String(val));
}

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) {
    throw new Error("pg_dump did not expose stdout");
  }

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin),
  ]);
}

async function restoreWithPsql(opts: RunDatabaseRestoreOptions, connectTimeout: number, onWarning: (message: string) => void): Promise<void> {
  const psqlBin = process.env.PAPERCLIP_PSQL_PATH || "psql";
  const child = spawn(
    psqlBin,
    [
      `--dbname=${opts.connectionString}`,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connectTimeout),
      },
    },
  );

  if (!child.stdin) {
    throw new Error("psql did not expose stdin");
  }

  const warningLines = createInterface({ input: child.stderr!, crlfDelay: Infinity });
  const warningsClosed = new Promise<void>(resolve => warningLines.once("close", resolve));
  warningLines.on("line", onWarning);

  const input = opts.backupFile.endsWith(".gz")
    ? createReadStream(opts.backupFile).pipe(createGunzip())
    : createReadStream(opts.backupFile);

  await Promise.all([
    pipeline(input, child.stdin),
    waitForChildExit(child, psqlBin),
    warningsClosed,
  ]);
}

async function hasStatementBreakpoints(backupFile: string): Promise<boolean> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  let text = "";

  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (Buffer.byteLength(text, "utf8") >= BACKUP_BREAKPOINT_DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

async function* readRestoreStatements(backupFile: string): AsyncGenerator<string> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  stream.setEncoding("utf8");
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let statementLines: string[] = [];

  const flushStatement = () => {
    const statement = statementLines.join("\n").trim();
    statementLines = [];
    return statement;
  };

  try {
    for await (const line of reader) {
      if (line === STATEMENT_BREAKPOINT) {
        const statement = flushStatement();
        if (statement.length > 0) {
          yield statement;
        }
        continue;
      }
      statementLines.push(line);
    }

    const trailingStatement = flushStatement();
    if (trailingStatement.length > 0) {
      yield trailingStatement;
    }
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
}

export function createBufferedTextFileWriter(filePath: string, maxBufferedBytes = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
  const filePromise = openFile(filePath, "w");
  const flushThreshold = Math.max(1, Math.trunc(maxBufferedBytes));
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let firstChunk = true;
  let closed = false;
  let pendingWrite = Promise.resolve();

  const writeChunk = async (chunk: string | Buffer): Promise<void> => {
    const file = await filePromise;
    if (typeof chunk === "string") {
      await file.write(chunk, null, "utf8");
    } else {
      await file.write(chunk);
    }
  };

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const linesToWrite = bufferedLines;
    bufferedLines = [];
    bufferedBytes = 0;
    const chunkBody = linesToWrite.join("\n");
    const chunk = firstChunk ? chunkBody : `\n${chunkBody}`;
    firstChunk = false;
    pendingWrite = pendingWrite.then(() => writeChunk(chunk));
  };

  return {
    emit(line: string) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bufferedBytes >= flushThreshold) {
        flushBufferedLines();
      }
    },
    async drain() {
      if (closed) {
        throw new Error(`Cannot drain closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      await pendingWrite;
    },
    async writeRaw(chunk: string | Buffer) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      firstChunk = false;
      pendingWrite = pendingWrite.then(() => writeChunk(chunk));
      await pendingWrite;
    },
    async close() {
      if (closed) return;
      closed = true;
      flushBufferedLines();
      await pendingWrite;
      const file = await filePromise;
      await file.close();
    },
    async abort() {
      if (closed) return;
      closed = true;
      bufferedLines = [];
      bufferedBytes = 0;
      await pendingWrite.catch(() => {});
      await filePromise.then((file) => file.close()).catch(() => {});
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original backup failure if temporary file cleanup also fails.
        }
      }
    },
  };
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retention = opts.retention;
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const backupEngine = opts.backupEngine ?? "auto";
  let effectiveBackupEngine = backupEngine;
  const canUsePgDump = !hasBackupTransforms(opts);
  const excludedTableNames = normalizeTableNameSet(opts.excludeTables);
  const nullifiedColumnsByTable = normalizeNullifyColumnMap(opts.nullifyColumns);
  let sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
  let sqlClosed = false;
  const closeSql = async () => {
    if (sqlClosed) return;
    sqlClosed = true;
    await sql.end();
  };
  mkdirSync(opts.backupDir, { recursive: true });
  // Initial and final sleep checks can run within the same second. A failed
  // second checkpoint must never overwrite the first verified recovery point.
  const checkpointSuffix = opts.verifyBeforePrune ? `-${randomUUID()}` : "";
  const sqlFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}${checkpointSuffix}.sql`);
  const backupFile = `${sqlFile}.gz`;
  const writer = createBufferedTextFileWriter(sqlFile);

  try {
    if (backupEngine === "pg_dump" || (backupEngine === "auto" && canUsePgDump)) {
      await sql`SELECT 1`;
      let dumped = false;
      try {
        await closeSql();
        await runPgDumpBackup({
          connectionString: opts.connectionString,
          backupFile,
          connectTimeout,
        });
        dumped = true;
      } catch (error) {
        if (existsSync(backupFile)) {
          try { unlinkSync(backupFile); } catch { /* ignore */ }
        }
        if (backupEngine === "pg_dump") {
          throw error;
        }
        effectiveBackupEngine = "javascript";
        sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        sqlClosed = false;
      }
      if (dumped) {
        // Only an engine failure can select the JavaScript fallback. Once
        // pg_dump succeeds, archive verification or persistence failures
        // must retain their original error and must not reuse a closed writer.
        await writer.abort();
        const sizeBytes = statSync(backupFile).size;
        await opts.verifyBeforePrune?.(backupFile);
        const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);
        return { backupFile, sizeBytes, prunedCount };
      }
    }

    await sql`SELECT 1`;
    await sql`SET search_path = pg_catalog`;

    const emit = (line: string) => writer.emit(line);
    const emitStatement = (statement: string) => {
      emit(statement);
      emit(STATEMENT_BREAKPOINT);
    };
    const emitStatementBoundary = () => {
      emit(STATEMENT_BREAKPOINT);
    };

    emit("-- Paperclip database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emitStatement("BEGIN;");
    emitStatement("SET LOCAL session_replication_role = replica;");
    emitStatement("SET LOCAL client_min_messages = warning;");
    emitStatement("SET LOCAL check_function_bodies = false;");
    emit("");

    const allTables = await sql<TableDefinition[]>`
      SELECT table_schema AS schema_name, table_name AS tablename
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND ${sql.unsafe(nonSystemSchemaPredicate("table_schema"))}
      ORDER BY table_schema, table_name
    `;
    const tables = allTables;
    const includedTableNames = new Set(tables.map(({ schema_name, tablename }) => tableKey(schema_name, tablename)));
    const includedSchemas = new Set(tables.map(({ schema_name }) => schema_name));

    // Get all enums
    const enums = await sql<{ schema_name: string; typname: string; labels: string[] }[]>`
      SELECT n.nspname AS schema_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname
    `;
    for (const e of enums) includedSchemas.add(e.schema_name);

    const allSequences = await sql<SequenceDefinition[]>`
      SELECT
        false AS is_identity,
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.minimum_value,
        s.maximum_value,
        s.increment,
        s.cycle_option,
        tblns.nspname AS owner_schema,
        tbl.relname AS owner_table,
        attr.attname AS owner_column
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema
      LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
      LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
      LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
      LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("s.sequence_schema"))}
      ORDER BY s.sequence_schema, s.sequence_name
    `;
    const identitySequences = await sql<SequenceDefinition[]>`
      SELECT true AS is_identity, n.nspname AS sequence_schema, seq.relname AS sequence_name,
             format_type(options.seqtypid, NULL) AS data_type,
             options.seqstart::text AS start_value, options.seqmin::text AS minimum_value,
             options.seqmax::text AS maximum_value, options.seqincrement::text AS increment,
             CASE WHEN options.seqcycle THEN 'YES' ELSE 'NO' END AS cycle_option,
             owner_namespace.nspname AS owner_schema, owner.relname AS owner_table,
             attribute.attname AS owner_column
      FROM pg_sequence options
      JOIN pg_class seq ON seq.oid = options.seqrelid
      JOIN pg_namespace n ON n.oid = seq.relnamespace
      JOIN pg_depend dependency ON dependency.objid = seq.oid AND dependency.deptype = 'i'
        AND dependency.classid = 'pg_class'::regclass AND dependency.refclassid = 'pg_class'::regclass
      JOIN pg_class owner ON owner.oid = dependency.refobjid
      JOIN pg_namespace owner_namespace ON owner_namespace.oid = owner.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = owner.oid AND attribute.attnum = dependency.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, seq.relname
    `;
    const sequences = [...allSequences, ...identitySequences].filter(
      (seq) => !seq.owner_table || includedTableNames.has(tableKey(seq.owner_schema ?? "public", seq.owner_table)),
    );

    const schemas = new Set<string>(includedSchemas);
    for (const seq of sequences) schemas.add(seq.sequence_schema);
    const extraSchemas = [...schemas].filter((schemaName) => schemaName !== "public");
    if (extraSchemas.length > 0) {
      emit("-- Schemas");
      for (const schemaName of extraSchemas) {
        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`);
      }
      emit("");
    }

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emitStatement(`CREATE TYPE ${quoteQualifiedName(e.schema_name, e.typname)} AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const extensions = await sql<ExtensionDefinition[]>`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql'
      ORDER BY e.extname
    `;
    if (extensions.length > 0) {
      emit("-- Extensions");
      for (const extension of extensions) {
        emitStatement(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.extension_name)} WITH SCHEMA ${quoteIdentifier(extension.schema_name)};`,
        );
      }
      emit("");
    }

    if (sequences.length > 0) {
      emit("-- Sequences");
      for (const seq of sequences.filter(seq => !seq.is_identity)) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        emitStatement(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName} CASCADE;`);
        emitStatement(
          `CREATE SEQUENCE ${qualifiedSequenceName} AS ${seq.data_type} INCREMENT BY ${seq.increment} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value} START WITH ${seq.start_value}${seq.cycle_option === "YES" ? " CYCLE" : " NO CYCLE"};`,
        );
      }
      emit("");
    }

    // Get full CREATE TABLE DDL via column info
    for (const { schema_name, tablename } of tables) {
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const columns = await sql<{
        column_name: string;
        data_type: string;
        udt_schema: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
        identity_generation: "ALWAYS" | "BY DEFAULT" | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]>`
        SELECT column_name, data_type, udt_schema, udt_name, is_nullable, column_default, is_identity, identity_generation,
               character_maximum_length, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;

      emit(`-- Table: ${schema_name}.${tablename}`);
      emitStatement(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE;`);

      const colDefs: string[] = [];
      for (const col of columns) {
        let typeStr: string;
        if (col.data_type === "USER-DEFINED") {
          typeStr = quoteQualifiedName(col.udt_schema, col.udt_name);
        } else if (col.data_type === "ARRAY") {
          const elementType = col.udt_name.replace(/^_/, "");
          typeStr = col.udt_schema === "pg_catalog"
            ? `${elementType}[]`
            : `${quoteQualifiedName(col.udt_schema, elementType)}[]`;
        } else if (col.data_type === "character varying") {
          typeStr = col.character_maximum_length
            ? `varchar(${col.character_maximum_length})`
            : "varchar";
        } else if (col.data_type === "numeric" && col.numeric_precision != null) {
          typeStr =
            col.numeric_scale != null
              ? `numeric(${col.numeric_precision}, ${col.numeric_scale})`
              : `numeric(${col.numeric_precision})`;
        } else {
          typeStr = col.data_type;
        }

        let def = `  "${col.column_name}" ${typeStr}`;
        if (col.is_identity === "YES") {
          const sequence = sequences.find(seq => seq.is_identity && seq.owner_schema === schema_name
            && seq.owner_table === tablename && seq.owner_column === col.column_name);
          if (!sequence || !col.identity_generation) throw new Error(`Missing identity sequence for ${schema_name}.${tablename}.${col.column_name}`);
          def += ` GENERATED ${col.identity_generation} AS IDENTITY (SEQUENCE NAME ${quoteQualifiedName(sequence.sequence_schema, sequence.sequence_name)} START WITH ${sequence.start_value} INCREMENT BY ${sequence.increment} MINVALUE ${sequence.minimum_value} MAXVALUE ${sequence.maximum_value} ${sequence.cycle_option === "YES" ? "CYCLE" : "NO CYCLE"})`;
        } else if (col.column_default != null) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === "NO") def += " NOT NULL";
        colDefs.push(def);
      }

      // Primary key
      const pk = await sql<{ constraint_name: string; definition: string }[]>`
        SELECT c.conname AS constraint_name, pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = ${schema_name} AND t.relname = ${tablename} AND c.contype = 'p'
        ORDER BY c.conname
      `;
      for (const p of pk) {
        colDefs.push(`  CONSTRAINT ${quoteIdentifier(p.constraint_name)} ${p.definition}`);
      }

      emit(`CREATE TABLE ${qualifiedTableName} (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emitStatementBoundary();
      emit("");
    }

    const ownedSequences = sequences.filter((seq) => !seq.is_identity && seq.owner_table && seq.owner_column);
    if (ownedSequences.length > 0) {
      emit("-- Sequence ownership");
      for (const seq of ownedSequences) {
        emitStatement(
          `ALTER SEQUENCE ${quoteQualifiedName(seq.sequence_schema, seq.sequence_name)} OWNED BY ${quoteQualifiedName(seq.owner_schema ?? "public", seq.owner_table!)}.${quoteIdentifier(seq.owner_column!)};`,
        );
      }
      emit("");
    }

    const allTableConstraints = await sql<TableConstraintDefinition[]>`
      SELECT c.conname AS constraint_name,
             n.nspname AS schema_name,
             t.relname AS tablename,
             c.contype AS constraint_type,
             pg_get_constraintdef(c.oid) AS definition,
             pg_get_expr(c.conbin, c.conrelid) AS check_expression,
             ARRAY(SELECT pg_get_indexdef(c.conindid, position, false)
               FROM generate_series(1, (SELECT indnkeyatts FROM pg_index WHERE indexrelid = c.conindid)) position
               ORDER BY position) AS key_expressions,
             ARRAY(SELECT format('OPERATOR(%I.%s)', ns.nspname, operator.oprname)
               FROM unnest(c.conexclop) WITH ORDINALITY excluded(oid, position)
               JOIN pg_operator operator ON operator.oid = excluded.oid
               JOIN pg_namespace ns ON ns.oid = operator.oprnamespace ORDER BY excluded.position) AS exclusion_operators,
             (SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = c.conindid) AS index_predicate,
             ARRAY(SELECT attribute.attname FROM pg_constraint pk
               CROSS JOIN LATERAL unnest(pk.conkey) WITH ORDINALITY key(attnum, position)
               JOIN pg_attribute attribute ON attribute.attrelid = pk.conrelid AND attribute.attnum = key.attnum
               WHERE pk.conrelid = c.conrelid AND pk.contype = 'p' ORDER BY key.position) AS primary_key_columns
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype IN ('u', 'c', 'x')
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const tableConstraints = allTableConstraints.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));
    // Collect foreign keys now. Emit them after routines and standalone indexes
    // because PostgreSQL permits a non-constraint unique index to be the target
    // of a foreign key.
    const allForeignKeys = await sql<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      target_schema: string;
      target_table: string;
      definition: string;
      source_columns: string[];
      target_columns: string[];
      equality_operators: string[];
      primary_key_columns: string[];
      match_full: boolean;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        srcn.nspname AS source_schema,
        src.relname AS source_table,
        tgtn.nspname AS target_schema,
        tgt.relname AS target_table,
        pg_get_constraintdef(c.oid) AS definition,
        c.confmatchtype = 'f' AS match_full,
        ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.position) AS source_columns,
        ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.position) AS target_columns,
        ARRAY(SELECT format('OPERATOR(%I.%s)', ns.nspname, op.oprname)
          FROM unnest(c.conpfeqop) WITH ORDINALITY equality(oid, position)
          JOIN pg_operator op ON op.oid = equality.oid
          JOIN pg_namespace ns ON ns.oid = op.oprnamespace ORDER BY equality.position) AS equality_operators,
        ARRAY(SELECT a.attname FROM pg_constraint pk
          CROSS JOIN LATERAL unnest(pk.conkey) WITH ORDINALITY k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = pk.conrelid AND a.attnum = k.attnum
          WHERE pk.conrelid = c.conrelid AND pk.contype = 'p' ORDER BY k.position) AS primary_key_columns
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      WHERE c.contype = 'f'
        AND ${sql.unsafe(nonSystemSchemaPredicate("srcn.nspname"))}
      ORDER BY srcn.nspname, src.relname, c.conname
    `;
    const fks = allForeignKeys.filter(
      (fk) => includedTableNames.has(tableKey(fk.source_schema, fk.source_table))
        && includedTableNames.has(tableKey(fk.target_schema, fk.target_table)),
    );

    // JavaScript backups are used when a worktree seed filters or transforms
    // table data. Preserve user-defined routines before indexes because an
    // expression index may depend on a user-defined function.
    const routines = await sql<{ definition: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
        )
      ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    `;
    if (routines.length > 0) {
      emit("-- Functions and procedures");
      for (const routine of routines) {
        const definition = routine.definition.trimEnd();
        emitStatement(definition.endsWith(";") ? definition : `${definition};`);
      }
      emit("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const allIndexes = await sql<{ schema_name: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname AS schema_name, tablename, indexdef
      FROM pg_indexes
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("schemaname"))}
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = pg_indexes.schemaname
        )
      ORDER BY schemaname, tablename, indexname
    `;
    const indexes = allIndexes.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (indexes.length > 0) {
      emit("-- Indexes");
      for (const idx of indexes) {
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }

    // Dump data for each table
    for (const { schema_name, tablename } of tables) {
      const currentTableKey = tableKey(schema_name, tablename);
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const overrideIdentity = identitySequences.some(seq => seq.owner_schema === schema_name && seq.owner_table === tablename);
      const count = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${qualifiedTableName}`);
      if (excludedTableNames.has(currentTableKey) || (count[0]?.n ?? 0) === 0) continue;

      // Get column info for this table
      const cols = await sql<{ column_name: string; data_type: string; udt_schema: string; udt_name: string }[]>`
        SELECT column_name, data_type, udt_schema, udt_name
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${schema_name}.${tablename} (${count[0]!.n} rows)`);

      const nullifiedColumns = nullifiedColumnsByTable.get(currentTableKey) ?? new Set<string>();
      if (effectiveBackupEngine !== "javascript" && nullifiedColumns.size === 0) {
        emit(`COPY ${qualifiedTableName} (${colNames}) FROM stdin;`);
        await writer.writeRaw("\n");
        const copySql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        try {
          const copyStream = await copySql
            .unsafe(`COPY ${qualifiedTableName} (${colNames}) TO STDOUT`)
            .readable();
          for await (const chunk of copyStream) {
            await writer.writeRaw(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
        } finally {
          await copySql.end();
        }
        await writer.writeRaw("\\.\n");
        emitStatementBoundary();
        emit("");
        continue;
      }

      const binaryArray = (column: (typeof cols)[number]) => column.data_type === "ARRAY"
        && column.udt_schema === "pg_catalog" && column.udt_name === "_bytea";
      const projection = cols.some(binaryArray) ? cols.map(column => binaryArray(column)
        ? `${quoteIdentifier(column.column_name)}::text AS ${quoteIdentifier(column.column_name)}`
        : quoteIdentifier(column.column_name)).join(", ") : "*";
      const rowCursor = sql
        .unsafe(`SELECT ${projection} FROM ${qualifiedTableName}`)
        .values()
        .cursor(BACKUP_DATA_CURSOR_ROWS) as AsyncIterable<unknown[][]>;
      for await (const rows of rowCursor) {
        for (const row of rows) {
          const values = row.map((rawValue, index) =>
            formatSqlValue(rawValue, cols[index]?.column_name, nullifiedColumns, cols[index]?.data_type),
          );
          emitStatement(`INSERT INTO ${qualifiedTableName} (${colNames})${overrideIdentity ? " OVERRIDING SYSTEM VALUE" : ""} VALUES (${values.join(", ")});`);
        }
        await writer.drain();
      }
      emit("");
    }

    if (tableConstraints.length > 0) {
      emit("-- Check, unique and exclusion constraints");
      for (const constraint of tableConstraints) {
        emitStatement(guardedConstraintStatement(constraint));
      }
      emit("");
    }

    if (fks.length > 0) {
      emit("-- Foreign keys");
      for (const fk of fks) {
        const allNull = fk.source_columns.map(column => `restored_row.${quoteIdentifier(column)} IS NULL`).join(" AND ");
        const allNotNull = fk.source_columns.map(column => `restored_row.${quoteIdentifier(column)} IS NOT NULL`).join(" AND ");
        const equality = fk.source_columns.map((column, index) =>
          `referenced_row.${quoteIdentifier(fk.target_columns[index]!)} ${fk.equality_operators[index]} restored_row.${quoteIdentifier(column)}`).join(" AND ");
        const noMatch = `NOT EXISTS (SELECT 1 FROM ${quoteQualifiedName(fk.target_schema, fk.target_table)} referenced_row WHERE ${equality})`;
        const violationPredicate = fk.match_full
          ? `NOT (${allNull}) AND (NOT (${allNotNull}) OR ${noMatch})` : `(${allNotNull}) AND ${noMatch}`;
        emitStatement(guardedConstraintStatement({
          constraint_name: fk.constraint_name, schema_name: fk.source_schema, tablename: fk.source_table,
          constraint_type: "f", definition: fk.definition, check_expression: null,
          key_expressions: [], exclusion_operators: [], index_predicate: null,
          primary_key_columns: fk.primary_key_columns, violation_predicate: violationPredicate,
        }));
      }
      emit("");
    }

    const [statisticsSupport] = await sql<{ supported: boolean }[]>`
      SELECT current_setting('server_version_num')::int >= 140000
        AND to_regprocedure('pg_catalog.pg_get_statisticsobjdef(oid)') IS NOT NULL AS supported
    `;
    if (statisticsSupport?.supported) {
      const statistics = await sql<{
        schema_name: string;
        statistic_name: string;
        table_schema: string;
        tablename: string;
        statistics_target: number | null;
        definition: string;
      }[]>`
        SELECT n.nspname AS schema_name, s.stxname AS statistic_name,
               tn.nspname AS table_schema, t.relname AS tablename,
               s.stxstattarget AS statistics_target, pg_get_statisticsobjdef(s.oid) AS definition
        FROM pg_statistic_ext s
        JOIN pg_namespace n ON n.oid = s.stxnamespace
        JOIN pg_class t ON t.oid = s.stxrelid
        JOIN pg_namespace tn ON tn.oid = t.relnamespace
        WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        ORDER BY n.nspname, s.stxname
      `;
      for (const statistic of statistics) {
        if (!includedTableNames.has(tableKey(statistic.table_schema, statistic.tablename))) continue;
        if (statistic.schema_name !== "public" && !schemas.has(statistic.schema_name)) {
          emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(statistic.schema_name)};`);
          schemas.add(statistic.schema_name);
        }
        emitStatement(`${statistic.definition};`);
        if (statistic.statistics_target !== null && statistic.statistics_target >= 0) {
          emitStatement(`ALTER STATISTICS ${quoteQualifiedName(statistic.schema_name, statistic.statistic_name)} SET STATISTICS ${statistic.statistics_target};`);
        }
      }
    }

    const allTriggers = await sql<{
      schema_name: string;
      tablename: string;
      definition: string;
    }[]>`
      SELECT
        n.nspname AS schema_name,
        c.relname AS tablename,
        pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, c.relname, t.tgname
    `;
    const triggers = allTriggers.filter((entry) => (
      includedTableNames.has(tableKey(entry.schema_name, entry.tablename))
    ));
    if (triggers.length > 0) {
      emit("-- Triggers");
      for (const trigger of triggers) {
        emitStatement(`${trigger.definition};`);
      }
      emit("");
    }

    // Sequence values
    if (sequences.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        const val = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
          `SELECT last_value::text, is_called FROM ${qualifiedSequenceName}`,
        );
        const skipSequenceValue =
          seq.owner_table !== null
            && excludedTableNames.has(seq.owner_table);
        if (val[0] && !skipSequenceValue) {
          emitStatement(`SELECT setval('${qualifiedSequenceName.replaceAll("'", "''")}', ${val[0].last_value}, ${val[0].is_called ? "true" : "false"});`);
        }
      }
      emit("");
    }

    emitStatement("COMMIT;");
    emit("");

    await writer.close();

    // Compress the SQL file with gzip
    const sqlReadStream = createReadStream(sqlFile);
    const gzWriteStream = createWriteStream(backupFile);
    await pipeline(sqlReadStream, createGzip(), gzWriteStream);
    unlinkSync(sqlFile);

    const sizeBytes = statSync(backupFile).size;
    await opts.verifyBeforePrune?.(backupFile);
    const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);

    return {
      backupFile,
      sizeBytes,
      prunedCount,
    };
  } catch (error) {
    await writer.abort();
    if (existsSync(backupFile)) {
      try { unlinkSync(backupFile); } catch { /* ignore */ }
    }
    if (existsSync(sqlFile)) {
      try { unlinkSync(sqlFile); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    await closeSql();
  }
}

export async function runDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<RunDatabaseRestoreResult> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const constraintViolations: RestoreConstraintViolation[] = [];
  const collectWarning = (message: string) => {
    const prefixIndex = message.indexOf(CONSTRAINT_VIOLATION_PREFIX);
    if (prefixIndex < 0) return;
    const violation = JSON.parse(message.slice(prefixIndex + CONSTRAINT_VIOLATION_PREFIX.length)) as RestoreConstraintViolation;
    constraintViolations.push(violation);
    console.warn(`Restore constraint violation: ${JSON.stringify(violation)}`);
  };
  const finish = async (): Promise<RunDatabaseRestoreResult> => {
    const violationReportFile = constraintViolations.length > 0
      ? resolve(opts.violationReportFile ?? `${opts.backupFile}.restore-violations-${randomUUID()}.json`) : null;
    const summary = `restored with ${constraintViolations.length} constraint violations${violationReportFile ? `: see ${violationReportFile}` : ""}`;
    const result = { constraintViolations, violationReportFile, summary };
    if (violationReportFile) {
      await writeFile(violationReportFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      console.warn(summary);
    }
    return result;
  };
  let psqlRestoreError: unknown = null;
  try {
    await restoreWithPsql(opts, connectTimeout, collectWarning);
  } catch (error) {
    psqlRestoreError = error;
    if (!(await hasStatementBreakpoints(opts.backupFile))) {
      throw new Error(
        `Failed to restore ${basename(opts.backupFile)} with psql: ${sanitizeRestoreErrorMessage(error)}`,
      );
    }
  }

  if (psqlRestoreError === null) return finish();
  constraintViolations.length = 0;
  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout, onnotice: notice => collectWarning(notice.message ?? "") });

  try {
    await sql`SELECT 1`;
    for await (const statement of readRestoreStatements(opts.backupFile)) {
      await sql.unsafe(statement).execute();
    }
    return await finish();
  } catch (error) {
    const statementPreview = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).query === "string"
      ? String((error as Record<string, unknown>).query)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("--"))
      : null;
    const psqlMessage = psqlRestoreError === null ? "" : `; psql error: ${sanitizeRestoreErrorMessage(psqlRestoreError)}`;
    throw new Error(
      `Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(error)}${statementPreview ? ` [statement: ${statementPreview.slice(0, 120)}]` : ""}${psqlMessage}`,
    );
  } finally {
    await sql.end();
  }
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  return `${result.backupFile} (${size}${pruned})`;
}
