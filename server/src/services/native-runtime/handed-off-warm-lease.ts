import { assertNoOpenTransaction } from "@paperclipai/db/transaction-context";
import { and, desc, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db, type heartbeatRuns } from "@paperclipai/db";
import { admittedNativeResourceDisposition, nativeStopWorkspaceOutcome } from "./native-failed-workspace-recovery.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { hasStopOnlyCleanup, prepareSupersededWarmSandboxStop } from "../sandbox-stop-and-retain.js";
import { warmSandboxExpiryCandidateCondition } from "../warm-sandbox-expiry.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { logger } from "../../middleware/logger.js";
import { readEnvironmentLeaseController } from "../environment-lease-controller.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import { REPLACE_BEFORE_REUSE_KEY, REPLACE_BEFORE_REUSE_SCHEMA, readReplaceBeforeReuseMarker,
  type ReplaceBeforeReuseMarker } from "./predecessor-retirement.js";

/** Lease policies whose box a warm Stop can hand off (native-failed-workspace-recovery). */
const reusableNativeLeasePolicies = ["reuse_by_environment", "reuse_by_execution_workspace"];

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "runtimeMode" | "runnerProfileJson">;

/** A remote lease with no stop receipt that a person's Stop (or Interrupt) of a
 * warm (keep_running) turn handed off: native run, lease retained and unreleased
 * with a reusable policy, no stop in flight on it, the warm-stop helper says handoff. */
export function handedOffWarmLease(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  return !(run.runtimeMode !== "native" || lease.status !== "retained" || lease.releasedAt
    || !reusableNativeLeasePolicies.includes(lease.leasePolicy)
    || lease.metadata?.pendingCleanupInFlight === true || hasStopOnlyCleanup(lease)
    || nativeStopWorkspaceOutcome({ admittedDisposition: admittedNativeResourceDisposition(run.runnerProfileJson),
      stopped: run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run), source: lease }) !== "handoff");
}

/** pl/send-after-stop: ONE predicate for a handed-off warm lease. Settled only
 * when it is such a lease and the s3 fence's proof that the stopped run's Runner
 * exited is PERSISTED on it. rf-4 row 22a: DB-only. The proof talks to the box's
 * Runner over the network, so it never runs here (callers hold the Send's
 * enqueue/admission transaction, a dryRun or the Interrupt route's lock);
 * proveHandedOffWarmLeases runs it outside any transaction and persists its answer. */
export function handedOffWarmLeaseSettled(run: Run, lease: typeof environmentLeases.$inferSelect): boolean {
  if (!handedOffWarmLease(run, lease)) return false;
  const evidence = lease.metadata?.[HANDED_OFF_WARM_EXIT_KEY] as { runId?: unknown } | undefined;
  return evidence?.runId === run.id;
}

/** rf-4 row 22: persisted evidence that the s3 fence proved the stopped run's Runner exited. */
export const HANDED_OFF_WARM_EXIT_KEY = "handedOffWarmOwnerRunnerExited";
/** Marker of the stop_and_retain intent written when the bounded proof timed out. */
export const HANDED_OFF_WARM_STOP_KEY = "handedOffWarmProofTimedOut";
/** row 12 (pl/send-after-stop3 cdc665ef): marker of the stop_and_retain intent
 * written at once because the proof is UNAVAILABLE in this process (no warm
 * session for the stopped run: a server restart, or the entry already gone). */
export const HANDED_OFF_WARM_UNAVAILABLE_STOP_KEY = "handedOffWarmProofUnavailable";
/** rf-4 row 22f: bound on the remote proof (stop the idle Runner, wait for its exit). */
export const handedOffWarmProofTimeout = { ms: 20_000 };
/** adopt-unproven-bound (V4ROWS point 5): marker of the stop_and_retain intent
 * written because the proof came back UNPROVEN in THIS boot (the stopped turn's
 * session still busy/preparing, its Runner stop failed or was refused, or no
 * exit record) for longer than handedOffWarmUnprovenBound. */
export const HANDED_OFF_WARM_UNPROVEN_STOP_KEY = "handedOffWarmProofUnproven";
/** Lease metadata: when this boot first saw the proof UNPROVEN for the run ({ runId, at }). */
export const HANDED_OFF_WARM_UNPROVEN_SINCE_KEY = "handedOffWarmUnprovenSince";
/** adopt-unproven-bound: how long a same-boot UNPROVEN proof may hold a
 * handed-off warm box before it is stopped and kept (never warm expiry, up to 8 h).
 * At the bound ONE event-driven re-proof runs (no poll interval); still not
 * proven -> the stop-only owner's stop_and_retain intent. */
export const handedOffWarmUnprovenBound = { ms: 30_000 };
/** adopt-unproven-words / adopt-total-words: the person's line while a hand-off
 * waits. It stays on screen through the unproven bound AND the stop-receipt
 * wait after it (Boat hung), so it names the CEILING: both bounds, rounded up
 * (whole minutes past one minute, else whole seconds). Never less than the real wait. */
export function handedOffWarmUnprovenWaitMessage(): string {
  const seconds = Math.max(1, Math.ceil((handedOffWarmUnprovenBound.ms + handedOffWarmStopReceiptBound.ms) / 1000));
  const [n, unit] = seconds > 60 ? [Math.ceil(seconds / 60), "minute"] : [seconds, "second"];
  return `Waiting up to ${n} ${unit}${n === 1 ? "" : "s"} for the previous environment to stop. Your message will start automatically.`;
}
/** adopt-words-state: the ONE projection of the person's hand-off waiting line,
 * derived from STATE (run + its leases), never from saved prose. A bounded wait:
 * (unproven phase) a retained handed-off warm lease, not yet proven, whose
 * handedOffWarmUnprovenSince names this run; (receipt phase) the lease is
 * pending_cleanup with this module's stop-and-retain intent for this run, no stop
 * receipt yet, before the overdue mark. Either -> the ceiling line; else null
 * (callers keep their own line). DB-free: admission and the queue GET both call it. */
export function handedOffWarmWaitLine(run: Run, leases: readonly (typeof environmentLeases.$inferSelect)[]): string | null {
  const waiting = leases.some(lease => {
    if (lease.provider === "local" || hasRemoteTerminationReceipt(lease) || hasRecoveredCleanupStopReceipt(lease)) return false;
    if (handedOffWarmLease(run, lease)) return !handedOffWarmLeaseSettled(run, lease)
      && (lease.metadata?.[HANDED_OFF_WARM_UNPROVEN_SINCE_KEY] as { runId?: unknown } | undefined)?.runId === run.id;
    return handedOffStopPending(run, lease) && !handedOffWarmStopReceiptOverdue(run, lease);
  });
  return waiting ? handedOffWarmUnprovenWaitMessage() : null;
}

/** adopt-words-state: the queue GET's read of the same projection for an Interrupt
 * wake: the interrupted run (the payload's targetRunId, else the task's latest
 * run) and its leases, read now. DB-only, no saved prose involved. */
export async function readHandedOffWarmWaitLine(db: Db, input: { companyId: string; issueId: string;
  targetRunId?: string | null }): Promise<string | null> {
  const { heartbeatRuns: runs } = await import("@paperclipai/db");
  const fields = { id: runs.id, companyId: runs.companyId, nativeIssueId: runs.nativeIssueId, status: runs.status,
    resultJson: runs.resultJson, runtimeMode: runs.runtimeMode, runnerProfileJson: runs.runnerProfileJson };
  const issueRuns = and(eq(runs.companyId, input.companyId),
    sql`(${runs.nativeIssueId} = ${input.issueId} or ${runs.issueId} = ${input.issueId})`);
  const [run] = input.targetRunId
    ? await db.select(fields).from(runs).where(and(issueRuns, sql`${runs.id}::text = ${input.targetRunId}`)).limit(1)
    : await db.select(fields).from(runs).where(issueRuns).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  if (!run) return null;
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.heartbeatRunId, run.id)));
  return handedOffWarmWaitLine(run, leases);
}
type Redispatch = () => Promise<unknown>;
/** adopt-hung-stop (org criterion (b)): the SECOND bound. After the stop-and-retain
 * intent for a handed-off warm box is written, its provider receipt normally
 * admits the successor. If no receipt has come this long after the intent
 * (Boat hung), the successor no longer waits for it: the old lease gets the
 * existing replace-before-reuse marker (never resumed again) and stays
 * pending_cleanup (stop debt, the cleanup sweep keeps retrying the stop), and
 * the held message starts on a fresh box from the saved workspace. */
export const handedOffWarmStopReceiptBound = { ms: 60_000 };
/** Lease metadata: the stop receipt was overdue past handedOffWarmStopReceiptBound ({ runId, intentAt, overdueAt, boundMs }). */
export const HANDED_OFF_WARM_STOP_OVERDUE_KEY = "handedOffWarmStopReceiptOverdue";
const handedOffStopMarkers = [HANDED_OFF_WARM_STOP_KEY, HANDED_OFF_WARM_UNAVAILABLE_STOP_KEY, HANDED_OFF_WARM_UNPROVEN_STOP_KEY];
/** One receipt deadline per lease (process-local, one-shot); the durable intent time (releasedAt) re-arms it after a restart. */
const receiptDeadlines = new Map<string, NodeJS.Timeout>();
/** The latest caller's redispatch per run, for timers armed inside requestHandedOffWarmLeaseStop. */
const latestRedispatch = new Map<string, Redispatch>();

/** A handed-off warm box whose stop-and-retain intent (one of this module's markers) is still unanswered. */
function handedOffStopPending(run: Pick<Run, "id">, lease: typeof environmentLeases.$inferSelect): boolean {
  const intent = lease.metadata?.sandboxStopAndRetain as Record<string, unknown> | undefined;
  return lease.status === "pending_cleanup" && intent?.runId === run.id && handedOffStopMarkers.some(key => intent[key] === true);
}

/** adopt-stoppending-card: DB-only. A handed-off box's stop-and-retain intent
 * still inside its receipt bound (handedOffWarmStopReceiptBound from the durable
 * intent time, not yet marked overdue). Past it, the box is really unproven. */
export function handedOffWarmStopWithinReceiptBound(run: Pick<Run, "id">, lease: typeof environmentLeases.$inferSelect,
  now = Date.now()): boolean {
  return handedOffStopPending(run, lease) && !handedOffWarmStopReceiptOverdue(run, lease)
    && (lease.metadata?.[HANDED_OFF_WARM_STOP_OVERDUE_KEY] as { runId?: unknown } | undefined)?.runId !== run.id
    && !!lease.releasedAt && lease.releasedAt.getTime() + handedOffWarmStopReceiptBound.ms > now;
}

/** adopt-hung-stop: DB-only. The handed-off box's stop receipt is overdue and the box is
 * marked replace-before-reuse, so admission no longer waits for its receipt. */
export function handedOffWarmStopReceiptOverdue(run: Pick<Run, "id">, lease: typeof environmentLeases.$inferSelect): boolean {
  const overdue = lease.metadata?.[HANDED_OFF_WARM_STOP_OVERDUE_KEY] as { runId?: unknown } | undefined;
  return handedOffStopPending(run, lease) && overdue?.runId === run.id && readReplaceBeforeReuseMarker(lease.metadata) !== null;
}

/** Past the bound with no receipt: mark the lease (guarded: still pending_cleanup with its intent). True when marked now. */
async function markHandedOffStopOverdue(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  const now = new Date();
  const marker: ReplaceBeforeReuseMarker = { schema: REPLACE_BEFORE_REUSE_SCHEMA, runId: run.id, predecessorRunId: run.id,
    recordedAt: now.toISOString() };
  const updated = await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
    [HANDED_OFF_WARM_STOP_OVERDUE_KEY]: { runId: run.id, intentAt: lease.releasedAt?.toISOString() ?? null, overdueAt: now.toISOString(),
      boundMs: handedOffWarmStopReceiptBound.ms }, [REPLACE_BEFORE_REUSE_KEY]: marker })}::jsonb`, updatedAt: now })
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.status, "pending_cleanup"), sql`${environmentLeases.metadata} ? 'sandboxStopAndRetain'`))
    .returning({ id: environmentLeases.id });
  if (updated.length) logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
    boundMs: handedOffWarmStopReceiptBound.ms }, "handed-off warm stop receipt overdue; the successor starts on a fresh box, the old box stays owed a stop");
  return updated.length > 0;
}

/** Arm ONE deadline at intent + bound for an unanswered handed-off stop; past it, mark now. True when marked now. */
async function armHandedOffStopReceiptDeadline(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  if (!handedOffStopPending(run, lease) || handedOffWarmStopReceiptOverdue(run, lease)) return false;
  const intentAt = lease.releasedAt?.getTime() ?? Date.now();
  const remaining = intentAt + handedOffWarmStopReceiptBound.ms - Date.now();
  if (remaining <= 0) return markHandedOffStopOverdue(db, run, lease);
  if (receiptDeadlines.has(lease.id)) return false;
  const timer = setTimeout(() => {
    receiptDeadlines.delete(lease.id);
    void (async () => {
      const [current] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
        eq(environmentLeases.companyId, run.companyId))).limit(1);
      if (!current || !handedOffStopPending(run, current)) return; // the receipt came: today's receipt path admits
      if (await markHandedOffStopOverdue(db, run, current)) await latestRedispatch.get(run.id)?.();
    })().catch(err => logger.warn({ err, runId: run.id, leaseId: lease.id }, "handed-off warm stop receipt deadline failed"));
  }, Math.max(0, remaining) + 50);
  timer.unref?.();
  receiptDeadlines.set(lease.id, timer);
  return false;
}
/** At most one scheduled re-proof per run (process-local, one-shot). */
const unprovenRechecks = new Map<string, { timer: NodeJS.Timeout; redispatch?: Redispatch }>();
type ProofOutcome = "none" | "proven" | "unproven" | "timed_out" | "stop_requested";
const proofsInFlight = new Map<string, Promise<ProofOutcome>>();
/** A proof for this run is running outside the transaction right now (process-local). */
export function handedOffWarmProofInFlight(runId: string): boolean { return proofsInFlight.has(runId); }

/** rf-4 row 22a/22f: run the s3 fence's runner-exit proof for every handed-off
 * warm lease of this run that has no persisted answer yet, OUTSIDE any
 * transaction (callers pass the root Db; the tx-guard throws otherwise),
 * bounded by handedOffWarmProofTimeout. Proven -> the evidence key is written on
 * the lease. Timed out -> a stop_and_retain intent (its provider receipt then
 * admits the successor through the receipt path). row 12: proof UNAVAILABLE here
 * (no warm session for the run in this process, e.g. after a server restart) ->
 * the same stop_and_retain intent AT ONCE, never a wait for warm expiry. */
export function proveHandedOffWarmLeases(db: Db, run: Run, opts?: { redispatch?: Redispatch }): Promise<ProofOutcome> {
  if (opts?.redispatch) latestRedispatch.set(run.id, opts.redispatch);
  const scheduled = unprovenRechecks.get(run.id);
  if (scheduled && opts?.redispatch) scheduled.redispatch = opts.redispatch;
  const running = proofsInFlight.get(run.id);
  if (running) return running;
  const work = (async (): Promise<ProofOutcome> => {
    const all = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)));
    // A healthy in-process turn stop is ordinary warm retention, not a handoff
    // to a replacement Runner. Never ask that still-live owner to prove exit.
    const hasRetainedNativeTurnStop = run.runnerProfileJson?.nativeRetainedIdleCheckpoint
      ? (await import("./native-session-executor.js")).hasRetainedNativeTurnStop : undefined;
    // Only the exact retained lease is exempt; other old writers still need proof.
    const requiringProof = all.filter(lease => !hasRetainedNativeTurnStop?.(run, lease));
    // adopt-hung-stop: a handed-off stop already requested gets its receipt deadline (re-armed from the durable intent time).
    for (const lease of requiringProof) await armHandedOffStopReceiptDeadline(db, run, lease);
    const leases = requiringProof.filter(lease => handedOffWarmLease(run, lease) && !handedOffWarmLeaseSettled(run, lease));
    if (!leases.length) return "none";
    assertNoOpenTransaction("runner:handedOffWarmOwnerRunnerExited");
    const { handedOffWarmOwnerRunnerExited, handedOffWarmOwnerProofUnavailable } = await import("./native-session-executor.js");
    let outcome: ProofOutcome = "proven";
    for (const [index, lease] of leases.entries()) {
      let timer: NodeJS.Timeout | undefined;
      const answer = await Promise.race([
        handedOffWarmOwnerRunnerExited({ runId: run.id, providerLeaseId: lease.providerLeaseId }).catch(() => false),
        new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), handedOffWarmProofTimeout.ms); }),
      ]).finally(() => clearTimeout(timer));
      if (answer === true) {
        await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
          [HANDED_OFF_WARM_EXIT_KEY]: { runId: run.id, provenAt: new Date().toISOString() } })}::jsonb`, updatedAt: new Date() })
          .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
        continue;
      }
      if (answer === "timeout") {
        await requestHandedOffWarmLeaseStop(db, run, lease, { [HANDED_OFF_WARM_STOP_KEY]: true, proofTimedOutMs: handedOffWarmProofTimeout.ms }, "proof timed out");
        return "timed_out";
      }
      // row 12 (pl/send-after-stop3 cdc665ef): not proven, the box was handed
      // off under another server boot, and the proof is UNAVAILABLE in this
      // process (no warm session for the run: a server restart). Waiting cannot produce it; only warm expiry would stop the box.
      // Stop and keep it now through the stop-only owner, for this lease and
      // every later one in the same state. A Runner that did not prove exited
      // (its warm session is held here) still waits, as the s3 fence requires.
      if (handedOffByAnotherBoot(lease) && handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: lease.providerLeaseId })) {
        for (const unavailable of leases.slice(index))
          if (handedOffByAnotherBoot(unavailable) && handedOffWarmOwnerProofUnavailable({ runId: run.id, providerLeaseId: unavailable.providerLeaseId }))
            await requestHandedOffWarmLeaseStop(db, run, unavailable, { [HANDED_OFF_WARM_UNAVAILABLE_STOP_KEY]: true }, "proof unavailable");
        return "stop_requested";
      }
      // adopt-unproven-bound: UNPROVEN in THIS boot (not a restart). Only the
      // person's next Send would re-run the proof, so the box (and the successor)
      // would wait for warm expiry. Bound it: past handedOffWarmUnprovenBound the
      // stop-only owner stops and keeps the box; before it, ONE re-proof is
      // scheduled at the bound. Never for a box another live turn uses.
      if (await boundUnprovenHandedOffWarmLease(db, run, lease, opts?.redispatch)) return "stop_requested";
      outcome = "unproven";
      break;
    }
    return outcome;
  })().finally(() => proofsInFlight.delete(run.id));
  proofsInFlight.set(run.id, work);
  return work;
}

/** adopt-unproven-bound: true when the stop-and-retain intent was written.
 * HOW A LIVE TURN IS TOLD APART from the stopped turn's own busy/preparing
 * session: (1) process-local, handedOffWarmOwnerClaimedByAnotherRun: a warm
 * session on this box that is busy/preparing for, or held by, a run OTHER than
 * the stopped one -> never stopped, nothing scheduled (that turn's own finish
 * re-runs the proof); (2) in the database, the stop intent is only written on
 * a warmSandboxExpiryCandidateCondition row: the lease's own run is terminal,
 * no other active/retained/pending_cleanup lease names the same box, and no
 * other run on the task is running. A session busy or preparing with neither
 * is the stopped (cancelled) turn's own wind-down: bounded. */
async function boundUnprovenHandedOffWarmLease(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect,
  redispatch?: Redispatch): Promise<boolean> {
  const { handedOffWarmOwnerClaimedByAnotherRun } = await import("./native-session-executor.js");
  if (handedOffWarmOwnerClaimedByAnotherRun({ runId: run.id, providerLeaseId: lease.providerLeaseId })) {
    logger.info({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId },
      "handed-off warm proof unproven; another live turn holds the box, so it is not stopped");
    return false;
  }
  const recorded = lease.metadata?.[HANDED_OFF_WARM_UNPROVEN_SINCE_KEY] as { runId?: unknown; at?: unknown } | undefined;
  let since = recorded?.runId === run.id && typeof recorded.at === "string" ? Date.parse(recorded.at) : NaN;
  if (!Number.isFinite(since)) {
    since = Date.now();
    await db.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({
      [HANDED_OFF_WARM_UNPROVEN_SINCE_KEY]: { runId: run.id, at: new Date(since).toISOString() } })}::jsonb` })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
  }
  const remaining = since + handedOffWarmUnprovenBound.ms - Date.now();
  if (remaining <= 0) {
    const requested = await requestHandedOffWarmLeaseStop(db, run, lease, { [HANDED_OFF_WARM_UNPROVEN_STOP_KEY]: true,
      unprovenSince: new Date(since).toISOString(), unprovenBoundMs: handedOffWarmUnprovenBound.ms }, "proof unproven past its bound");
    if (requested) unprovenRechecks.delete(run.id);
    return requested;
  }
  scheduleUnprovenRecheck(db, run, remaining, redispatch);
  return false;
}

/** ONE re-proof at the bound (setTimeout, unref'd, deduplicated per run): it
 * runs outside any transaction from the timer, re-reads the run and re-runs the
 * proof; proven -> the caller's redispatch admits the successor on the same box;
 * still unproven -> the bound has passed, so the stop intent is written and the
 * provider's receipt admits the successor. */
function scheduleUnprovenRecheck(db: Db, run: Run, delayMs: number, redispatch?: Redispatch) {
  const existing = unprovenRechecks.get(run.id);
  if (existing) { if (redispatch) existing.redispatch = redispatch; return; }
  const entry: { timer: NodeJS.Timeout; redispatch?: Redispatch } = { redispatch, timer: setTimeout(() => {
    unprovenRechecks.delete(run.id);
    void (async () => {
      const { heartbeatRuns: runs } = await import("@paperclipai/db");
      const [current] = await db.select().from(runs).where(and(eq(runs.companyId, run.companyId), eq(runs.id, run.id))).limit(1);
      if (!current) return;
      const outcome = await proveHandedOffWarmLeases(db, current, { redispatch: entry.redispatch });
      if (outcome === "proven" && entry.redispatch) await entry.redispatch();
    })().catch(err => logger.warn({ err, runId: run.id }, "handed-off warm unproven re-proof failed"));
  }, Math.max(0, delayMs) + 50) };
  entry.timer.unref?.();
  unprovenRechecks.set(run.id, entry);
}

/** row 12: the lease's holder stamp (environment-lease-controller, written
 * when the lease went active) names ANOTHER server boot: this process never
 * held the stopped run's warm session, so its absence here is a restart, not a
 * session this process is still registering. The same boot discriminator as
 * the previous-boot closed-tip stop (environment-runtime (g2)). An unstamped
 * lease proves nothing either way and keeps the existing wait. */
function handedOffByAnotherBoot(lease: typeof environmentLeases.$inferSelect): boolean {
  const holder = readEnvironmentLeaseController(lease.metadata);
  return holder !== null && holder.bootId !== currentControllerBootId();
}

/** pl/send-after-stop3 (cdc665ef) shape: stop and keep a handed-off warm box
 * through the same stop-only owner the warm-window expiry uses (upstream's Stop
 * shape). Its provider receipt (or the lease's stored termination receipt) then
 * admits the successor, which resumes the stopped box or starts on a new one.
 * DB-only, called outside any transaction. Never for a non-retained lease or one
 * another holder uses (warmSandboxExpiryCandidateCondition), and at most once:
 * the intent makes the lease no longer a retained handoff. True when requested. */
async function requestHandedOffWarmLeaseStop(db: Db, run: Run, lease: typeof environmentLeases.$inferSelect,
  marker: Record<string, unknown>, why: string): Promise<boolean> {
  const [candidate] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    warmSandboxExpiryCandidateCondition())).limit(1);
  const requested = candidate && handedOffWarmLease(run, candidate)
    ? await prepareSupersededWarmSandboxStop(db, candidate, marker) : null;
  if (requested) await armHandedOffStopReceiptDeadline(db, run, requested as typeof environmentLeases.$inferSelect);
  // rf-4 row 21 (the kind): a refusal is never silent.
  if (!requested) logger.warn({ runId: run.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId,
    candidate: Boolean(candidate), timeoutMs: handedOffWarmProofTimeout.ms },
    `handed-off warm ${why}; no stop-and-retain intent written (the box is not a stop candidate)`);
  return Boolean(requested);
}
