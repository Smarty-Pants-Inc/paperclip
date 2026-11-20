import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { PluginEnvironmentLease } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";

/** Internal lease journal, not an execution grant or a cached eligibility decision. */
export const SPECULATIVE_RESUME_KEY = "speculativeCommentResume";
export interface CommentResumeInput {
  companyId: string;
  agentId: string;
  issueId: string;
  commentId: string;
  environmentId: string | null;
  adapterType: string;
  adapterConfig?: Record<string, unknown>;
}
type Lease = typeof environmentLeases.$inferSelect;
interface Reservation {
  schema: "paperclip.speculative-comment-resume.v1";
  id: string;
  commentId: string;
  configDigest: string;
  startedAt: number;
  expiresAt: number;
  rpcDeadlineAt: number;
  state: "resuming" | "ready" | "failed";
  claimedBy?: string;
  result?: PluginEnvironmentLease;
}

/** Missing/invalid settings preserve the money bound; zero is not infinity. */
export function speculativeResumeTtlMs(): number {
  const value = Number(process.env.PAPERCLIP_SPECULATIVE_RESUME_TTL_MS);
  return Number.isSafeInteger(value) && value > 0 && value <= 300_000 ? value : 30_000;
}
export function readSpeculativeResume(metadata: Record<string, unknown> | null | undefined): Reservation | null {
  const value = metadata?.[SPECULATIVE_RESUME_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Reservation;
  return r.schema === "paperclip.speculative-comment-resume.v1" && typeof r.id === "string"
    && Number.isFinite(r.expiresAt) && Number.isFinite(r.rpcDeadlineAt)
    && ["resuming", "ready", "failed"].includes(r.state) ? r : null;
}

/** Commit the cleanup obligation BEFORE touching the provider. An authoritative
 * acquisition also writes this row, so it cannot race an unrecorded speculation.
 * The existing warm-expiry owner reconstructs this deadline after a restart. */
export async function startSpeculativeResume(db: Db, input: {
  lease: Lease; commentId: string; configDigest: string; rpcTimeoutMs: number;
  resume(timeoutMs: number): Promise<PluginEnvironmentLease>;
}): Promise<void> {
  const { lease } = input;
  const now = Date.now(), ttl = speculativeResumeTtlMs();
  const rpcTimeoutMs = Math.max(1, Math.min(ttl, input.rpcTimeoutMs));
  const reservation: Reservation = { schema: "paperclip.speculative-comment-resume.v1", id: randomUUID(),
    commentId: input.commentId, configDigest: input.configDigest, startedAt: now, expiresAt: now + ttl,
    rpcDeadlineAt: now + rpcTimeoutMs, state: "resuming" };
  const [reserved] = await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
    status: "retained", updatedAt: new Date(),
    metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination' - 'sandboxStopAndRetainReceipt')
      || ${JSON.stringify({ [SPECULATIVE_RESUME_KEY]: reservation })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.status, lease.status),
    sql`(${environmentLeases.status} = 'released' or not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${SPECULATIVE_RESUME_KEY}))`,
    sql`coalesce(${environmentLeases.metadata}->${SPECULATIVE_RESUME_KEY}->>'mode', '') <> 'authoritative'`,
    sql`${environmentLeases.metadata} is not distinct from ${JSON.stringify(lease.metadata)}::jsonb`,
    sql`exists (select 1 from heartbeat_runs owner where owner.id = ${lease.heartbeatRunId}
      and owner.company_id = ${lease.companyId}
      and owner.status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))`,
    sql`not exists (select 1 from environment_leases peer where peer.id <> ${lease.id}
      and peer.provider = ${lease.provider} and peer.provider_lease_id = ${lease.providerLeaseId}
      and peer.status in ('active', 'retained', 'pending_cleanup'))`,
    sql`not exists (select 1 from heartbeat_runs run where run.company_id = ${lease.companyId}
      and run.status = 'running' and (run.issue_id = ${lease.issueId} or run.native_issue_id = ${lease.issueId}))`,
  )).returning(), { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined });
  if (!reserved) return;
  logger.info({ event: "sandbox.speculative_resume.started", count: 1, companyId: lease.companyId,
    issueId: lease.issueId, leaseId: lease.id, commentId: input.commentId, reservationId: reservation.id,
    startedAt: now, expiresAt: reservation.expiresAt }, "Speculative sandbox resume started");
  let result: PluginEnvironmentLease | undefined;
  try {
    const remainingMs = Math.min(rpcTimeoutMs, reservation.expiresAt - Date.now());
    if (remainingMs <= 0) throw new Error("speculative_resume_expired_before_dispatch");
    result = await input.resume(remainingMs);
    if (result.providerLeaseId !== lease.providerLeaseId) throw new Error("speculative_resume_allocation_mismatch");
  } catch {
    result = undefined;
    // A transport failure is not absence and never authorizes replacement here.
    // Keep the paid-resource obligation even when the provider outcome is unknown.
    logger.warn({ event: "sandbox.speculative_resume.failed", leaseId: lease.id, reservationId: reservation.id },
      "Speculative sandbox resume has no confirmed result; stop-only cleanup remains due");
  }
  await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ updatedAt: new Date(),
    metadata: sql`jsonb_set(${environmentLeases.metadata}, array[${SPECULATIVE_RESUME_KEY}],
      (${environmentLeases.metadata}->${SPECULATIVE_RESUME_KEY}) || ${JSON.stringify({
        state: result ? "ready" : "failed", ...(result ? { result } : {}),
      })}::jsonb)`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    eq(environmentLeases.status, "retained"),
    sql`${environmentLeases.metadata}->${SPECULATIVE_RESUME_KEY}->>'id' = ${reservation.id}`)).returning(),
  { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined });
}

/** This is called at the ORIGINAL resume site, after its current scope/config/
 * worker checks. It either performs that call or joins the exact saved call;
 * provider resume is never skipped on the strength of retained DB state alone. */
export async function resumeWithSpeculation(db: Db, input: {
  leaseId: string; companyId: string; runId: string; enabled: boolean; configDigest: string;
  resume(): Promise<PluginEnvironmentLease>;
}): Promise<PluginEnvironmentLease> {
  if (!input.enabled) return input.resume();
  const reservation = await db.transaction(async tx => {
    const [lease] = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
    )).for("update");
    if (!lease || !["released", "retained", "active"].includes(lease.status))
      throw new Error("speculative_resume_source_unavailable");
    const saved = lease.status === "retained" ? readSpeculativeResume(lease.metadata) : null;
    const journal = lease.metadata?.[SPECULATIVE_RESUME_KEY] as { mode?: unknown } | undefined;
    if (lease.status === "retained" && journal && !saved && journal.mode !== "authoritative")
      throw new Error("speculative_resume_journal_invalid");
    if (saved) {
      if (saved.configDigest !== input.configDigest) throw new Error("speculative_resume_config_changed");
      if (saved.expiresAt <= Date.now() || saved.claimedBy && saved.claimedBy !== input.runId)
        throw new Error("speculative_resume_unclaimed_deadline_or_owner_changed");
      await tx.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata},
        array[${SPECULATIVE_RESUME_KEY}, 'claimedBy'], ${JSON.stringify(input.runId)}::jsonb)` })
        .where(eq(environmentLeases.id, lease.id));
      return saved;
    }
    // A barrier for the normal path closes the select/reserve race. A later
    // speculation's snapshot CAS loses; no provider I/O is held under this lock.
    await tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)
      || ${JSON.stringify({ [SPECULATIVE_RESUME_KEY]: { mode: "authoritative", runId: input.runId } })}::jsonb` })
      .where(eq(environmentLeases.id, lease.id));
    return null;
  });
  if (!reservation) return input.resume();
  logger.info({ event: "sandbox.speculative_resume.claimed", leaseId: input.leaseId, runId: input.runId,
    reservationId: reservation.id, commentId: reservation.commentId }, "Authoritative resume joined speculative resume");
  // Concrete in-flight obligation only, bounded by its saved provider deadline.
  // Cross-process callers observe the same journal; there is no idle poller.
  let saved: Reservation | null = reservation;
  while (saved?.state === "resuming" && Date.now() <= Math.max(saved.expiresAt, saved.rpcDeadlineAt)) {
    await delay(25);
    const [current] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, input.leaseId), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.status, "retained"),
    ));
    saved = current ? readSpeculativeResume(current.metadata) : null;
    if (saved?.id !== reservation.id) throw new Error("speculative_resume_reservation_changed");
  }
  if (saved?.state !== "ready" || !saved.result) throw new Error("speculative_resume_result_unavailable");
  return saved.result;
}
