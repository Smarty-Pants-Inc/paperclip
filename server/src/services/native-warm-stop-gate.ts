import { and, eq, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { prepareSandboxStopAndRetain, prepareSupersededWarmSandboxStop } from "./sandbox-stop-and-retain.js";

/**
 * The one native warm stop gate.
 *
 * A reusable sandbox lease of the native runner (`reusableSandboxLease.adapterType
 * = 'paperclip_runner'`) whose run kept a warm runner on it (acquisition saved
 * its warm window, `warmSandboxIdleTimeoutMs`; see `warmSandboxWindowMetadata`)
 * keeps a native warm session: its conversation lives on the box until a
 * checkpoint of it is durable. No server path may stop, release
 * or destroy that box until BOTH of these are on the exact lease row:
 *
 * 1. a durable checkpoint stamp (`nativeHarnessBackup`, schema v2) authorised for
 *    the EXACT provider lease, that covers the last finished turn on that
 *    provider lease (`completedAt >= max(heartbeat_runs.finished_at)` over every
 *    lease row of the same provider lease), and
 * 2. a close receipt (`warmNativeSessionClose`, state `closed`) for the same
 *    provider lease, the lease's own run, and the stamp's session and manifest,
 *    no older than the stamp (`closedAt >= completedAt`).
 *
 * In place of the `closed` receipt, the explicit backstop of the durable close
 * opener (`native-warm-close-opener.ts`) also passes: a `failed` receipt whose
 * `backstop` is `checkpoint` (with 1. above still true) or `ttl` (recorded once
 * the lease's own `expiresAt` passed). See `nativeWarmSessionStopReadySql`.
 *
 * A lease with no native warm session passes (another adapter, a per-turn
 * native run, or a lease saved before the warm window was recorded). A missing run finish time, a
 * malformed timestamp, or any identity mismatch fails closed.
 *
 * Clock sources: `heartbeat_runs.finished_at` is written by the Paperclip server
 * (its Postgres/Node wall clock); `nativeHarnessBackup.completedAt` is the
 * checkpoint manifest's `completedAt`, written by the runner that produced the
 * backup; `warmNativeSessionClose.closedAt` is the Paperclip server's Node wall
 * clock when the close was confirmed. Staleness is therefore an ordering of
 * those recorded timestamps only; no timer, age or `now()` is ever used as
 * positive proof. Time is used only to bound the wait (`pendingCleanupRetryAfterMs`)
 * and to decide when to warn.
 *
 * This is the only definition. The expiry sweep embeds the SQL form in its
 * candidate condition; every physical dispatch calls
 * `assertNativeWarmSessionStopReady`, which evaluates the same SQL on the row.
 */

export const WARM_NATIVE_SESSION_CLOSE_KEY = "warmNativeSessionClose";
export const WARM_NATIVE_SESSION_CLOSE_SCHEMA = "paperclip.native-warm-session-close.v1";
/** Lease metadata recording a stop held by this gate: `{ since, warnedAt? }`. */
export const NATIVE_WARM_STOP_WAIT_KEY = "nativeWarmStopWait";
/** A held stop is re-checked by the pending-cleanup sweep after this long. */
export const NATIVE_WARM_STOP_RETRY_MS = 60_000;
/** A stop still held after this long gets one visible warning (it keeps waiting). */
export const NATIVE_WARM_STOP_WARN_AFTER_MS = 30 * 60_000;

/** Same key as `WARM_SANDBOX_IDLE_TIMEOUT_KEY` in warm-sandbox-expiry.ts (that module imports this one). */
const WARM_SANDBOX_IDLE_TIMEOUT_KEY = "warmSandboxIdleTimeoutMs";

const ISO_INSTANT = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";

function instantSql(value: SQL) {
  return sql`case when ${value} ~ ${ISO_INSTANT} then (${value})::timestamptz end`;
}

function leaseMetadataSql() {
  return sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)`;
}

/** The lease keeps a native warm session (see the module comment). */
export function nativeWarmSessionSql(): SQL {
  const metadata = leaseMetadataSql();
  return sql`(coalesce(${metadata}#>>'{reusableSandboxLease,adapterType}', '') = 'paperclip_runner'
    and ${metadata} ? ${WARM_SANDBOX_IDLE_TIMEOUT_KEY})`;
}

/**
 * The lease row's checkpoint stamp is a v2 stamp authorised for this exact
 * provider lease, and it covers the last finished turn on that provider lease
 * (every row of it); every run that used the provider lease has finished.
 */
export function nativeWarmCheckpointCoversLastTurnSql(): SQL {
  const metadata = leaseMetadataSql();
  const stamp = sql`${metadata}->'nativeHarnessBackup'`;
  const checkpointAt = instantSql(sql`${stamp}->>'completedAt'`);
  // Latest finished turn on the same provider lease, across every row of it.
  const lastFinishedTurn = sql`(select max(run.finished_at) from ${environmentLeases} source
    inner join ${heartbeatRuns} run on run.id = source.heartbeat_run_id
    where source.company_id = ${environmentLeases.companyId}
      and source.provider is not distinct from ${environmentLeases.provider}
      and source.provider_lease_id = ${environmentLeases.providerLeaseId})`;
  return sql`coalesce((
    ${environmentLeases.providerLeaseId} is not null
    and ${stamp}->>'schema' = 'paperclip.native-harness-backup-stamp.v2'
    and ${stamp}->>'authorizedProviderLeaseId' = ${environmentLeases.providerLeaseId}
    and ${checkpointAt} >= ${lastFinishedTurn}
    and not ${unfinishedTurnSql()}
  ), false)`;
}

/** Some run that used this provider lease has not finished (a missing finish fails closed). */
function unfinishedTurnSql(): SQL {
  return sql`exists (select 1 from ${environmentLeases} source
    inner join ${heartbeatRuns} run on run.id = source.heartbeat_run_id
    where source.company_id = ${environmentLeases.companyId}
      and source.provider is not distinct from ${environmentLeases.provider}
      and source.provider_lease_id = ${environmentLeases.providerLeaseId}
      and run.finished_at is null)`;
}

/**
 * The predicate, as a boolean SQL expression over the `environment_leases` row in scope.
 *
 * Besides a `closed` receipt, it accepts the explicit backstop the cleanup
 * sweep's close opener records once a close has been given up on
 * (`native-warm-close-opener.ts`): a `failed` receipt for the same provider
 * lease and run whose `backstop` is either `checkpoint` (bound to the stamp's
 * session and manifest, recorded no earlier than the stamp, and the stamp still
 * covers the last turn) or `ttl` (recorded no earlier than the lease's own
 * `expiresAt`). A `failed` receipt without a backstop never opens it.
 */
export function nativeWarmSessionStopReadySql(): SQL {
  const metadata = leaseMetadataSql();
  const stamp = sql`${metadata}->'nativeHarnessBackup'`;
  const close = sql`${metadata}->${WARM_NATIVE_SESSION_CLOSE_KEY}`;
  const backstop = sql`${close}->'backstop'`;
  const checkpointAt = instantSql(sql`${stamp}->>'completedAt'`);
  const closedAt = instantSql(sql`${close}->>'closedAt'`);
  const backstopAt = instantSql(sql`${backstop}->>'at'`);
  return sql`(
    not ${nativeWarmSessionSql()}
    or coalesce((
      ${environmentLeases.providerLeaseId} is not null
      and ${environmentLeases.heartbeatRunId} is not null
      and ${close}->>'schema' = ${WARM_NATIVE_SESSION_CLOSE_SCHEMA}
      and ${close}->>'providerLeaseId' = ${environmentLeases.providerLeaseId}
      and ${close}->>'runId' = ${environmentLeases.heartbeatRunId}::text
      and not ${unfinishedTurnSql()}
      and (
        (${close}->>'state' = 'closed'
          and ${close}->>'normalizedSessionId' = ${stamp}->>'normalizedSessionId'
          and ${close}->>'manifestSha256' = ${stamp}->>'manifestSha256'
          and ${closedAt} >= ${checkpointAt}
          and ${nativeWarmCheckpointCoversLastTurnSql()})
        or (${close}->>'state' = 'failed' and ${backstop}->>'kind' = 'checkpoint'
          and ${backstop}->>'normalizedSessionId' = ${stamp}->>'normalizedSessionId'
          and ${backstop}->>'manifestSha256' = ${stamp}->>'manifestSha256'
          and ${backstopAt} >= ${checkpointAt}
          and ${nativeWarmCheckpointCoversLastTurnSql()})
        or (${close}->>'state' = 'failed' and ${backstop}->>'kind' = 'ttl'
          and ${environmentLeases.expiresAt} is not null
          and ${backstopAt} >= ${environmentLeases.expiresAt})
      )
    ), false)
  )`;
}

export class NativeWarmSessionStopNotReadyError extends Error {
  readonly code = "native_warm_session_stop_not_ready";
  constructor(readonly leaseId: string) {
    super("native_warm_session_stop_not_ready: the native warm session has no current checkpoint and close receipt");
    this.name = "NativeWarmSessionStopNotReadyError";
  }
}

type LeaseIdentity = { id: string; companyId: string };

/** Evaluate the predicate on the saved lease row. A missing row fails closed. */
export async function nativeWarmSessionStopReady(db: Db, lease: LeaseIdentity): Promise<boolean> {
  const [row] = await db.select({ ready: sql<boolean>`${nativeWarmSessionStopReadySql()}` }).from(environmentLeases)
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  return row?.ready === true;
}

/** Call immediately before any provider stop, release or destroy dispatch. */
export async function assertNativeWarmSessionStopReady(db: Db, lease: LeaseIdentity): Promise<void> {
  if (!await nativeWarmSessionStopReady(db, lease)) throw new NativeWarmSessionStopNotReadyError(lease.id);
}

/**
 * The bounded durable wait for a stop the gate refused. The lease is (or is
 * moved to) `pending_cleanup` with a stop-and-retain intent where it was still
 * held, so nothing destroys the box, and gets a retry time for the pending-cleanup
 * sweep. Once the hold has lasted `NATIVE_WARM_STOP_WARN_AFTER_MS`, one warning
 * is logged and recorded as activity (claimed atomically, so it is only ever
 * one); the stop keeps waiting for the proof and never proceeds without it.
 */
export async function holdNativeWarmSessionStop(db: Db, lease: LeaseIdentity, now = Date.now()) {
  let [row] = await db.select().from(environmentLeases)
    .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId)));
  if (!row) return null;
  if (row.status === "active" && row.leasePolicy === "reuse_by_environment") {
    row = (await prepareSandboxStopAndRetain(db, row)) ?? row;
  } else if (row.status === "retained") {
    row = (await prepareSupersededWarmSandboxStop(db, row, { [NATIVE_WARM_STOP_WAIT_KEY]: true })) ?? row;
  }
  if (row.status !== "pending_cleanup") return row;
  const since = new Date(now).toISOString();
  const [held] = await db.update(environmentLeases).set({
    updatedAt: new Date(now),
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || jsonb_build_object(
      'pendingCleanupRetryAfterMs', ${now + NATIVE_WARM_STOP_RETRY_MS}::bigint,
      ${NATIVE_WARM_STOP_WAIT_KEY}::text, coalesce(${environmentLeases.metadata}->${NATIVE_WARM_STOP_WAIT_KEY}, '{}'::jsonb)
        || jsonb_build_object('since', coalesce(${environmentLeases.metadata}->${NATIVE_WARM_STOP_WAIT_KEY}->>'since', ${since}::text)))`,
  }).where(and(eq(environmentLeases.id, row.id), eq(environmentLeases.status, "pending_cleanup"))).returning();
  if (!held) return row;
  const [warned] = await db.update(environmentLeases).set({
    metadata: sql`jsonb_set(${environmentLeases.metadata}, ${`{${NATIVE_WARM_STOP_WAIT_KEY},warnedAt}`}::text[], to_jsonb(${since}::text))`,
  }).where(and(eq(environmentLeases.id, row.id),
    sql`${environmentLeases.metadata}->${NATIVE_WARM_STOP_WAIT_KEY}->>'warnedAt' is null`,
    sql`(${environmentLeases.metadata}->${NATIVE_WARM_STOP_WAIT_KEY}->>'since')::timestamptz <= ${new Date(now - NATIVE_WARM_STOP_WARN_AFTER_MS).toISOString()}::timestamptz`,
  )).returning({ id: environmentLeases.id });
  if (warned) {
    logger.warn({ leaseId: row.id, companyId: row.companyId, runId: row.heartbeatRunId, providerLeaseId: row.providerLeaseId,
      waitingSince: (held.metadata?.[NATIVE_WARM_STOP_WAIT_KEY] as { since?: string } | undefined)?.since },
    "native warm sandbox stop is still waiting for a current checkpoint and close receipt; the sandbox keeps running");
    await logActivity(db, { companyId: row.companyId, actorType: "system", actorId: "native-warm-stop-gate",
      action: "environment_lease.native_warm_stop_waiting", entityType: "environment_lease", entityId: row.id,
      runId: row.heartbeatRunId, issueId: row.issueId,
      details: { providerLeaseId: row.providerLeaseId, waitingSince: (held.metadata?.[NATIVE_WARM_STOP_WAIT_KEY] as { since?: string } | undefined)?.since ?? null },
    }).catch(() => logger.warn({ leaseId: row.id }, "could not record the native warm stop warning activity"));
  }
  return held;
}
