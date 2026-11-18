import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { DRAIN_COMPLETE_KEY } from "../native-runtime/native-workspace-finalization-ownership.js";
import { PERSON_STOP_ISOLATION_KEY, readNativeWorkspaceSyncReference, readPersonStopIsolationSource }
  from "../native-runtime/native-workspace-sync.js";

const execFileAsync = promisify(execFile);
const OWNER_KEY = "nativeWorkspaceFinalizationOwner";
const SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * adopt-stopu-isolate (org 03:29Z, "DRAIN-COMPLETE or ISOLATE"): ONLY a
 * drain-complete record lets a successor share the stopped run's host
 * workspace. It is written by the copyback owner's OWN join, after its action
 * and host-mutation drain finished (native-workspace-finalization-ownership.ts,
 * DRAIN_COMPLETE_KEY); a takeover that clears a dead owner (a process-death
 * join) never writes it, and a live owner record voids it.
 */
export function personStopDrainComplete(profile: Record<string, unknown> | null | undefined): boolean {
  return !profile?.[OWNER_KEY] && Boolean(profile?.[DRAIN_COMPLETE_KEY]);
}

export type PersonStopIsolationRecord = {
  schema: "paperclip.person-stop-isolation.v1";
  /** isolated: the successor owns a new generation; held: the named fallback (worktree / no seed). */
  kind: "isolated" | "held";
  runId: string;
  issueId: string;
  reason: string;
  /** The stopped run's aside: its old folder (its pinned localCwd) and old row. */
  asidePath: string;
  asideExecutionWorkspaceId: string;
  /** sha256 of the aside tree (personStopTreeSha256) when the record was written. */
  asideSha256: string;
  successorExecutionWorkspaceId: string | null;
  successorCwd: string | null;
  seedSha256: string | null;
  at: string;
};

export function personStopIsolatedNote(record: Pick<PersonStopIsolationRecord, "asidePath">): string {
  return "This task continues in a new workspace with its files as they were before the stopped turn. "
    + `The stopped turn's files are saved separately in ${record.asidePath}; nothing was overwritten. Ask me to restore them.`;
}

/** The named smallest safe fallback (project worktrees, or no verified seed). */
export function personStopHeldNote(record: Pick<PersonStopIsolationRecord, "asidePath">): string {
  return `The stopped turn may still be writing to this task's workspace (${record.asidePath}), so your message waits `
    + "until that has finished; nothing was overwritten. Press Retry to check again.";
}

export function readPersonStopIsolation(profile: Record<string, unknown> | null | undefined): PersonStopIsolationRecord | null {
  const value = profile?.[PERSON_STOP_ISOLATION_KEY] as PersonStopIsolationRecord | undefined;
  return value && value.schema === "paperclip.person-stop-isolation.v1" ? value : null;
}

/**
 * adopt-stopu-isolate (F9): the admission/release gate after a person's Stop.
 * - isolated: committed -> NO gate waits on the old (aside) writer.
 * - held (fallback): holds until the drain-complete record exists (the Retry re-check).
 * - no record: null (the caller's existing gates apply).
 */
export function personStopIsolationGate(profile: Record<string, unknown> | null | undefined): "released" | "held" | null {
  const record = readPersonStopIsolation(profile);
  if (!record) return null;
  if (record.kind === "isolated") return "released";
  return personStopDrainComplete(profile) ? "released" : "held";
}

/** Stable digest of a directory tree (type, relative path, mode bits, content hash). */
export async function personStopTreeSha256(root: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const entries = (await fs.readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []))
      .map(entry => entry.name).sort();
    for (const name of entries) {
      const rel = relative ? path.posix.join(relative, name) : name;
      const full = path.join(root, rel);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink()) digest.update(`l ${rel} ${await fs.readlink(full)}\n`);
      else if (stat.isDirectory()) { digest.update(`d ${rel}\n`); await walk(rel); }
      else if (stat.isFile()) digest.update(`f ${rel} ${stat.mode & 0o111 ? "x" : "-"} ${createHash("sha256").update(await fs.readFile(full)).digest("hex")}\n`);
    }
  };
  await walk("");
  return digest.digest("hex");
}

export type IsolateSuccessorGenerationResult =
  | { kind: "drain_complete" }
  | { kind: "not_applicable"; reason: string }
  | { kind: "isolated" | "held"; record: PersonStopIsolationRecord; committedNow: boolean };

/**
 * adopt-stopu-isolate: THE ONE generation step. Called by the bound/cap
 * decision (decidePersonStopExportAtBound; F5's cap and the owner-process-death
 * join reach it there: neither writes a drain-complete record), and read by the
 * admission/release gate (personStopIsolationGate, F9).
 *
 * Plain per-task folder (no project): the successor's generation is unpacked
 * from the stopped run's VERIFIED `workspace-seed.tar` (never a live copy of the
 * old folder) into upstream's isolated-attempt namespace
 * (`isolated-workspace-attempts/<company>/<issue>/<generation>`, see
 * native-chat-workspace.ts), then ONE transaction repoints the task
 * (issues.executionWorkspaceId -> a new row, workspaceBindingRevision + 1, as
 * fresh-continuation-fallback.ts does for fresh_isolated_workspace), writes the
 * durable aside record on the stopped run and ONE true note. The old row and
 * folder are the aside: the old writer's rename target is its descriptor's
 * pinned localCwd (native-workspace-sync.ts binding.localCwd), never the new
 * generation.
 *
 * Project worktree, or no verified seed: the named fallback ("held"): the task
 * is NOT repointed and does NOT share the old path; ONE true note + Retry, and
 * the gate holds until a drain-complete record exists.
 */
export async function isolateSuccessorGeneration(input: {
  db: Db; companyId: string; runId: string; reason: string; now?: Date;
  /** test seam only: a mutation that treats any join as drain-complete. */
  drainComplete?: (profile: Record<string, unknown> | null) => boolean;
}): Promise<IsolateSuccessorGenerationResult> {
  const { db } = input;
  const [run] = await db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  if (!run) return { kind: "not_applicable", reason: "run_missing" };
  const profile = (run.runnerProfileJson ?? null) as Record<string, unknown> | null;
  const existing = readPersonStopIsolation(profile);
  if (existing) return { kind: existing.kind, record: existing, committedNow: false };
  if ((input.drainComplete ?? personStopDrainComplete)(profile)) return { kind: "drain_complete" };
  const issueId = run.issueId ?? run.nativeIssueId;
  if (!issueId || !SAFE.test(issueId) || !SAFE.test(run.companyId)) return { kind: "not_applicable", reason: "no_task" };
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).limit(1);
  if (!issue?.executionWorkspaceId) return { kind: "not_applicable", reason: "task_not_bound" };
  const [bound] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, run.companyId))).limit(1);
  const reference = readNativeWorkspaceSyncReference(profile?.nativeWorkspaceSync);
  if (!bound?.cwd || !reference) return { kind: "not_applicable", reason: "no_bound_workspace" };
  const source = await readPersonStopIsolationSource({ runId: run.id, reference }).catch(() => null);
  const asidePath = path.resolve(source?.localCwd ?? bound.cwd);
  // Only the folder the stopped run's writer is pinned to is moved aside.
  if (path.resolve(bound.cwd) !== asidePath) return { kind: "not_applicable", reason: "task_bound_elsewhere" };
  const now = input.now ?? new Date();
  const worktree = bound.projectId !== null || bound.strategyType === "git_worktree" || Boolean(source?.git);
  let successorCwd: string | null = null;
  if (!worktree && source) {
    const instanceRoot = await fs.realpath(resolvePaperclipInstanceRoot());
    const parent = path.join(instanceRoot, "isolated-workspace-attempts", run.companyId, issueId);
    successorCwd = path.join(parent, randomUUID());
    const staging = `${successorCwd}.seeding`;
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await execFileAsync("tar", ["--no-same-owner", "-xf", source.workspaceArchivePath, "-C", staging]);
      await fs.rename(staging, successorCwd);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const kind: PersonStopIsolationRecord["kind"] = successorCwd ? "isolated" : "held";
  const asideSha256 = await personStopTreeSha256(asidePath);
  const committed = await db.transaction(async tx => {
    const [lockedIssue] = await tx.select({ executionWorkspaceId: issues.executionWorkspaceId }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).for("update");
    const [lockedRun] = await tx.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id)).for("update");
    const already = readPersonStopIsolation(lockedRun?.profile as Record<string, unknown> | null);
    if (already) return { record: already, now: false };
    if (lockedIssue?.executionWorkspaceId !== bound.id) return null;
    let successorExecutionWorkspaceId: string | null = null;
    if (successorCwd) {
      const { id: _id, createdAt: _c, updatedAt: _u, lastUsedAt: _l, openedAt: _o, closedAt: _cl, ...copy } = bound;
      const [created] = await tx.insert(executionWorkspaces).values({ ...copy, status: "active", cwd: successorCwd,
        providerRef: bound.providerRef === bound.cwd ? successorCwd : bound.providerRef, derivedFromExecutionWorkspaceId: bound.id,
        cleanupEligibleAt: null, cleanupReason: null,
        metadata: { ...(bound.metadata ?? {}), personStopGenerationOf: run.id } }).returning({ id: executionWorkspaces.id });
      successorExecutionWorkspaceId = created!.id;
      // The atomic repoint (the same step as fresh-continuation-fallback.ts's
      // fresh_isolated_workspace unbinding, here straight to the new row).
      await tx.update(issues).set({ executionWorkspaceId: successorExecutionWorkspaceId,
        workspaceBindingRevision: sql`${issues.workspaceBindingRevision} + 1`, updatedAt: now })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
      await tx.update(executionWorkspaces).set({ metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb)
        || ${JSON.stringify({ personStopAsideOf: run.id })}::jsonb`, updatedAt: now }).where(eq(executionWorkspaces.id, bound.id));
    }
    const record: PersonStopIsolationRecord = { schema: "paperclip.person-stop-isolation.v1", kind, runId: run.id, issueId,
      reason: input.reason, asidePath, asideExecutionWorkspaceId: bound.id, asideSha256, successorExecutionWorkspaceId,
      successorCwd, seedSha256: successorCwd ? source!.workspaceArchiveSha256 : null, at: now.toISOString() };
    await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ [PERSON_STOP_ISOLATION_KEY]: record })}::jsonb` }).where(eq(heartbeatRuns.id, run.id));
    // ONE true note, written only by the transaction that writes the record.
    const line = kind === "isolated" ? personStopIsolatedNote(record) : personStopHeldNote(record);
    await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: "provider.notice.recorded", stream: "system", level: "info", message: line,
      payload: { personStopIsolation: record, prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        sourceKind: "control_plane", runId: run.id, eventType: "provider.notice.recorded", emittedAt: now.toISOString(),
        payload: { schema: "paperclip.provider.notice.v1", severity: "info",
          category: kind === "isolated" ? "person_stop_isolated" : "person_stop_isolation_held", summary: line, message: line } } } });
    return { record, now: true };
  });
  if (!committed || !committed.now) {
    if (successorCwd) await fs.rm(successorCwd, { recursive: true, force: true });
    if (!committed) return { kind: "not_applicable", reason: "task_repointed_concurrently" };
  }
  return { kind: committed.record.kind, record: committed.record, committedNow: committed.now };
}
