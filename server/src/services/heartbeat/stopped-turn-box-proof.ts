import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import type { environmentRuntimeService } from "../environment-runtime.js";
import { STOPPED_SESSION_CLOSE_SCHEMA } from "./cancelled-warm-workspace-export.js";
import { noStoppedTurnProcessRemains } from "./stopped-turn-process-gone.js";

/**
 * adopt-stopu-compose8 (rf-4 00:43Z, row 20, binding): the CRASH path.
 *
 * NSE records the clean close of a stopped warm session
 * (native-session-executor.ts releaseWarmNativeSession -> nativeStoppedSessionClose)
 * and F13 exports nothing without it (cancelled-warm-workspace-export.ts
 * hasCleanStoppedSessionClose). When the SERVER crashed after the durable
 * cancel and before that record, the proof can never arrive from NSE, but the
 * box is alive. So the proof is established after the fact, on the box, with
 * one bounded command over the existing runner command path
 * (target.runner.execute, bypassSession, as sandbox-runner-port-holders.ts
 * inspectSandboxSessionRunner): every process whose environment carries the
 * stopped turn's PAPERCLIP_RUN_ID (set by the Runner for the turn and inherited
 * by its tools: packages/paperclip-runner configured-environment.ts) is killed,
 * its whole process group when the group is the turn's alone, and the scan is
 * repeated until none remain.
 */
// adopt-stopu-round: the former STOPPED_TURN_KILL_AND_VERIFY_SCRIPT is replaced
// by the ONE check, noStoppedTurnProcessRemains (stopped-turn-process-gone.ts).

export type StoppedTurnBoxProof =
  | { outcome: "proven"; found: number[]; killedGroups: number[]; killedPids: number[]; unreadable: number }
  /** The box answered, but the turn's processes are not proven gone. */
  | { outcome: "not_proven"; reason: string }
  /** The box did not answer within the bound (by line: target / command). */
  | { outcome: "unanswered"; reason: "box_unreachable_target" | "box_unreachable_probe" };

/** The crash path: NSE never recorded the stopped session's close (neither
 * clean nor failed), and nothing owns the run any more (its controller lease
 * expired and no live finalization owner), so that record can never arrive. */
export async function stoppedTurnCloseOwedAfterCrash(db: Db, run: typeof heartbeatRuns.$inferSelect,
  now: number): Promise<boolean> {
  const profile = run.runnerProfileJson as Record<string, unknown> | null | undefined;
  if (profile?.nativeStoppedSessionClose != null) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > now) return false;
  const [finalization] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner,
    leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId))).limit(1);
  return !(finalization?.leaseOwner && finalization.leaseExpiresAt && finalization.leaseExpiresAt.getTime() > now);
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<"timed_out">(resolve => { timer = setTimeout(() => resolve("timed_out"), ms); timer.unref?.(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One bounded command on the kept box (target resolution included in the
 * bound, as the bound's own reachability probe). */
export async function proveStoppedTurnGoneOnBox(input: {
  db: Db;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
  run: typeof heartbeatRuns.$inferSelect;
  lease: typeof environmentLeases.$inferSelect;
  environment: typeof environments.$inferSelect | undefined;
  timeoutMs: number;
}): Promise<StoppedTurnBoxProof> {
  const { db, run, lease, environment, environmentRuntime, timeoutMs } = input;
  let stage: "box_unreachable_target" | "box_unreachable_probe" = "box_unreachable_target";
  const attempt = async (): Promise<StoppedTurnBoxProof> => {
    if (!environment) return { outcome: "unanswered", reason: "box_unreachable_target" };
    const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
      environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never, environmentRuntime })
      .catch(() => null);
    if (!target || target.kind !== "remote" || !("runner" in target) || !target.runner)
      return { outcome: "unanswered", reason: "box_unreachable_target" };
    stage = "box_unreachable_probe";
    // adopt-stopu-round: ONE check. The crash path runs ugate2's
    // noStoppedTurnProcessRemains (stopped-turn-process-gone.ts) on the kept
    // box, with the run id so the turn's PAPERCLIP_RUN_ID processes are found.
    const proof = await noStoppedTurnProcessRemains({ runner: target.runner, remoteCwd: target.remoteCwd }, run.startedAt,
      { runId: run.id, timeoutMs, bypassSession: true });
    if (proof.proven) {
      const killed = proof.killed.map(Number).filter(Number.isSafeInteger);
      return { outcome: "proven", found: killed, killedGroups: [], killedPids: killed, unreadable: 0 };
    }
    if (proof.detail === "process_check_timed_out" || proof.detail.startsWith("process_check_failed:")
      && !proof.detail.startsWith("process_check_failed:ERR"))
      return { outcome: "unanswered", reason: "box_unreachable_probe" };
    return { outcome: "not_proven", reason: `stopped_turn_kill_unproven: ${proof.detail}${proof.remaining?.length ? `:${proof.remaining.join(",")}` : ""}`.slice(0, 300) };
  };
  const outcome = await bounded(attempt(), timeoutMs);
  // By line: the bound passed while resolving the box (target) or while the
  // command ran on it (probe).
  return outcome === "timed_out" ? { outcome: "unanswered", reason: stage } : outcome;
}

/** Record the after-the-fact proof exactly where NSE records its clean close
 * (runnerProfileJson.nativeStoppedSessionClose, same schema and identity), so
 * hasCleanStoppedSessionClose accepts it. Never overwrites an NSE record. */
export async function recordStoppedTurnCloseProof(db: Db, run: typeof heartbeatRuns.$inferSelect,
  proof: Extract<StoppedTurnBoxProof, { outcome: "proven" }>): Promise<boolean> {
  const closeRecord = { schema: STOPPED_SESSION_CLOSE_SCHEMA, companyId: run.companyId, issueId: run.nativeIssueId,
    runId: run.id, sessionId: run.nativeSessionId ?? null, clean: true, via: "box_stopped_turn_kill_after_crash",
    found: proof.found, killedGroups: proof.killedGroups, killedPids: proof.killedPids, remaining: [],
    unreadableProcesses: proof.unreadable, at: new Date().toISOString() };
  const updated = await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
    || ${JSON.stringify({ nativeStoppedSessionClose: closeRecord })}::jsonb` }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ? 'nativeStoppedSessionClose')`))
    .returning({ id: heartbeatRuns.id });
  return updated.length === 1;
}
