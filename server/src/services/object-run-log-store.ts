import { beginIdleTrackedWork } from "./task-admission.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import type { StorageProvider } from "../storage/types.js";
import type { RunLogStore, RunLogHandle, RunLogBeginInput, RunLogPersistenceCause } from "./run-log-store.js";
import { createObjectByteJournal, ObjectJournalConflictError, ObjectJournalSourcePrefixProofUnavailableError, type ObjectJournalIOPriority, type ObjectJournalWriter } from "./object-byte-journal.js";
import { MAX_RUN_LOG_RECORD_BYTES } from "./run-log-record-limits.js";
import { notFound } from "../errors.js";

const MAX_SEGMENT_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = MAX_RUN_LOG_RECORD_BYTES;
const MAX_READ_BYTES = 4 * MAX_SEGMENT_BYTES;
const ALIGN_WINDOW_BYTES = 32_000;
// Most records are short, so the first alignment window rides along with the
// body read. Longer records continue with ALIGN_WINDOW_BYTES windows.
const ALIGN_FIRST_LOOKBACK_BYTES = 4096;
const DIGEST_ATTEMPTS = 3;
// A failed flush or close keeps what it holds and is retried this many times,
// with backoff, before the batch is spilled to the kept local file.
const FLUSH_ATTEMPTS = 3;
const CLOSE_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 100;
// Peers can retain all capacity when BOTH object storage and the spill fail.
// Finalization must release the run even when no capacity wake remains.
export const OBJECT_RUN_LOG_FINALIZE_ADMISSION_TIMEOUT_MS = 60_000;
// One journal append takes at most 8 MiB; kept batches stay under that.
const MAX_KEPT_BATCH_BYTES = MAX_RUN_LOG_RECORD_BYTES;

function finalizationError(error: unknown) {
  const cause = error as { name?: unknown; code?: unknown; message?: unknown;
    $metadata?: { httpStatusCode?: unknown } } | null;
  const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value)
    ? value : undefined;
  // Storage/parse errors can carry response bodies or log bytes in their message,
  // stack, or custom properties. Log only error identifiers and known journal codes.
  return {
    name: identifier(cause?.name) ?? "UnknownError",
    code: identifier(cause?.code),
    reason: typeof cause?.message === "string" && /^object_journal_[a-z0-9_]+$/.test(cause.message)
      ? cause.message : undefined,
    statusCode: typeof cause?.$metadata?.httpStatusCode === "number" ? cause.$metadata.httpStatusCode : undefined,
  };
}
/**
 * Where admitted bytes go when object storage keeps refusing them. For a run
 * `<company>/<agent>/<run>` the spill is `<dir>/<company>/<agent>/<run>.ndjson`
 * (the exact admitted NDJSON bytes, append-only) and its record is
 * `<run>.index.ndjson` (append-only: which bytes were spilled, at which journal
 * offset, why, and whether a later flush stored them). Nothing in this module
 * deletes or truncates either file.
 *
 * Custody: the default is `.spill` INSIDE the run-log data tree
 * (`<instance>/data/run-logs/.spill`, or `$RUN_LOG_BASE_PATH/.spill`), so the
 * copy that takes `data/run-logs` takes the spill with it. `.spill` cannot be
 * a company id, so it never collides with a local run log.
 */
export const RUN_LOG_SPILL_SUBDIR = ".spill";
/** Cleanup resolves another instance without changing the running server's environment. */
export function resolveObjectRunLogSpillDir(spillDir?: string, context: {
  env?: Record<string, string | undefined>;
  instanceRoot?: string;
  cwd?: string;
} = {}) {
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  return path.resolve(cwd, spillDir ?? env.RUN_LOG_SPILL_PATH
    ?? path.resolve(cwd,
      env.RUN_LOG_BASE_PATH ?? path.join(context.instanceRoot ?? resolvePaperclipInstanceRoot(), "data", "run-logs"),
      RUN_LOG_SPILL_SUBDIR,
    ));
}
function spillPaths(spillDir: string | undefined, logRef: string) {
  const segments = logRef.split("/");
  if (segments.length !== 3 || segments.some(segment => !/^[a-zA-Z0-9._-]+$/.test(segment) || /^\.+$/.test(segment)))
    throw new Error("Invalid object log reference");
  const base = path.resolve(resolveObjectRunLogSpillDir(spillDir), ...segments);
  return { path: `${base}.ndjson`, indexPath: `${base}.index.ndjson` };
}
export interface ObjectRunLogSpillRecord {
  v: 1;
  event: "spilled" | "recovered";
  at: string;
  logRef: string;
  attemptId?: string;
  /** Offset of these bytes in the spill file. */
  spillStart: number;
  bytes: number;
  sha256: string;
  /** Object-journal end when the batch was spilled (spilled) or after it was stored (recovered). */
  journalEnd: number;
  /** Journal cursors of the batch, so a later recovery restores them with the bytes. */
  sequence?: number;
  sourceCursor?: number;
  cause?: ReturnType<typeof finalizationError>;
}
async function readSpillIndex(indexPath: string) {
  const index = await fs.readFile(indexPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const records = index.split("\n").filter(Boolean).map(line => JSON.parse(line) as ObjectRunLogSpillRecord);
  const recovered = new Set(records.filter(entry => entry.event === "recovered").map(entry => entry.spillStart));
  const spilled = records.filter(entry => entry.event === "spilled");
  return { records, spilled, recovered, open: spilled.filter(entry => !recovered.has(entry.spillStart)) };
}
const SPILL_INDEX_SUFFIX = ".index.ndjson";
const SPILL_DATA_SUFFIX = ".ndjson";
const SPILL_LOG_REF = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
/**
 * ONE guard pass reads recovered copies back for at most this long in total.
 * The deleting paths ask while they hold the workspace lifecycle lock, and a
 * person's next turn waits on that lock: a store that stops answering costs a
 * pass this budget once, not one read deadline per spill.
 */
export const RUN_LOG_SPILL_READ_BACK_BUDGET_MS = 30_000;
const spillCustodyPass = new AsyncLocalStorage<{ readBackDeadline?: number }>();
/**
 * Run `work` as one guard pass: every custody decision made inside it shares
 * one read-back budget, counted from its first read-back. When the budget is
 * spent, each spill not yet read back is KEPT (`read_back_budget_exhausted`,
 * with its custody row) for the next pass; none is released unread. A pass
 * begun inside another joins it, so one deleting operation is one pass however
 * many times it asks.
 */
export function runLogSpillCustodyPass<T>(work: () => Promise<T>): Promise<T> {
  return spillCustodyPass.getStore() ? work() : spillCustodyPass.run({}, work);
}
const SPILL_CUSTODY_ROW = "kept: run-log spill custody unknown";
// Every run-log record, spilled or not, is `{"ts":…,"attemptId":…,"stream":…,"chunk":…}`.
const RUN_LOG_RECORD_MARK = /"stream":"(?:stdout|stderr|system)","chunk":/;
// A data file with no record is read this far for a run-log record before it is kept unread.
const SPILL_ORPHAN_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/** One recovered range: where it belongs in the object log, and what the spill file holds for it. */
interface SpillRecoveredRange {
  journalStart: number;
  bytes: number;
  /** Of the spill file's bytes for this range. */
  sha256: string;
  /** The journal end its `recovered` record claims. */
  journalEnd: number;
}
// Weakest to strongest evidence: with several stores, the row names the strongest.
const SPILL_READ_BACK_FAILURES = ["recovered_copy_store_unavailable", "recovered_copy_missing",
  "recovered_copy_unreadable", "recovered_copy_read_timeout", "recovered_copy_short", "recovered_copy_mismatch"] as const;
type SpillReadBackFailure = { reason: typeof SPILL_READ_BACK_FAILURES[number] } & Record<string, unknown>;
/** Read ranges back from one store's object log. null: every range hashes equal to the spill file. */
type SpillReadBack = (logRef: string, ranges: SpillRecoveredRange[], signal: AbortSignal) => Promise<SpillReadBackFailure | null>;
/**
 * The object stores of this process (production has one). Each reads a
 * recovered copy back through its own journal, so the deleting paths need no
 * storage wiring: a spill is released only by a store that really holds it.
 */
const spillReadBackStores = new Set<SpillReadBack>();

function isSpillRecord(value: unknown): value is ObjectRunLogSpillRecord {
  const entry = value as Partial<ObjectRunLogSpillRecord> | null;
  const offset = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return !!entry && typeof entry === "object" && !Array.isArray(entry) && entry.v === 1 &&
    (entry.event === "spilled" || entry.event === "recovered") &&
    typeof entry.logRef === "string" && SPILL_LOG_REF.test(entry.logRef) &&
    offset(entry.spillStart) && offset(entry.journalEnd) && offset(entry.bytes) && entry.bytes! > 0 &&
    typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256);
}
/**
 * Whether a `*.ndjson` with NO record beside it holds run-log bytes. Other
 * tools write `*.ndjson` too, and cleanup walks whole worktrees: only a file
 * that is empty, or was read in full and holds no run-log record, is not a
 * spill. A file too large to read in full is kept.
 */
async function orphanHoldsRunLogBytes(dataPath: string) {
  const file = await fs.open(dataPath, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return false;
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let at = 0, tail = ""; at < SPILL_ORPHAN_SCAN_MAX_BYTES;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, at);
      if (!bytesRead) return false;
      // latin1 keeps every byte: the mark is ASCII and may straddle two reads.
      const text = tail + chunk.toString("latin1", 0, bytesRead);
      if (RUN_LOG_RECORD_MARK.test(text)) return true;
      tail = text.slice(-64);
      at += bytesRead;
    }
    return true;
  } finally { await file.close(); }
}
/** sha256 of one range of the spill file; null when the file does not hold the whole range. */
async function spillRangeSha(file: Awaited<ReturnType<typeof fs.open>>, start: number, length: number) {
  const hash = createHash("sha256"), chunk = Buffer.alloc(Math.min(length, MAX_READ_BYTES));
  for (let at = start; at < start + length;) {
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, start + length - at), at);
    if (!bytesRead) return null;
    hash.update(chunk.subarray(0, bytesRead));
    at += bytesRead;
  }
  return hash.digest("hex");
}

/**
 * THE deletion rule for a kept spill, shared by every path that can remove one
 * (never-OK custody): the content guard and the spill listing below, and
 * through them instance cleanup, the workspace reaper and the scheduled sweep.
 * A spill's files may go ONLY when
 *   (a) its record parses and POSITIVELY names every byte on disk recovered, AND
 *   (b) the recovered copy, READ BACK from the object log, hashes equal
 *       (sha256 of both) to the spill file's bytes for every range.
 * Everything else keeps it. A record that is missing, empty, `{}`, `[]`, torn,
 * or silent about bytes on disk is NOT recovery proof; neither is a read-back
 * that fails, times out, comes back short or differs. Those are UNKNOWN: kept,
 * with a custody row naming the spill and the reason. Two things are not a
 * spill: an empty data file; and, OUTSIDE a spill directory only, a `*.ndjson`
 * with no record beside it that holds no run-log record at all.
 * `insideSpillDir`: the file sits in a run-log spill directory, where every
 * non-empty file is the only copy until proven otherwise, whatever it holds.
 * This never throws.
 */
async function runLogSpillCustody(indexPath: string, insideSpillDir: boolean): Promise<{ state: "none" | "recovered" } | { state: "kept"; reason: string }> {
  const dataPath = `${indexPath.slice(0, -SPILL_INDEX_SUFFIX.length)}${SPILL_DATA_SUFFIX}`;
  const kept = (reason: string, detail: Record<string, unknown> = {}) => {
    // `unrecovered` is the ordinary state; each caller reports it in its own refusal.
    if (reason !== "unrecovered")
      logger.warn({ spill: dataPath, index: indexPath, reason, ...detail }, SPILL_CUSTODY_ROW);
    return { state: "kept" as const, reason };
  };
  try {
    const absentIsNull = (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    };
    const bytesOnDisk = async () => (await fs.stat(dataPath).catch(absentIsNull))?.size ?? 0;
    let text: string | null;
    try {
      text = await fs.readFile(indexPath, "utf8").catch(absentIsNull);
    } catch (error) {
      return kept("index_unreadable", { error: finalizationError(error) });
    }
    const lines = (text ?? "").split("\n").filter(Boolean);
    if (!lines.length) {
      // No record and no bytes: an empty data file is not a spill. Bytes
      // beside an empty record, and run-log bytes whose record is missing,
      // are the only copy until proven otherwise.
      const bytes = await bytesOnDisk();
      if (text !== null) return bytes > 0 ? kept("index_empty", { bytes }) : { state: "none" };
      // No record at all. Inside the spill directory the file is not opened:
      // any bytes are kept, readable and decodable or not. Only outside it,
      // where cleanup walks whole worktrees and other tools write `*.ndjson`
      // too, is the file read for a run-log record.
      return (insideSpillDir ? bytes > 0 : await orphanHoldsRunLogBytes(dataPath))
        ? kept("index_missing", { bytes }) : { state: "none" };
    }
    const records: ObjectRunLogSpillRecord[] = [];
    for (const line of lines) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { return kept("index_unparseable"); }
      // `{}`, `[]` and every other shape the writer never wrote.
      if (!isSpillRecord(entry)) return kept("index_invalid_record");
      records.push(entry);
    }
    const logRef = records[0]!.logRef, named = { logRef };
    if (records.some(entry => entry.logRef !== logRef) ||
      path.basename(indexPath) !== `${logRef.split("/")[2]}${SPILL_INDEX_SUFFIX}`)
      return kept("index_names_another_run", named);
    const same = (a: ObjectRunLogSpillRecord, b: ObjectRunLogSpillRecord) =>
      a.spillStart === b.spillStart && a.bytes === b.bytes && a.sha256 === b.sha256;
    const spilled = records.filter(entry => entry.event === "spilled");
    const recoveries = records.filter(entry => entry.event === "recovered");
    if (recoveries.some(entry => !spilled.some(range => same(range, entry))))
      return kept("index_recovered_without_spilled", named);
    // (a) Every spilled range needs its own `recovered` record...
    if (spilled.some(range => !recoveries.some(entry => same(range, entry)))) return kept("unrecovered", named);
    // ...and every byte on disk needs a range: bytes no record points at are proven nowhere.
    let indexed = 0;
    for (const range of [...spilled].sort((a, b) => a.spillStart - b.spillStart)) {
      if (range.spillStart !== indexed)
        return kept(range.spillStart > indexed ? "data_without_index_entry" : "index_overlapping_entries", named);
      indexed += range.bytes;
    }
    const ranges: SpillRecoveredRange[] = [];
    const file = await fs.open(dataPath, "r").catch(absentIsNull);
    if (!file) return kept("spill_data_missing", named);
    try {
      const bytes = (await file.stat()).size;
      if (bytes !== indexed)
        return kept(bytes > indexed ? "data_without_index_entry" : "spill_data_short", { ...named, bytes, indexedBytes: indexed });
      // adoptSpill's placement rule: the journal end a range was spilled at,
      // moved past every earlier range spilled at that same end.
      let position = -1;
      for (const range of spilled) {
        position = Math.max(position, range.journalEnd);
        const sha256 = await spillRangeSha(file, range.spillStart, range.bytes);
        if (sha256 !== range.sha256) return kept("spill_data_mismatch", { ...named, spillStart: range.spillStart });
        ranges.push({ journalStart: position, bytes: range.bytes, sha256,
          journalEnd: Math.max(...recoveries.filter(entry => same(range, entry)).map(entry => entry.journalEnd)) });
        position += range.bytes;
      }
    } finally { await file.close(); }
    // (b) Read the recovered copy back from where it lives, inside this pass's budget.
    const pass = spillCustodyPass.getStore()!;
    const budgetLeft = (pass.readBackDeadline ??= Date.now() + RUN_LOG_SPILL_READ_BACK_BUDGET_MS) - Date.now();
    if (budgetLeft <= 0)
      return kept("read_back_budget_exhausted", { ...named, budgetMs: RUN_LOG_SPILL_READ_BACK_BUDGET_MS });
    const signal = AbortSignal.timeout(budgetLeft);
    let failure: SpillReadBackFailure = { reason: "recovered_copy_store_unavailable" }, equal = false;
    for (const readBack of spillReadBackStores) {
      const result = await readBack(logRef, ranges, signal).catch((error): SpillReadBackFailure => ({
        reason: signal.aborted ? "recovered_copy_read_timeout" : "recovered_copy_unreadable",
        error: finalizationError(error),
      }));
      if (!result) {
        equal = true;
        break;
      }
      if (SPILL_READ_BACK_FAILURES.indexOf(result.reason) >= SPILL_READ_BACK_FAILURES.indexOf(failure.reason))
        failure = result;
    }
    if (!equal) return kept(failure.reason, { ...named, ...failure });
    // The proof is of the bytes that were read: a spill that changed meanwhile is not proven.
    if (await fs.readFile(indexPath, "utf8").catch(absentIsNull) !== text || await bytesOnDisk() !== indexed)
      return kept("spill_changed_during_inspection", named);
    return { state: "recovered" };
  } catch (error) {
    return kept("spill_unreadable", { error: finalizationError(error) });
  }
}
// Installed node_modules: 141,591 entries; full content guard about 1.6 s.
// Seven times that tree fits; exceeding the budget keeps the candidate visibly.
const SPILL_CUSTODY_WALK_MAX_ENTRIES = 1_000_000;
let spillCustodyWalkBoundHits = 0;

/** One path a guard pass KEPT, and why. */
export interface RunLogSpillKept {
  /** `<company>/<agent>/<run>` for a spill; for any other kept file, its path below the spill directory. */
  logRef: string;
  path: string;
  reason: string;
}
/**
 * Inside a spill directory a non-empty file that is neither a spill nor its
 * record has no record that could name it recovered: kept, with a custody row.
 */
async function spillDirFileKept(filePath: string) {
  const bytes = (await fs.stat(filePath)).size;
  if (!bytes) return null;
  const reason = "spill_dir_file_without_record";
  logger.warn({ spill: filePath, reason, bytes }, SPILL_CUSTODY_ROW);
  return reason;
}

/**
 * Destructive cleanup's content guard. Roots/configuration can drift after a
 * writer spills: search the WHOLE candidate, at any depth, pruning no names.
 * spillPaths fixes only <company>/<agent>/<run>.index.ndjson below a root, not
 * where that root lives. Use the writer's reader, not another index dialect.
 * Symlink targets are not walked: rename/rm removes links, never their targets.
 * With no `*.ndjson` name this does only directory reads, not file-content IO.
 * Each spill it finds is decided by runLogSpillCustody, the one deletion rule.
 * A directory named `.spill` is the writer's default spill directory wherever
 * the walk meets it: below it EVERY non-empty file is kept unless a record
 * proves it recovered. Returns the first kept path and its reason, or null.
 */
export function findKeptRunLogSpillContent(candidatePath: string) {
  return runLogSpillCustodyPass(() => keptRunLogSpillContent(candidatePath));
}
async function keptRunLogSpillContent(candidatePath: string): Promise<{ path: string; reason: string } | null> {
  const pending = [candidatePath], inspected = new Set<string>();
  let visitedEntries = 0;
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      const insideSpillDir = directory.split(path.sep).includes(RUN_LOG_SPILL_SUBDIR);
      let entries;
      try {
        entries = await fs.opendir(directory);
      } catch (error) {
        // An already-absent candidate has nothing to lose. All other inspection
        // failures (including disappearing children) refuse destructive work.
        if (directory === candidatePath && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      for await (const entry of entries) {
        if (++visitedEntries > SPILL_CUSTODY_WALK_MAX_ENTRIES) {
          logger.warn({ candidatePath, visitedEntries, maxEntries: SPILL_CUSTODY_WALK_MAX_ENTRIES,
            walkBoundHits: ++spillCustodyWalkBoundHits }, "kept: walk bound hit");
          return { path: candidatePath, reason: "walk_bound_hit" };
        }
        const entryPath = path.join(directory, entry.name);
        // A spill is its record AND its data file. Either name finds it, so
        // bytes whose record is gone are found too; each spill is decided once.
        const spillIndex = entry.name.endsWith(SPILL_INDEX_SUFFIX) ? entryPath
          : entry.isFile() && entry.name.endsWith(SPILL_DATA_SUFFIX)
            ? `${entryPath.slice(0, -SPILL_DATA_SUFFIX.length)}${SPILL_INDEX_SUFFIX}` : undefined;
        if (spillIndex && !inspected.has(spillIndex)) {
          inspected.add(spillIndex);
          const custody = await runLogSpillCustody(spillIndex, insideSpillDir);
          if (custody.state === "kept")
            return { path: `${spillIndex.slice(0, -SPILL_INDEX_SUFFIX.length)}${SPILL_DATA_SUFFIX}`, reason: custody.reason };
        } else if (!spillIndex && insideSpillDir && entry.isFile()) {
          const reason = await spillDirFileKept(entryPath);
          if (reason) return { path: entryPath, reason };
        }
        if (entry.isDirectory()) pending.push(entryPath);
      }
    }
    return null;
  } catch (error) {
    logger.warn({ candidatePath, visitedEntries, error: finalizationError(error) },
      "kept: run-log spill content could not be read");
    return { path: candidatePath, reason: "content_unreadable" };
  }
}
export async function candidateHoldsUnrecoveredRunLogSpill(candidatePath: string): Promise<boolean> {
  return await findKeptRunLogSpillContent(candidatePath) !== null;
}

/**
 * Everything in a spill directory that runLogSpillCustody does NOT prove
 * recovered: bytes no flush has stored yet, every spill whose record or
 * recovered copy cannot prove otherwise, and every other non-empty file (the
 * writer puts nothing there but spills and their records). Each with its path
 * and reason, one guard pass for the whole directory.
 */
export function listKeptObjectRunLogSpills(spillDir?: string): Promise<RunLogSpillKept[]> {
  return runLogSpillCustodyPass(async () => {
    const root = resolveObjectRunLogSpillDir(spillDir), kept: RunLogSpillKept[] = [];
    const list = (dir: string) => fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    const logRef = (file: string) => path.relative(root, file).split(path.sep).join("/");
    for (const pending = [root]; pending.length;) {
      const directory = pending.pop()!, spills = new Set<string>();
      for (const file of await list(directory)) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) pending.push(filePath);
        if (!file.isFile()) continue;
        // The record names a spill and so does its data file, when the record is gone.
        const suffix = [SPILL_INDEX_SUFFIX, SPILL_DATA_SUFFIX].find(end => file.name.endsWith(end));
        if (suffix) spills.add(filePath.slice(0, -suffix.length));
        else {
          const reason = await spillDirFileKept(filePath);
          if (reason) kept.push({ logRef: logRef(filePath), path: filePath, reason });
        }
      }
      for (const spill of spills) {
        const custody = await runLogSpillCustody(`${spill}${SPILL_INDEX_SUFFIX}`, true);
        if (custody.state === "kept")
          kept.push({ logRef: logRef(spill), path: `${spill}${SPILL_DATA_SUFFIX}`, reason: custody.reason });
      }
    }
    return kept.sort((a, b) => (a.logRef < b.logRef ? -1 : a.logRef > b.logRef ? 1 : 0));
  });
}
/**
 * Every run (`<company>/<agent>/<run>`) whose spill is NOT proven recovered by
 * runLogSpillCustody, and every other kept file of the spill directory by its
 * path below it: see listKeptObjectRunLogSpills.
 */
export async function listUnrecoveredObjectRunLogSpills(spillDir?: string) {
  return (await listKeptObjectRunLogSpills(spillDir)).map(entry => entry.logRef);
}
/**
 * Read a run's kept spill. `unrecovered` is every spilled range that no later
 * flush stored, in order: the stored object log followed by `unrecovered` is
 * the admitted byte stream.
 */
export async function readObjectRunLogSpill(spillDir: string | undefined, logRef: string) {
  const paths = spillPaths(spillDir, logRef);
  const { records, open } = await readSpillIndex(paths.indexPath);
  const parts: Buffer[] = [];
  if (open.length) {
    const file = await fs.open(paths.path, "r");
    try {
      for (const entry of open) {
        const bytes = Buffer.alloc(entry.bytes);
        const { bytesRead } = await file.read(bytes, 0, entry.bytes, entry.spillStart);
        if (bytesRead !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
          throw new Error("object_run_log_spill_integrity_error");
        parts.push(bytes);
      }
    } finally { await file.close(); }
  }
  return { ...paths, records, unrecovered: Buffer.concat(parts) };
}
export interface ObjectRunLogStoreOptions {
  provider: StorageProvider;
  keyPrefix: string;
  /** Root of the kept local spill; see resolveObjectRunLogSpillDir. */
  spillDir?: string;
  /**
   * Test seam (mutation rows only): false turns OFF the upload of a kept spill
   * when a run's log is next begun or recovered. Production never sets it.
   */
  recoverSpill?: boolean;
  flushMs?: number;
  segmentBytes?: number;

  assertWriterAuthority: (input: RunLogBeginInput) => Promise<void>;
}
interface PendingAppend {
  bytes: Buffer;
  sequence: number;
  sourceCursor: number;
  resolve: (bytes: number) => void;
  reject: (error: unknown) => void;
}
/**
 * Admitted bytes that object storage refused. They stay here, in order, until a
 * later flush stores them. `bytes` is held in memory only until the batch is
 * durably in the spill file; after that a retry reads it back from there.
 */
interface KeptBatch {
  bytes?: Buffer;
  length: number;
  sha256: string;
  sequence: number;
  sourceCursor: number;
  spillStart?: number;
}
interface WriterState {
  handle: RunLogHandle;
  kept: KeptBatch[];
  flushAttempt: number;
  finalized: boolean;
  journal: ReturnType<typeof createObjectByteJournal>;
  writer: ObjectJournalWriter;
  pending: PendingAppend[];
  pendingBytes: number;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
  closed: boolean;
  admitting: Set<Promise<unknown>>;
  /** Cancels only this writer's capacity wait, never its kept-byte retries. */
  admissionAbort: AbortController;
  /** Serialize custody of refused source-less records behind earlier flushes. */
  refusedCustody?: Promise<void>;
  failure?: unknown;
  spillFailure?: unknown;
  signal?: AbortSignal;
  sourcePrefixVerified: boolean;
  coverageEligible: boolean;
  admittedSourceCursor: number;
  /** The spill holds bytes that cannot be placed in order; the journal is never closed as complete. */
  unplacedSpill?: boolean;
}

export function createObjectRunLogStore(options: ObjectRunLogStoreOptions): RunLogStore {
  const flushMs = options.flushMs ?? 1000;
  const segmentBytes = options.segmentBytes ?? MAX_SEGMENT_BYTES;
  if (
    !Number.isSafeInteger(flushMs) ||
    flushMs < 1 ||
    flushMs > 30_000 ||
    !Number.isSafeInteger(segmentBytes) ||
    segmentBytes < 1024 ||
    segmentBytes > MAX_SEGMENT_BYTES
  )
    throw new Error("Invalid object log batching limits");
  const writers = new Map<RunLogHandle, WriterState>();
  let totalPendingBytes = 0;
  let admissionBytes = 0;
  let admissions = 0;
  const capacityWaiters = new Set<() => void>();
  const capacityChanged = () => {
    for (const wake of capacityWaiters) wake();
    capacityWaiters.clear();
  };
  let activeUploads = 0;
  const uploadWaiters: Array<() => void> = [];
  async function acquireUpload(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (activeUploads >= 4)
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = uploadWaiters.indexOf(enter);
          if (index !== -1) uploadWaiters.splice(index, 1);
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        uploadWaiters.push(enter);
      });
    else activeUploads++;
    return () => {
      const next = uploadWaiters.shift();
      if (next) next();
      else activeUploads--;
    };
  }
  function journal(logRef: string, readPriority?: ObjectJournalIOPriority, readCache?: false) {
    if (!SPILL_LOG_REF.test(logRef))
      throw new Error("Invalid object log reference");
    return createObjectByteJournal({
      provider: options.provider,
      prefix: `${options.keyPrefix}/segments-v1/${logRef}`,
      readPriority,
      readCache,
    });
  }
  // Custody read-back (runLogSpillCustody): the recovered copy is read through
  // this store's own journal, from object storage and never from the read cache.
  spillReadBackStores.add(async (logRef, ranges, signal) => {
    const store = journal(logRef, "background", false), snapshot = await store.head(signal);
    if (!snapshot || snapshot.head.deleted) return { reason: "recovered_copy_missing" };
    const journalEnd = snapshot.head.end;
    for (const range of ranges) {
      const stop = range.journalStart + range.bytes;
      // A record that claims a journal end the object log does not reach names a short copy.
      if (journalEnd < range.journalEnd || journalEnd < stop)
        return { reason: "recovered_copy_short", journalEnd, recordedJournalEnd: range.journalEnd };
      const hash = createHash("sha256");
      for (let at = range.journalStart; at < stop; at += MAX_READ_BYTES) {
        const bytes = await store.readRange(snapshot.head, at, Math.min(MAX_READ_BYTES, stop - at), signal);
        if (bytes.length !== Math.min(MAX_READ_BYTES, stop - at))
          return { reason: "recovered_copy_short", journalEnd, shortReadAt: at };
        hash.update(bytes);
      }
      const journalSha256 = hash.digest("hex");
      if (journalSha256 !== range.sha256)
        return { reason: "recovered_copy_mismatch", journalStart: range.journalStart, bytes: range.bytes,
          spillSha256: range.sha256, journalSha256 };
    }
    return null;
  });
  function schedule(state: WriterState) {
    if (state.closed || state.failure || state.timer || state.flushing || !state.pending.length)
      return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush(state).catch(() => undefined);
    }, flushMs);
  }
  const runIdOf = (state: WriterState) => state.handle.logRef.split("/")[2];
  // Retrying cannot help a lost ownership, a cancelled run or a stalled store
  // (each stalled attempt would cost its whole deadline). Those keep the batch
  // and go straight to the spill; a later flush still retries it.
  function retryableStorageFailure(error: unknown, signal?: AbortSignal) {
    const name = (error as { name?: unknown } | null)?.name;
    return !signal?.aborted && !(error instanceof ObjectJournalConflictError) &&
      name !== "TimeoutError" && name !== "AbortError";
  }
  /** Append one batch to the journal. A failed attempt keeps the bytes and retries, bounded. */
  async function storeBatch(state: WriterState, bytes: Buffer, sequence: number, sourceCursor: number) {
    for (let attempt = 1; ; attempt++) {
      state.flushAttempt = attempt;
      let release: (() => void) | undefined;
      try {
        release = await acquireUpload(state.signal);
        // The append is idempotent for the same writer and bytes: payload and
        // index objects are content-addressed, and the head publication is a
        // compare-and-swap that recognises its own earlier success.
        state.writer = await state.journal.append(
          state.writer, bytes, state.signal,
          Math.max(sequence, state.writer.head.sequence),
          Math.max(sourceCursor, state.writer.head.sourceCursor),
        );
        return;
      } catch (error) {
        if (attempt >= FLUSH_ATTEMPTS || !retryableStorageFailure(error, state.signal)) throw error;
        logger.warn({ runId: runIdOf(state), step: "flush", attempt, maxAttempts: FLUSH_ATTEMPTS,
          err: finalizationError(error) }, "Object run log flush failed; keeping the batch and retrying");
      } finally { release?.(); }
      await delay(RETRY_BACKOFF_MS * 2 ** (attempt - 1), undefined, { signal: state.signal }).catch(() => undefined);
    }
  }
  async function recordProof(state: WriterState) {
    if (!state.sourcePrefixVerified) return;
    try {
      state.writer = await state.journal.recordVerifiedSourcePrefix(
        state.writer, state.writer.head.sourceCursor, state.signal,
      );
    } catch (error) {
      if (!(error instanceof ObjectJournalSourcePrefixProofUnavailableError)) throw error;
      // The byte/index/head append is already committed. Lose only the
      // optional provenance optimization; later appends remain deliverable.
      state.writer = error.writer;
      state.sourcePrefixVerified = false;
      state.coverageEligible = false;
    }
  }
  const released = (state: WriterState, bytes: number) => {
    state.pendingBytes -= bytes;
    totalPendingBytes -= bytes;
  };
  async function appendDurably(file: string, bytes: Buffer) {
    const handle = await fs.open(file, "a", 0o600);
    try {
      const start = (await handle.stat()).size;
      await handle.appendFile(bytes);
      await handle.sync();
      return start;
    } finally { await handle.close(); }
  }
  /**
   * Write one kept batch to the run's spill file and record it. Returns false
   * when the local disk refused too; the batch then stays in memory.
   */
  async function spill(state: WriterState, kept: KeptBatch, cause: unknown) {
    if (!kept.bytes || kept.spillStart !== undefined) return true;
    try {
      const paths = spillPaths(options.spillDir, state.handle.logRef);
      await fs.mkdir(path.dirname(paths.path), { recursive: true, mode: 0o700 });
      // Append-only. A torn write leaves bytes no record points at; it is never truncated.
      const spillStart = await appendDurably(paths.path, kept.bytes);
      const entry: ObjectRunLogSpillRecord = {
        v: 1, event: "spilled", at: new Date().toISOString(), logRef: state.handle.logRef,
        attemptId: state.handle.attemptId, spillStart, bytes: kept.length, sha256: kept.sha256,
        journalEnd: state.writer.head.end, sequence: kept.sequence, sourceCursor: kept.sourceCursor,
        cause: finalizationError(cause),
      };
      await appendDurably(paths.indexPath, Buffer.from(`${JSON.stringify(entry)}\n`));
      kept.spillStart = spillStart;
      state.spillFailure = undefined;
      kept.bytes = undefined;
      released(state, kept.length);
      logger.warn({ runId: runIdOf(state), step: "flush", err: finalizationError(cause),
        spill: { path: paths.path, start: spillStart, bytes: kept.length, journalEnd: entry.journalEnd } },
        "Object run log batch kept in the local spill file");
      return true;
    } catch (error) {
      state.spillFailure = error;
      logger.error({ runId: runIdOf(state), step: "spill", bytes: kept.length, err: finalizationError(error) },
        "Object run log spill failed; the batch stays in memory");
      return false;
    }
  }
  async function keptBytes(state: WriterState, kept: KeptBatch) {
    if (kept.bytes) return kept.bytes;
    const bytes = Buffer.alloc(kept.length);
    const file = await fs.open(spillPaths(options.spillDir, state.handle.logRef).path, "r");
    try {
      const { bytesRead } = await file.read(bytes, 0, kept.length, kept.spillStart!);
      if (bytesRead !== kept.length || createHash("sha256").update(bytes).digest("hex") !== kept.sha256)
        throw new Error("object_run_log_spill_integrity_error");
    } finally { await file.close(); }
    return bytes;
  }
  /**
   * Take custody of admitted records that could not be stored: keep them in
   * order, spill them, and only then tell their producers they are not in
   * object storage. Nothing admitted is discarded here.
   */
  async function keep(state: WriterState, items: PendingAppend[], error: unknown) {
    state.failure = error;
    let group: PendingAppend[] = [], size = 0;
    const groups: PendingAppend[][] = [];
    for (const item of items) {
      if (group.length && size + item.bytes.length > MAX_KEPT_BATCH_BYTES) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(item);
      size += item.bytes.length;
    }
    if (group.length) groups.push(group);
    for (const members of groups) {
      const bytes = Buffer.concat(members.map(item => item.bytes));
      const kept: KeptBatch = {
        bytes, length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        sequence: members.reduce((cursor, item) => Math.max(cursor, item.sequence), 0),
        sourceCursor: members.reduce((cursor, item) => Math.max(cursor, item.sourceCursor), 0),
      };
      state.kept.push(kept);
      await spill(state, kept, error);
    }
    for (const item of items) item.reject(error);
  }
  async function recordRecovered(state: WriterState, kept: { spillStart: number; length: number; sha256: string }) {
    // The spill file is kept as it is; the record says these bytes are now stored.
    const entry: ObjectRunLogSpillRecord = {
      v: 1, event: "recovered", at: new Date().toISOString(), logRef: state.handle.logRef,
      attemptId: state.handle.attemptId, spillStart: kept.spillStart, bytes: kept.length,
      sha256: kept.sha256, journalEnd: state.writer.head.end,
    };
    try {
      await appendDurably(spillPaths(options.spillDir, state.handle.logRef).indexPath,
        Buffer.from(`${JSON.stringify(entry)}\n`));
    } catch (error) {
      logger.error({ runId: runIdOf(state), step: "spill", bytes: kept.length, err: finalizationError(error) },
        "Object run log spill recovery record failed; the stored log is complete");
    }
  }
  async function journalRangeSha(state: Pick<WriterState, "journal" | "writer" | "signal">, start: number, length: number) {
    const hash = createHash("sha256");
    for (let at = start; at < start + length; at += MAX_READ_BYTES)
      hash.update(await state.journal.readRange(state.writer.head, at, Math.min(MAX_READ_BYTES, start + length - at), state.signal));
    return hash.digest("hex");
  }
  /**
   * Take back the run's spilled ranges that no flush has stored, so they are
   * stored first, at the journal offset they were admitted at. A range already
   * in the journal (stored, but its record was lost) is only recorded. A range
   * that no longer fits the journal end stays in the spill, untouched.
   */
  async function adoptSpill(state: WriterState) {
    if (options.recoverSpill === false) return;
    const index = await readSpillIndex(spillPaths(options.spillDir, state.handle.logRef).indexPath);
    // `position` is where a range belongs in the journal: the journal end it
    // was spilled at, moved past every earlier range spilled at that same end.
    let position = -1, adopted = 0;
    for (const entry of index.spilled) {
      position = Math.max(position, entry.journalEnd);
      if (index.recovered.has(entry.spillStart)) {
        position += entry.bytes;
        continue;
      }
      const end = state.writer.head.end;
      if (!adopted && end >= position + entry.bytes &&
        await journalRangeSha(state, position, entry.bytes) === entry.sha256) {
        await recordRecovered(state, { spillStart: entry.spillStart, length: entry.bytes, sha256: entry.sha256 });
        position += entry.bytes;
        continue;
      }
      if (end + adopted !== position) {
        state.unplacedSpill = true;
        logger.error({ runId: runIdOf(state), step: "spill",
          spill: { start: entry.spillStart, bytes: entry.bytes, journalEnd: entry.journalEnd }, journalEnd: end },
          "Object run log spill does not fit the journal end; it stays in the spill file");
        break;
      }
      state.kept.push({ length: entry.bytes, sha256: entry.sha256, spillStart: entry.spillStart,
        sequence: entry.sequence ?? 0, sourceCursor: entry.sourceCursor ?? 0 });
      adopted += entry.bytes;
      position += entry.bytes;
    }
  }
  /** Store every kept batch, oldest first, before any newer bytes. */
  async function storeKept(state: WriterState) {
    while (state.kept.length) {
      const kept = state.kept[0]!;
      try {
        await storeBatch(state, await keptBytes(state, kept), kept.sequence, kept.sourceCursor);
      } catch (error) {
        state.failure = error;
        // An earlier spill may have failed; the local disk gets another chance.
        for (const waiting of state.kept) await spill(state, waiting, error);
        throw error;
      }
      state.kept.shift();
      if (kept.spillStart === undefined) released(state, kept.length);
      else await recordRecovered(state, { spillStart: kept.spillStart, length: kept.length, sha256: kept.sha256 });
    }
    // The journal again holds every admitted byte in order: admission may resume.
    state.failure = undefined;
  }
  const holdsBytes = (state: WriterState) => state.kept.some(kept => kept.bytes) || state.pending.length > 0;
  function retire(state: WriterState) {
    // A finalized writer leaves only when it holds nothing in memory.
    if (state.finalized && !holdsBytes(state) && !state.flushing && writers.get(state.handle) === state)
      writers.delete(state.handle);
  }
  async function flush(state: WriterState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.flushing) {
      // Another flush failing is not a reason to skip this one's own pass:
      // it re-reads the kept and pending bytes below.
      await state.flushing.catch(() => undefined);
      return flush(state);
    }
    if (!state.kept.length) {
      if (state.failure) throw state.failure;
      if (!state.pending.length) return;
    }
    state.flushing = (async () => {
      let batch: PendingAppend[] = [];
      try {
        await storeKept(state);
        batch = state.pending.splice(0);
        if (!batch.length) return;
        const bytes = Buffer.concat(batch.map((p) => p.bytes));
        await storeBatch(
          state, bytes,
          batch.reduce((cursor, item) => Math.max(cursor, item.sequence), 0),
          batch.reduce((cursor, item) => Math.max(cursor, item.sourceCursor), 0),
        );
        // Stored. From here the batch must never be appended again.
        const stored = batch;
        batch = [];
        released(state, bytes.length);
        try {
          await recordProof(state);
        } catch (error) {
          for (const item of stored) item.reject(error);
          throw error;
        }
        for (const item of stored) item.resolve(item.bytes.length);
      } catch (error) {
        state.failure = error;
        // The failed batch and everything admitted behind it are kept, in order.
        // The failed batch stays its own unit, so a retry re-sends exactly the
        // bytes of the failed append and stays idempotent.
        const behind = state.pending.splice(0);
        if (batch.length) await keep(state, batch, error);
        if (behind.length) await keep(state, behind, error);
        throw error;
      } finally {
        capacityChanged();
        state.flushing = undefined;
        schedule(state);
        retire(state);
      }
    })();
    await state.flushing;
  }
  async function enqueue(handle: RunLogHandle, event: Parameters<RunLogStore["append"]>[1]) {
    const state = writers.get(handle);
    if (!state || state.closed) throw new Error("Object run log writer is closed");
    const admission = admit(state, handle, event);
    state.admitting.add(admission);
    try { return await admission; }
    finally { state.admitting.delete(admission); }
  }
  async function admit(state: WriterState, handle: RunLogHandle, event: Parameters<RunLogStore["append"]>[1]) {
    const admissionSignal = state.signal
      ? AbortSignal.any([state.signal, state.admissionAbort.signal]) : state.admissionAbort.signal;
    admissionSignal.throwIfAborted();
    if (state.failure) throw state.failure;
    const bytes = Buffer.from(
      `${JSON.stringify({
        ts: event.ts,
        attemptId: handle.attemptId,
        stream: event.stream,
        chunk: event.chunk,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      })}\n`,
    );
    if (bytes.length > MAX_PENDING_BYTES)
      throw new Error("Object run log record exceeds pending-byte limit");
    let waiting = false;
    try {
      while (
        state.pendingBytes + bytes.length > MAX_PENDING_BYTES ||
        totalPendingBytes + bytes.length > 64 * MAX_SEGMENT_BYTES
      ) {
        admissionSignal.throwIfAborted();
        if (state.failure) throw state.failure;
        if (!waiting) {
          if (admissions >= 32 || admissionBytes + bytes.length > MAX_PENDING_BYTES)
            throw new Error("Object run log admission capacity exceeded");
          waiting = true;
          admissions++;
          admissionBytes += bytes.length;
        }
        for (const writer of writers.values())
          if (writer.pending.length) void flush(writer).catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            admissionSignal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            capacityWaiters.delete(wake);
            reject(admissionSignal.reason);
          };
          admissionSignal.addEventListener("abort", abort, { once: true });
          capacityWaiters.add(wake);
        });
      }
      admissionSignal.throwIfAborted();
      if (state.failure) throw state.failure;
      if (event.preservesSourceCoverage !== true || event.sourceCursor !== undefined &&
        (!Number.isSafeInteger(event.sourceCursor) || event.sourceCursor <= state.admittedSourceCursor)) {
        state.sourcePrefixVerified = false;
        state.coverageEligible = false;
      }
      state.admittedSourceCursor = Math.max(state.admittedSourceCursor, event.sourceCursor ?? 0);
      state.pendingBytes += bytes.length;
      totalPendingBytes += bytes.length;
      const finishIdle = beginIdleTrackedWork();
      const committed = new Promise<number>((resolve, reject) =>
        state.pending.push({
          bytes,
          sourceCursor: event.sourceCursor ?? state.writer.head.sourceCursor,
          sequence: event.seq ?? state.writer.head.sequence,
          resolve,
          reject,
        }),
      ).finally(finishIdle);
      if (state.pendingBytes >= segmentBytes) void flush(state).catch(() => undefined);
      else schedule(state);
      return { committed };
    } catch (error) {
      if (event.sourceCursor === undefined && state.admissionAbort.signal.aborted &&
        error === state.admissionAbort.signal.reason) {
        // The bound refuses admission, not custody. Native source-backed records
        // can be re-exported; stdout/stderr without a cursor have NO other copy.
        // Keep their exact encoded record behind earlier bytes, using the same
        // durable spill/index path. If the disk also refuses, retain memory and
        // its accounting, just like any other kept batch. Never advance a native
        // source cursor for these records or spill a source-backed refusal too.
        const previous = state.refusedCustody;
        const custody = (async () => {
          await previous;
          await state.flushing?.catch(() => undefined);
          if (event.preservesSourceCoverage !== true) {
            state.sourcePrefixVerified = false;
            state.coverageEligible = false;
          }
          state.pendingBytes += bytes.length;
          totalPendingBytes += bytes.length;
          await keep(state, [{ bytes, sequence: event.seq ?? state.writer.head.sequence,
            sourceCursor: state.writer.head.sourceCursor, resolve: () => undefined, reject: () => undefined }], error);
        })();
        state.refusedCustody = custody;
        await custody;
      }
      throw error;
    } finally {
      if (waiting) {
        admissions--;
        admissionBytes -= bytes.length;
      }
    }
  }
  async function incompleteLog(logRef: string, journal: WriterState["journal"], writer: ObjectJournalWriter, signal?: AbortSignal) {
    // The writer's kept index survives process retirement/restart. Add only
    // in-memory accounting: spilled batches have already released that count.
    // Do not infer missing bytes from a null final size or an open head (a
    // close/digest failure can leave every byte stored).
    const paths = spillPaths(options.spillDir, logRef);
    const custody = await runLogSpillCustody(paths.indexPath);
    const unknown = custody.state === "kept" && custody.reason !== "unrecovered";
    // Only an ordinary, validated unrecovered index may use the range proof
    // below. A corrupt/unreadable index is not an empty, complete-looking log.
    const { spilled, recovered } = custody.state === "kept" && !unknown
      ? await readSpillIndex(paths.indexPath) : { spilled: [], recovered: new Set<number>() };
    let bytes = 0, position = -1;
    const causes: RunLogPersistenceCause[] = [];
    if (unknown) {
      bytes = (await fs.stat(paths.path).catch(() => null))?.size ?? 0;
      causes.push({ name: "ObjectRunLogSpillCustodyUnknown", reason: "spill_custody_unknown", code: custody.reason });
    }
    for (const entry of spilled) {
      position = Math.max(position, entry.journalEnd);
      // The recovery record can fail AFTER its bytes reached object storage.
      // Use the same range proof as spill adoption before reporting them missing;
      // never trust a closed head alone or mutate the kept index on a log read.
      if (!recovered.has(entry.spillStart) && !(position + entry.bytes <= writer.head.end &&
        await journalRangeSha({ journal, writer, signal }, position, entry.bytes) === entry.sha256)) {
        bytes += entry.bytes;
        causes.push(entry.cause ?? { name: "UnknownError" });
      }
      position += entry.bytes;
    }
    for (const state of writers.values()) if (state.handle.logRef === logRef && state.pendingBytes > 0) {
      bytes += state.pendingBytes;
      causes.push(state.failure ? finalizationError(state.failure) : { name: "ObjectRunLogPendingWrite" });
    }
    return bytes > 0 || unknown ? { incomplete: { bytes, causes: [...new Map(causes.map(cause =>
      [JSON.stringify(cause), cause])).values()] } } : {};
  }
  const api: RunLogStore = {
    async begin(input) {
      const logRef = `${input.companyId}/${input.agentId}/${input.runId}`;
      const store = journal(logRef);
      let writer = await store.claim({
        assertAuthority: () => options.assertWriterAuthority(input),
        signal: input.signal,
      });
      // Bytes an earlier attempt spilled go into the journal first, at the
      // offset they were admitted at, so this attempt's bytes follow them.
      const recovering: WriterState = {
        handle: { store: "s3_segments", logRef }, kept: [], flushAttempt: 1, finalized: false, journal: store,
        writer, pending: [], pendingBytes: 0, closed: false, admitting: new Set(),
        admissionAbort: new AbortController(), signal: input.signal,
        sourcePrefixVerified: false, coverageEligible: false, admittedSourceCursor: writer.head.sourceCursor,
      };
      try {
        await adoptSpill(recovering);
      } catch (error) {
        input.signal?.throwIfAborted();
        recovering.kept = [];
        recovering.unplacedSpill = true;
        logger.error({ runId: input.runId, step: "spill", err: finalizationError(error) },
          "Object run log spill could not be read; it stays in the spill file");
      }
      if (recovering.kept.length) {
        try {
          await storeKept(recovering);
        } catch (error) {
          const unreadable = (error as { message?: unknown; code?: unknown } | null);
          if (unreadable?.message !== "object_run_log_spill_integrity_error" && unreadable?.code !== "ENOENT")
            // Storage still refuses the bytes. They stay in the spill; the log
            // is not begun past them (the caller retries, as for a failed claim).
            throw error;
          recovering.kept = [];
          recovering.unplacedSpill = true;
          logger.error({ runId: input.runId, step: "spill", err: finalizationError(error) },
            "Object run log spill failed its integrity check; it stays in the spill file");
        }
        writer = recovering.writer;
      }
      const sourcePrefixVerified = writer.head.generation > 1 && await store.hasVerifiedSourcePrefix(writer.head, input.signal);
      const handle: RunLogHandle = {
        store: "s3_segments",
        logRef,
        attemptId: randomUUID(),
        initialBytes: writer.head.end,
        initialSequence: writer.head.sequence,
        initialSourceCursor: writer.head.sourceCursor,
        initialSourcePrefixVerified: sourcePrefixVerified,
      };
      writers.set(handle, {
        handle,
        kept: [],
        flushAttempt: 1,
        finalized: false,
        journal: store,
        writer,
        pending: [],
        pendingBytes: 0,
        closed: false,
        admitting: new Set(),
        admissionAbort: new AbortController(),
        signal: input.signal,
        sourcePrefixVerified,
        coverageEligible: true,
        admittedSourceCursor: writer.head.sourceCursor,
        unplacedSpill: recovering.unplacedSpill,
      });
      return handle;
    },
    enqueue,
    async append(handle, event) {
      return (await enqueue(handle, event)).committed;
    },
    async flush(handle) {
      const state = writers.get(handle);
      if (!state) throw new Error("Object run log writer not found");
      await flush(state);
    },
    async recordVerifiedSourcePrefix(handle, sourceCursor) {
      const state = writers.get(handle);
      if (!state || state.closed) throw new Error("Object run log writer is closed");
      if (!state.coverageEligible) throw new Error("native_log_source_prefix_changed");
      await flush(state);
      if (!state.coverageEligible) throw new Error("native_log_source_prefix_changed");
      // Serialize metadata publication with byte flushes, including diagnostics
      // admitted while the one-time source proof is being recorded.
      state.flushing = (async () => {
        try {
          let proofUnavailable = false;
          try {
            state.writer = await state.journal.recordVerifiedSourcePrefix(state.writer, sourceCursor, state.signal);
          } catch (error) {
            if (!(error instanceof ObjectJournalSourcePrefixProofUnavailableError)) throw error;
            state.writer = error.writer;
            proofUnavailable = true;
          }
          if (!state.coverageEligible) throw new Error("native_log_source_prefix_changed");
          state.sourcePrefixVerified = !proofUnavailable;
          if (proofUnavailable) state.coverageEligible = false;
          state.admittedSourceCursor = Math.max(state.admittedSourceCursor, sourceCursor);
          handle.initialSourcePrefixVerified = state.sourcePrefixVerified;
          handle.initialSourceCursor = sourceCursor;
          handle.initialBytes = state.writer.head.end;
          handle.initialSequence = state.writer.head.sequence;
        } finally {
          state.flushing = undefined;
          schedule(state);
        }
      })();
      await state.flushing;
    },
    async finalize(handle, finalizeOptions) {
      const state = writers.get(handle);
      if (!state) throw new Error("Object run log writer not found");
      state.closed = true;
      capacityChanged();
      let step = "flush", attempt = 1;
      const maxAttempts = () => step === "digest" ? DIGEST_ATTEMPTS : step === "close" ? CLOSE_ATTEMPTS
        : step === "flush" ? FLUSH_ATTEMPTS : 1;
      const diagnostic = (error: unknown) => ({
        runId: handle.logRef.split("/")[2], step, attempt: step === "flush" ? state.flushAttempt : attempt,
        maxAttempts: maxAttempts(),
        err: finalizationError(error),
      });
      try {
        // A failure here keeps its batch (in memory or in the spill). Do not
        // stop: the second flush below retries the kept batch first.
        await flush(state).catch(() => undefined);
        step = "admissions";
        if (state.admitting.size) {
          const deadline = setTimeout(() => state.admissionAbort.abort(Object.assign(
            new Error("Object run log finalization admission timed out"),
            { name: "ObjectRunLogAdmissionTimeoutError", code: "object_run_log_finalize_admission_timeout" },
          )), OBJECT_RUN_LOG_FINALIZE_ADMISSION_TIMEOUT_MS);
          try {
            // Abort settles and removes this writer's waiters, including their
            // admission accounting. Already admitted bytes are NOT cancelled.
            await Promise.allSettled([...state.admitting]);
            state.admissionAbort.signal.throwIfAborted();
          } finally { clearTimeout(deadline); }
        }
        step = "flush";
        await flush(state);
        // Never close a journal that lacks admitted bytes: the open head marks it incomplete.
        if (state.kept.length || state.pending.length || state.unplacedSpill)
          throw state.failure ?? new Error("object_journal_kept_bytes");
        step = "close";
        for (;; attempt++) {
          try {
            // Publishing the closed head is idempotent, so a failed close is retried.
            state.writer = await state.journal.close(state.writer, state.signal);
            break;
          } catch (error) {
            if (attempt >= CLOSE_ATTEMPTS || !retryableStorageFailure(error, state.signal)) throw error;
            logger.warn(diagnostic(error), "Object run log close failed; retrying");
            await delay(RETRY_BACKOFF_MS * 2 ** (attempt - 1), undefined, { signal: state.signal }).catch(() => undefined);
          }
        }
        if (finalizeOptions?.computeDigest === false)
          return { bytes: state.writer.head.end, sha256: null, compressed: false };
        step = "digest";
        for (attempt = 1; ; attempt++) {
          try {
            // Retry only this read-only pass against the already closed snapshot.
            // Restart the hash too: an earlier range may have succeeded last time.
            const hash = createHash("sha256");
            for (let start = 0; start < state.writer.head.end; start += MAX_READ_BYTES) {
              hash.update(
                await state.journal.readRange(state.writer.head, start, MAX_READ_BYTES, state.signal),
              );
            }
            return { bytes: state.writer.head.end, sha256: hash.digest("hex"), compressed: false };
          } catch (error) {
            if (attempt >= DIGEST_ATTEMPTS || state.signal?.aborted) throw error;
            logger.warn(diagnostic(error), "Object run log digest failed; retrying read-only finalization");
            await delay(100 * attempt, undefined, { signal: state.signal });
          }
        }
      } catch (error) {
        // Whatever is still only in memory goes to the kept spill before the writer is released.
        const waiting = state.pending.splice(0);
        if (waiting.length) await keep(state, waiting, error);
        for (const kept of state.kept) await spill(state, kept, error);
        const spilled = state.kept.filter(kept => kept.spillStart !== undefined);
        const unspilledBytes = state.kept.reduce((sum, kept) => sum + (kept.bytes ? kept.length : 0), 0);
        logger.warn({
          ...diagnostic(error),
          // The target may hold no bytes itself: its admission is blocked by
          // peers whose admitted bytes still occupy memory. Name their custody
          // and BOTH sanitized storage causes, not just a generic timeout.
          ...(step === "admissions" ? { capacity: {
            location: "memory", stored: false, spilled: false,
            bytes: totalPendingBytes,
            writers: [...writers.values()].filter(writer => writer.pendingBytes > 0).map(writer => ({
              runId: runIdOf(writer), bytes: writer.pendingBytes,
              storageError: writer.failure ? finalizationError(writer.failure) : undefined,
              spillError: writer.spillFailure ? finalizationError(writer.spillFailure) : undefined,
            })),
          } } : {}),
          ...(spilled.length ? { spill: {
            path: spillPaths(options.spillDir, handle.logRef).path,
            start: spilled[0]!.spillStart, bytes: spilled.reduce((sum, kept) => sum + kept.length, 0),
            journalEnd: state.writer.head.end,
          } } : {}),
          ...(unspilledBytes ? { unspilledBytes } : {}),
        }, "Object run log finalization failed");
        if (unspilledBytes)
          logger.error({ runId: handle.logRef.split("/")[2], step: "spill", bytes: unspilledBytes },
            "Object run log bytes are held in memory only; the writer is kept until they are stored or spilled");
        process.emitWarning(
          "Run log persistence is incomplete; final size and digest are unknown.",
        );
        return { bytes: null, sha256: null, compressed: false };
      } finally {
        // Bytes that neither object storage nor the local disk accepted stay with
        // this writer. flushInflightMirrors (shutdown) and any later flush retry them.
        state.finalized = true;
        retire(state);
      }
    },
    async read(handle, opts = {}) {
      if (handle.store !== "s3_segments" && handle.store !== "s3_archive") throw new Error("Invalid object run log backend");
      const store = journal(handle.logRef, opts.priority ?? "interactive"),
        snapshot = await store.head(opts.signal) ?? writers.get(handle)?.writer;
      if (!snapshot || snapshot.head.deleted) throw notFound("Run log not found");
      const incomplete = await incompleteLog(handle.logRef, store, snapshot, opts.signal);
      const offset = Math.max(0, opts.offset ?? 0),
        limit = opts.limitBytes ?? 256_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_BYTES)
        throw new Error("Invalid object log read limit");
      const bodyLimit = Math.min(MAX_READ_BYTES, limit + 3);
      // Read the alignment window and the body in one range, so a tail read
      // walks the index once instead of once for each part.
      const lookback = opts.alignStartToRecord && offset > 0
        ? Math.min(offset, ALIGN_FIRST_LOOKBACK_BYTES, MAX_READ_BYTES - bodyLimit)
        : 0;
      const window = await store.readRange(
        snapshot.head,
        offset - lookback,
        lookback + bodyLimit,
        opts.signal,
      );
      const lookbackBytes = window.subarray(0, lookback);
      const fetched = window.subarray(lookback);
      let end = Math.min(limit, fetched.length);
      while (end < fetched.length && (fetched[end]! & 0xc0) === 0x80) end++;
      if (
        end === fetched.length &&
        offset + end < snapshot.head.end &&
        fetched.length === MAX_READ_BYTES
      ) {
        let lead = end - 1;
        while (lead >= 0 && (fetched[lead]! & 0xc0) === 0x80) lead--;
        const first = fetched[lead] ?? 0;
        const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (end - lead < width) end = lead;
      }
      const bytes = fetched.subarray(0, end);
      const nextOffset =
        offset + bytes.length < snapshot.head.end ? offset + bytes.length : undefined;
      if (!opts.alignStartToRecord || offset === 0 || bytes.length === 0)
        return { content: bytes.toString("utf8"), nextOffset, ...incomplete };
      const parts = [bytes];
      let before = offset;
      if (lookback > 0) {
        const boundary = lookbackBytes.lastIndexOf(10);
        parts.unshift(lookbackBytes.subarray(boundary + 1));
        before = boundary >= 0 ? 0 : offset - lookback;
        if (before > 0 && parts.reduce((n, part) => n + part.length, 0) > MAX_PENDING_BYTES)
          throw new Error("Object log record exceeds read alignment limit");
      }

      while (before > 0) {
        const start = Math.max(0, before - ALIGN_WINDOW_BYTES);
        const prefix = await store.readRange(snapshot.head, start, before - start, opts.signal);
        const boundary = prefix.lastIndexOf(10);
        parts.unshift(prefix.subarray(boundary + 1));
        if (boundary >= 0) break;
        before = start;
        if (parts.reduce((n, part) => n + part.length, 0) > MAX_PENDING_BYTES)
          throw new Error("Object log record exceeds read alignment limit");
      }
      return {
        content: Buffer.concat(parts).toString("utf8"),
        nextOffset: nextOffset ?? offset + bytes.length,
        ...incomplete,
      };
    },
    async flushInflightMirrors() {
      // Every writer gets its pass, including finalized ones that still hold bytes.
      const results = await Promise.allSettled([...writers.values()].map(flush));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
    listSpilledLogRefs: () => options.recoverSpill === false
      ? Promise.resolve([]) : listUnrecoveredObjectRunLogSpills(options.spillDir),
    async recoverSpill(input) {
      const logRef = `${input.companyId}/${input.agentId}/${input.runId}`;
      if (options.recoverSpill === false) return null;
      // A writer of this process still holds the run: its own flush stores the kept batch.
      for (const state of writers.values()) if (state.handle.logRef === logRef) return null;
      if (!(await readSpillIndex(spillPaths(options.spillDir, logRef).indexPath)).open.length) return null;
      // begin stores the spill at its recorded journal offset; finalize closes
      // the journal and digests it, and refuses both while any byte is missing.
      return api.finalize(await api.begin(input));
    },
  };
  return api;
}
