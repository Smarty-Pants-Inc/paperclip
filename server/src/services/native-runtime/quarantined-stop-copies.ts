import { constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, closeSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { restoreNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import {
  acknowledgedUserStopRequestedAt, nativeSessionKey, quarantinedCopiesRefusal, readRunnerdDurableIdentity,
  readSettledRunnerdProjection, runnerdStateBase, scopedRunnerdStateRoot, stopIssuedLifecycleCommandsOnly,
} from "./native-session-executor.js";

/**
 * One-off repair (RFL + rf-3): images before s6409 refused a person's Stop
 * follow-up with journal_commands_unsettled(runner.suspend|drain|shutdown) and
 * moved the session's runnerd state root into `<state base>/quarantine`
 * (quarantineRunnerdStateRoot). Every later inspection rechecks those copies
 * (quarantinedCopiesRefusal) and fails with quarantine_<refusal>, so the chat
 * stays dead on newer images. This archives exactly the copies whose only
 * unsettled commands are that Stop's own lifecycle commands, after the root is
 * re-projected from its database checkpoint. A copy is only ever moved; its
 * contents (Pi session JSONL, journal) are never deleted or changed.
 */

/** Sibling of `<state base>/quarantine`; never read by the admission recheck. */
export const QUARANTINE_ARCHIVE_DIRECTORY = "quarantine-archive";
const COPY_NAME = /^([a-f0-9]{64})\.(identity_indeterminate|identity_mismatch)\.(\d+)\.(\d+)\.([0-9a-f-]{36})$/;
const JOURNAL_MAX_BYTES = 256 * 1024 * 1024;
const IDENTITY_KEYS = ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"] as const;

export type QuarantinedCopyMeta = { name: string; stateKey: string; reason: string; quarantinedAt: number };

export function parseQuarantinedCopyName(name: string): QuarantinedCopyMeta | null {
  const match = COPY_NAME.exec(name);
  return match ? { name, stateKey: match[1]!, reason: match[2]!, quarantinedAt: Number(match[3]) } : null;
}

/** Database facts of the run the copy's journal names (identity.runId). */
export type StoppedRunFacts = {
  id: string; companyId: string; agentId: string; issueId: string | null;
  /** acknowledgedUserStopRequestedAt(run): the person's acknowledged Stop of this exact run, else null. */
  stopAt: number | null;
  /** basename(scopedRunnerdStateRoot(run's recorded nativeExecutionInput)), null when unreadable. */
  stateKey: string | null;
};

export type StopOnlyCopyDecision =
  | { match: true; runId: string }
  | { match: false; reason: string };

/**
 * THE selection predicate, shared by the dry-run count and --apply. A copy
 * matches only when ALL hold:
 *  1. its name is `<stateKey>.identity_indeterminate.<ms>.<pid>.<uuid>` (the
 *     reason quarantineRunnerdStateRoot gives a terminal_state_indeterminate
 *     owner);
 *  2. its own journal, read by readSettledRunnerdProjection with its own
 *     identity, refuses `journal_commands_unsettled(...)`: the quarantine
 *     reason derives from unsettled commands and nothing else;
 *  3. the journal's identity.runId is a run the PERSON Stopped:
 *     acknowledgedUserStopRequestedAt(run) is not null (cancelled +
 *     hasAcknowledgedNativeStopIntent), the s6409 rule;
 *  4. the copy's state key is that run's own state key;
 *  5. EVERY unsettled command of the journal is a pending runner.suspend,
 *     runner.drain or runner.shutdown journaled at or after that Stop, in that
 *     run's own journal (stopIssuedLifecycleCommandsOnly, the same function
 *     pendingLifecycleCommandsIssuedByStop uses).
 */
export function selectStopOnlyQuarantinedCopy(copy: QuarantinedCopyMeta | null, journal: unknown,
  copyRefusal: string | null, run: StoppedRunFacts | null): StopOnlyCopyDecision {
  const no = (reason: string): StopOnlyCopyDecision => ({ match: false, reason });
  if (!copy) return no("copy_name_unrecognized");
  if (copy.reason !== "identity_indeterminate") return no(`copy_reason_${copy.reason}`);
  if (copyRefusal === null) return no("copy_settled");
  if (!copyRefusal.startsWith("journal_commands_unsettled(")) return no(`copy_refusal_${copyRefusal.replace(/\(.*$/, "")}`);
  const runId = (journal as { identity?: { runId?: unknown } } | null)?.identity?.runId;
  if (typeof runId !== "string" || !run || run.id !== runId) return no("run_missing");
  if (run.stopAt === null) return no("run_not_person_stopped");
  if (run.stateKey !== copy.stateKey) return no("state_key_not_runs");
  if (!stopIssuedLifecycleCommandsOnly(journal, runId, run.stopAt)) return no("unsettled_not_stop_issued");
  return { match: true, runId };
}

function readJournal(copyRoot: string): unknown {
  const path = resolve(copyRoot, "control-plane", "control-plane-state.json");
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.size > JOURNAL_MAX_BYTES) return null;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(descriptor).toString("utf8")); } catch { return null; } finally { closeSync(descriptor); }
}

function journalIdentity(journal: unknown): Record<string, string> | null {
  const identity = (journal as { identity?: Record<string, unknown> } | null)?.identity;
  if (!identity) return null;
  const out: Record<string, string> = {};
  for (const key of IDENTITY_KEYS) {
    if (typeof identity[key] !== "string" || !identity[key]) return null;
    out[key] = identity[key] as string;
  }
  return out;
}

function isPlainDirectory(path: string): boolean {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  return Boolean(stats?.isDirectory() && !stats.isSymbolicLink());
}

export type QuarantinedCopyFacts = {
  path: string; copy: QuarantinedCopyMeta | null; journal: unknown; copyRefusal: string | null;
  run: StoppedRunFacts | null; decision: StopOnlyCopyDecision;
};

/** Read-only: every entry of `<state base>/quarantine` with its predicate decision. */
export async function readQuarantinedCopyFacts(db: Db): Promise<QuarantinedCopyFacts[]> {
  const quarantine = resolve(runnerdStateBase(), "quarantine");
  if (!isPlainDirectory(quarantine)) return [];
  const entries = readdirSync(quarantine).sort();
  const copies = entries.map(name => {
    const path = resolve(quarantine, name);
    const copy = parseQuarantinedCopyName(name);
    const journal = copy && isPlainDirectory(path) ? readJournal(path) : null;
    const identity = journalIdentity(journal);
    const projection = identity ? readSettledRunnerdProjection(path, identity) : { refused: "journal_unreadable" };
    return { path, copy, journal, identity, copyRefusal: projection.refused ?? null };
  });
  const runIds = [...new Set(copies.map(item => item.identity?.runId).filter((id): id is string => !!id))];
  const rows = runIds.length ? await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds)) : [];
  const runs = new Map(rows.map(row => {
    let stateKey: string | null = null;
    try {
      stateKey = basename(scopedRunnerdStateRoot(parseNativeExecutionInput(
        (row.runnerProfileJson as Record<string, unknown> | null)?.nativeExecutionInput)));
    } catch { stateKey = null; }
    return [row.id, { id: row.id, companyId: row.companyId, agentId: row.agentId, issueId: row.nativeIssueId,
      stopAt: acknowledgedUserStopRequestedAt(row), stateKey } satisfies StoppedRunFacts];
  }));
  return copies.map(({ path, copy, journal, identity, copyRefusal }) => {
    const run = identity ? runs.get(identity.runId) ?? null : null;
    return { path, copy, journal, copyRefusal, run, decision: selectStopOnlyQuarantinedCopy(copy, journal, copyRefusal, run) };
  });
}

/** The admission recheck as the stopped run's next inspection runs it, for
 * the session root of `stateKey` (re-projected or live). null = admitted by
 * the quarantine recheck; else `quarantine_<refusal>` (or `root_missing`). */
export function readBackQuarantineRecheck(stateKey: string): string | null {
  const root = resolve(runnerdStateBase(), stateKey);
  const identity = journalIdentity({ identity: readRunnerdDurableIdentity(root, true) });
  if (!identity) return "root_missing";
  return quarantinedCopiesRefusal(root, identity, { localRunner: false });
}

/** State keys of copies this repair archived (for the read-back). */
export function archivedCopyStateKeys(): string[] {
  const archive = resolve(runnerdStateBase(), QUARANTINE_ARCHIVE_DIRECTORY);
  if (!isPlainDirectory(archive)) return [];
  return [...new Set(readdirSync(archive).flatMap(name => parseQuarantinedCopyName(name)?.stateKey ?? []))];
}

export type RepairItem = {
  companyId: string; agentId: string | null; issueId: string | null; issueIdentifier: string | null; runId: string | null;
  copy: string; reason: string;
  state: "matching" | "archived" | "blocked";
  reprojected?: "present" | "restored" | "checkpoint_missing";
  archivedTo?: string; recheck?: string | null;
};
export type RepairResult = {
  apply: boolean; stateBase: string;
  companies: Record<string, { matching: RepairItem[]; nonMatchingByReason: Record<string, number> }>;
  matching: number; archived: number; blocked: number; nonMatching: number;
};

/** Dry-run by default. --apply re-projects the session root from its database
 * checkpoint when it is missing (restoreNativeRunnerCheckpoint, the call a
 * fresh warm launch makes in restoreWarmRunnerdController), then MOVES the copy
 * into `<state base>/quarantine-archive/<same name>` and writes a sidecar
 * `<name>.archived.json` beside it. Never deletes, never writes inside a copy.
 * Idempotent: an archived copy is no longer in `quarantine`. */
export async function repairStopOnlyQuarantinedCopies(db: Db, options: { apply?: boolean; companyId?: string } = {})
  : Promise<RepairResult> {
  const stateBase = resolve(runnerdStateBase());
  const facts = await readQuarantinedCopyFacts(db);
  const issueIds = [...new Set(facts.map(item => item.run?.issueId).filter((id): id is string => !!id))];
  const issueRows = issueIds.length ? await db.select({ id: issues.id, identifier: issues.identifier }).from(issues)
    .where(inArray(issues.id, issueIds)) : [];
  const identifiers = new Map(issueRows.map(row => [row.id, row.identifier]));
  const result: RepairResult = { apply: options.apply === true, stateBase, companies: {}, matching: 0, archived: 0, blocked: 0, nonMatching: 0 };
  for (const item of facts) {
    const companyId = item.run?.companyId ?? "unknown";
    if (options.companyId && companyId !== options.companyId) continue;
    const company = result.companies[companyId] ??= { matching: [], nonMatchingByReason: {} };
    if (!item.decision.match) {
      company.nonMatchingByReason[item.decision.reason] = (company.nonMatchingByReason[item.decision.reason] ?? 0) + 1;
      result.nonMatching++;
      continue;
    }
    const run = item.run!, copy = item.copy!;
    const entry: RepairItem = { companyId, agentId: run.agentId, issueId: run.issueId,
      issueIdentifier: run.issueId ? identifiers.get(run.issueId) ?? null : null, runId: run.id,
      copy: copy.name, reason: item.copyRefusal!, state: "matching" };
    company.matching.push(entry);
    result.matching++;
    if (!options.apply) continue;
    const root = resolve(stateBase, copy.stateKey);
    if (existsSync(root)) entry.reprojected = "present";
    else {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).limit(1);
      const execution = parseNativeExecutionInput((row?.runnerProfileJson as Record<string, unknown> | null)?.nativeExecutionInput);
      const restored = run.issueId ? await restoreNativeRunnerCheckpoint(db, { companyId, issueId: run.issueId, runId: run.id },
        root, nativeSessionKey(execution)) : null;
      entry.reprojected = restored ? "restored" : "checkpoint_missing";
    }
    if (entry.reprojected === "checkpoint_missing") { entry.state = "blocked"; result.blocked++; continue; }
    // Re-read the same predicate right before the move: only the exact proven copy moves.
    const [again] = (await readQuarantinedCopyFacts(db)).filter(fact => fact.path === item.path);
    if (!again?.decision.match) { entry.state = "blocked"; result.blocked++; continue; }
    const archive = resolve(stateBase, QUARANTINE_ARCHIVE_DIRECTORY);
    mkdirSync(archive, { recursive: true, mode: 0o700 });
    if (!isPlainDirectory(archive)) throw new Error("runner_state_directory_unsafe");
    const destination = resolve(archive, copy.name);
    if (existsSync(destination)) { entry.state = "blocked"; result.blocked++; continue; }
    renameSync(item.path, destination);
    writeFileSync(`${destination}.archived.json`, `${JSON.stringify({
      schema: "paperclip.runnerd-quarantine-archive.v1", copy: copy.name, from: "quarantine", runId: run.id, companyId,
      refusal: item.copyRefusal, rule: "stop_only_lifecycle_commands", archivedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    entry.state = "archived";
    entry.archivedTo = `${QUARANTINE_ARCHIVE_DIRECTORY}/${copy.name}`;
    entry.recheck = readBackQuarantineRecheck(copy.stateKey);
    result.archived++;
  }
  return result;
}
