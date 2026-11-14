import { and, asc, eq, not, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  nativeWarmCheckpointCoversLastTurnSql,
  nativeWarmSessionSql,
  nativeWarmSessionStopReadySql,
  WARM_NATIVE_SESSION_CLOSE_KEY,
  WARM_NATIVE_SESSION_CLOSE_SCHEMA,
} from "./native-warm-stop-gate.js";
import { driveNativeWarmClose, type NativeWarmCloseOutcome } from "./native-warm-close-driver.js";
import { warmSandboxIdleRetainedCondition, warmWindowEndsAtSql } from "./warm-sandbox-expiry.js";

/**
 * The durable opener of the native warm stop gate (`native-warm-stop-gate.ts`).
 *
 * The gate opens on a `closed` receipt, which the executor records after it
 * closes the warm native session. That close used to be driven only by the
 * owning process's in-memory idle timer, so after a restart or deploy, a dead
 * process, a close path that wrote no receipt, or a lost compare-and-swap,
 * nothing ever opened the gate and the box ran until the provider stopped it.
 *
 * This step runs in the existing environment cleanup sweep
 * (`heartbeat/recovery.ts` `sweepPendingCleanupLeases`, before warm-window
 * expiry). It takes every retained native warm lease whose warm window (and
 * its idle close margin) has ended and that the gate still refuses, and:
 *
 * 1. asks this process to close the session through the executor's close path
 *    (`native-warm-close-driver.ts`). `closed`: the executor wrote the receipt
 *    and the expiry in the same sweep stops the box. `busy` (in use, or its
 *    agent directory busy): retry later; it counts no failure and defers the
 *    give-up. `not_owned` (a released Runner, or one another run adopted) is
 *    never closed. `absent`: another process may own it; wait.
 * 2. records the attempt state durably on the lease (`state: 'closing'`,
 *    `openerSince`, `openerFailures`, `openerNextAt`), so any process continues it.
 * 3. once the close failed `NATIVE_WARM_CLOSE_MAX_FAILURES` times, or no
 *    process closed it within `NATIVE_WARM_CLOSE_GIVE_UP_AFTER_MS` after the
 *    window ended (or after an owner last reported busy), or it was already
 *    recorded `failed`, records the close as `failed` with ONE visible warning
 *    (a log line and an activity record, claimed by the compare-and-swap that
 *    writes `failed`) and the explicit backstop:
 *    - `checkpoint`: a checkpoint stamp covering the last turn exists, so the
 *      gate lets the stop through;
 *    - otherwise `ttl_wait`: the box keeps running until the lease's own TTL
 *      (`expiresAt`) has passed; then the backstop becomes `ttl` and the gate
 *      lets the stop through. A lease with no TTL waits for the provider.
 *
 * Leases another lease row still holds (a successor that adopted the Runner),
 * or that a running turn on the task may be resuming, are excluded by the same
 * conditions as warm-window expiry. Every write is a compare-and-swap on the
 * receipt read, on a row still `retained`.
 */

/** No process closed the session this long after the warm window ended: give up. */
export const NATIVE_WARM_CLOSE_GIVE_UP_AFTER_MS = 10 * 60_000;
/** Close failures (not busy answers) before giving up. */
export const NATIVE_WARM_CLOSE_MAX_FAILURES = 3;
/** Next opener attempt after one that did not close. */
export const NATIVE_WARM_CLOSE_RETRY_MS = 60_000;
export const NATIVE_WARM_CLOSE_FAILED_ACTION = "environment_lease.native_warm_close_failed";

const PAGE_SIZE = 25;

type Receipt = Record<string, unknown>;
type Lease = typeof environmentLeases.$inferSelect;

function receiptSql() {
  return sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)->${WARM_NATIVE_SESSION_CLOSE_KEY}`;
}

function numberField(receipt: Receipt | null, key: string): number | null {
  const value = receipt?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Epoch ms when the opener should next look at the lease (null: nothing to wait for). */
function openerDueAtSql() {
  const close = receiptSql();
  return sql`case when ${close}->>'state' = 'failed' and ${close}#>>'{backstop,kind}' = 'ttl_wait'
    then extract(epoch from ${environmentLeases.expiresAt}) * 1000
    else greatest(${warmWindowEndsAtSql()}, case when jsonb_typeof(${close}->'openerNextAt') = 'number'
      then (${close}->>'openerNextAt')::numeric else 0 end) end`;
}

function openerCandidateCondition() {
  return and(warmSandboxIdleRetainedCondition(), nativeWarmSessionSql(), not(nativeWarmSessionStopReadySql()));
}

/** When the opener next has work, or null. Part of the cleanup worker's wake. */
export async function nextNativeWarmCloseOpenerAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ next: sql<string | null>`min(${openerDueAtSql()})` })
    .from(environmentLeases).where(openerCandidateCondition());
  return row?.next == null ? null : Number(row.next);
}

async function compareAndSwapReceipt(db: Db, lease: Lease, previous: Receipt | null, next: Receipt): Promise<boolean> {
  const updated = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [WARM_NATIVE_SESSION_CLOSE_KEY]: next })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.status, "retained"),
    sql`${receiptSql()} is not distinct from ${previous === null ? null : JSON.stringify(previous)}::jsonb`))
    .returning({ id: environmentLeases.id });
  return updated.length === 1;
}

async function checkpointCoversLastTurn(db: Db, lease: Lease): Promise<boolean> {
  const [row] = await db.select({ covers: sql<boolean>`${nativeWarmCheckpointCoversLastTurnSql()}` }).from(environmentLeases)
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  return row?.covers === true;
}

export type NativeWarmCloseOpenerResult = { closed: number; waiting: number; failed: number; ttl: number };

/** One opener pass over the due native warm leases. */
export async function sweepNativeWarmCloseOpeners(db: Db, now = new Date()): Promise<NativeWarmCloseOpenerResult> {
  const result: NativeWarmCloseOpenerResult = { closed: 0, waiting: 0, failed: 0, ttl: 0 };
  const at = now.getTime();
  const due = await db.select({ lease: environmentLeases, endsAt: sql<string>`${warmWindowEndsAtSql()}` })
    .from(environmentLeases)
    .where(and(openerCandidateCondition(), sql`${openerDueAtSql()} <= ${at}`))
    .orderBy(asc(environmentLeases.lastUsedAt)).limit(PAGE_SIZE);
  for (const { lease, endsAt } of due) {
    try {
      const outcome = await openOne(db, lease, Number(endsAt), now);
      result[outcome]++;
    } catch (error) {
      logger.warn({ err: error, leaseId: lease.id }, "native warm close opener failed for a lease; a later sweep retries");
    }
  }
  return result;
}

async function openOne(db: Db, lease: Lease, windowEndsAt: number, now: Date): Promise<keyof NativeWarmCloseOpenerResult> {
  const at = now.getTime();
  const raw = lease.metadata?.[WARM_NATIVE_SESSION_CLOSE_KEY];
  const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Receipt : null;
  // Only a receipt for this exact sandbox and run is this lease's attempt state.
  const own = stored && stored.schema === WARM_NATIVE_SESSION_CLOSE_SCHEMA
    && stored.providerLeaseId === lease.providerLeaseId && stored.runId === lease.heartbeatRunId ? stored : null;
  const identity = { schema: WARM_NATIVE_SESSION_CLOSE_SCHEMA, providerLeaseId: lease.providerLeaseId!, runId: lease.heartbeatRunId! };

  if (own?.state === "failed" && (own.backstop as Receipt | undefined)?.kind === "ttl_wait") {
    // The explicit TTL backstop: only once the lease's own TTL has passed.
    if (!lease.expiresAt || lease.expiresAt.getTime() > at) return "waiting";
    await compareAndSwapReceipt(db, lease, stored, { ...own, backstop: { kind: "ttl", at: now.toISOString() } });
    return "ttl";
  }

  let failures = numberField(own, "openerFailures") ?? 0;
  let busyAt = numberField(own, "openerBusyAt");
  let outcome: NativeWarmCloseOutcome | null = null;
  let detail: string | undefined;
  if (own?.state !== "failed") {
    const driven = await driveNativeWarmClose({ leaseId: lease.id, companyId: lease.companyId,
      runId: lease.heartbeatRunId!, providerLeaseId: lease.providerLeaseId! });
    outcome = driven.outcome;
    detail = driven.detail;
    if (outcome === "closed") return "closed";
    if (outcome === "failed") failures++;
    if (outcome === "busy") busyAt = at;
    const giveUpAt = Math.max(windowEndsAt, busyAt ?? 0) + NATIVE_WARM_CLOSE_GIVE_UP_AFTER_MS;
    if (outcome === "busy" || (failures < NATIVE_WARM_CLOSE_MAX_FAILURES && at < giveUpAt)) {
      const next: Receipt = { ...(own ?? {}), ...identity, state: "closing",
        openerSince: typeof own?.openerSince === "string" ? own.openerSince : now.toISOString(),
        openerFailures: failures, openerNextAt: Math.min(at + NATIVE_WARM_CLOSE_RETRY_MS, Math.max(giveUpAt, at + 1)),
        openerLastOutcome: outcome, ...(busyAt !== null ? { openerBusyAt: busyAt } : {}),
        ...(detail ? { openerLastFailure: detail } : {}) };
      await compareAndSwapReceipt(db, lease, stored, next);
      return "waiting";
    }
  }

  // Give up: record the close as failed with the explicit backstop.
  const covers = await checkpointCoversLastTurn(db, lease);
  const stamp = lease.metadata?.nativeHarnessBackup as Receipt | undefined;
  const backstop = covers
    ? { kind: "checkpoint", at: now.toISOString(), normalizedSessionId: stamp?.normalizedSessionId, manifestSha256: stamp?.manifestSha256 }
    : lease.expiresAt && lease.expiresAt.getTime() <= at
      ? { kind: "ttl", at: now.toISOString() }
      : { kind: "ttl_wait", at: now.toISOString() };
  const alreadyWarned = (numberField(own, "warningCount") ?? 0) >= 1;
  const failed: Receipt = { ...(own ?? {}), ...identity, state: "failed", failedAt: now.toISOString(),
    openerFailures: failures, warningCount: 1, backstop,
    ...(outcome ? { openerLastOutcome: outcome } : {}), ...(detail ? { openerLastFailure: detail } : {}) };
  if (!await compareAndSwapReceipt(db, lease, stored, failed)) return "waiting";
  if (!alreadyWarned) {
    const details = { providerLeaseId: lease.providerLeaseId, failures, lastOutcome: outcome, backstop: backstop.kind,
      windowEndedAt: new Date(windowEndsAt).toISOString(), expiresAt: lease.expiresAt?.toISOString() ?? null };
    logger.warn({ leaseId: lease.id, companyId: lease.companyId, runId: lease.heartbeatRunId, ...details },
      backstop.kind === "checkpoint"
        ? "native warm session close failed; its checkpoint covers the last turn, so its sandbox is stopped and kept"
        : "native warm session close failed and no checkpoint covers the last turn; its sandbox keeps running until the lease TTL");
    await logActivity(db, { companyId: lease.companyId, actorType: "system", actorId: "native-warm-close-opener",
      action: NATIVE_WARM_CLOSE_FAILED_ACTION, entityType: "environment_lease", entityId: lease.id,
      runId: lease.heartbeatRunId, issueId: lease.issueId, details,
    }).catch(() => logger.warn({ leaseId: lease.id }, "could not record the native warm close failure activity"));
  }
  return backstop.kind === "ttl" ? "ttl" : "failed";
}
