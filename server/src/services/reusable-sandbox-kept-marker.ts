import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY = "reusableSandboxKeptAfterReplacement";

/** Who cleared ONE kept box and why, recorded on its lease in the claim write
 * (`destroyKeptReusableSandboxLease`), with the block it removed. */
export const KEPT_SANDBOX_CLEARED_BY_OPERATOR_KEY = "keptSandboxClearedByOperator";

/**
 * Why a run kept an old box when it moved the chat to a new one. Recorded on
 * the kept lease with the block itself:
 * - `identity_mismatch`: the provider resumed a box at that id whose workspace
 *   sentinel does not match. A box exists there, so it is never destroyed.
 * - `resume_failed`: the box could not be resumed and its run moved to a new
 *   box (a projectless chat's box is always kept, never retired).
 */
export type ReusableSandboxKeptReason = "identity_mismatch" | "resume_failed";

/**
 * The block on a kept box. Nothing automatic clears it: no sweep, expiry,
 * retry or later run removes this key. Only a person clears it, in the same
 * write that claims the box for destruction:
 * - the narrow per-box action, POST /api/environment-leases/:leaseId/destroy-kept-sandbox
 *   (routes/environments.ts, `destroyKeptReusableSandboxLease`), which records
 *   the actor and reason on the lease (`keptSandboxClearedByOperator`) and in
 *   the activity log and touches no other lease;
 * - the consented environment delete (DELETE /api/environments/:id?destroyReusableSandboxLeases=true,
 *   `destroyReusableSandboxLeasesForEnvironment` with `releasesKeptSandbox`).
 */
export type ReusableSandboxKeptMarker = {
  runId: string;
  replacementLeaseId: string;
  recordedAt: string;
  reason?: ReusableSandboxKeptReason;
  /** The run replaced the box because a predecessor Runner on it could not be retired. */
  predecessorRetirementUnproven?: true;
  /** How many channels to the kept box were refused after the switch. */
  fenceRefusals?: number;
  lastFenceRefusal?: { channel: KeptSandboxFenceChannel; at: string };
};

export function reusableSandboxKeptAfterReplacement(lease: Pick<EnvironmentLease, "metadata">): boolean {
  const marker = lease.metadata?.[REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY];
  return typeof marker === "object" && marker !== null && !Array.isArray(marker);
}

export function reusableSandboxNotKeptAfterReplacementSql() {
  return sql`not coalesce(${environmentLeases.metadata} ? ${REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY}, false)`;
}

/**
 * The retire case's fence: a workspace chat's old box whose state the run
 * captured for the restore on a new box (the replacement plan pinned its
 * committed snapshot and verified harness backup, and the replacement carries
 * that backup). From the capture until the old box is retired, the same
 * channel fence as a kept box refuses it, so nothing it writes after the
 * capture can land where the restore would not carry it.
 *
 * The fence holds while the capturing run is live, and after the retire
 * (the lease leaves released/retained). A failed restore lifts it at once
 * (`liftRestoreCaptureFence`), so the old box stays usable for the next
 * attempt; a crash before that lifts it when the run ends.
 */
export const REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY = "reusableSandboxRestoreCaptureFence";

export type ReusableSandboxRestoreCaptureFence = {
  runId: string;
  capturedAt: string;
  fenceRefusals?: number;
  lastFenceRefusal?: { channel: KeptSandboxFenceChannel; at: string };
};

function restoreCaptureFenceActiveSql() {
  const key = REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY;
  return sql`(jsonb_typeof(${environmentLeases.metadata}->${key}::text) = 'object' AND (
    ${environmentLeases.status} NOT IN ('released', 'retained')
    OR EXISTS (SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.id}::text = ${environmentLeases.metadata}->${key}::text->>'runId'
        AND ${heartbeatRuns.status} IN ('queued', 'scheduled_retry', 'running'))))`;
}

/** Exact workspace state read by the retire plan, not a fresh read at the fence. */
export type ReusableSandboxRestoreCapture = {
  workspaceMetadata: Record<string, unknown> | null;
  snapshotId: string;
};

/** One compare-and-swap: fence only if every captured safety condition still
 * holds. Never overwrite another capture, even one whose run has ended. The
 * caller must refuse/re-plan on zero rows, before creating a replacement. */
export async function fenceReusableSandboxAtRestoreCapture(db: Db, input: {
  lease: EnvironmentLease;
  heartbeatRunId: string;
  capture: ReusableSandboxRestoreCapture;
}): Promise<boolean> {
  const { lease, capture } = input;
  if (!lease.providerLeaseId || !lease.executionWorkspaceId) return false;
  const fence: ReusableSandboxRestoreCaptureFence = { runId: input.heartbeatRunId, capturedAt: new Date().toISOString() };
  const [fenced] = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)
      || ${JSON.stringify({ [REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY]: fence })}::jsonb`,
  }).where(and(
    eq(environmentLeases.id, input.lease.id),
    eq(environmentLeases.companyId, input.lease.companyId),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
    inArray(environmentLeases.status, ["released", "retained"]),
    eq(environmentLeases.status, lease.status),
    sql`${environmentLeases.environmentId} IS NOT DISTINCT FROM ${lease.environmentId}::uuid`,
    eq(environmentLeases.leasePolicy, lease.leasePolicy),
    sql`${environmentLeases.heartbeatRunId} IS NOT DISTINCT FROM ${lease.heartbeatRunId}::uuid`,
    eq(environmentLeases.executionWorkspaceId, lease.executionWorkspaceId),
    sql`${environmentLeases.issueId} IS NOT DISTINCT FROM ${lease.issueId}::uuid`,
    sql`${environmentLeases.metadata} IS NOT DISTINCT FROM ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`,
    sql`not coalesce(${environmentLeases.metadata} ? ${REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY}, false)`,
    reusableSandboxNotKeptAfterReplacementSql(),
    // Re-check the plan's idle-owner predicate in this same statement.
    sql`NOT EXISTS (SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.companyId} = ${lease.companyId}
        AND ${heartbeatRuns.id} = ${environmentLeases.heartbeatRunId}
        AND ${heartbeatRuns.id} <> ${input.heartbeatRunId}::uuid
        AND ${heartbeatRuns.status} IN ('queued', 'scheduled_retry', 'running'))`,
    sql`EXISTS (SELECT 1 FROM ${executionWorkspaces}
      WHERE ${executionWorkspaces.companyId} = ${lease.companyId}
        AND ${executionWorkspaces.id} = ${lease.executionWorkspaceId}::uuid
        AND ${executionWorkspaces.metadata} IS NOT DISTINCT FROM ${capture.workspaceMetadata === null ? null : JSON.stringify(capture.workspaceMetadata)}::jsonb)`,
    sql`EXISTS (SELECT 1 FROM ${executionWorkspaceSnapshots}
      WHERE ${executionWorkspaceSnapshots.companyId} = ${lease.companyId}
        AND ${executionWorkspaceSnapshots.executionWorkspaceId} = ${lease.executionWorkspaceId}::uuid
        AND ${executionWorkspaceSnapshots.id} = ${capture.snapshotId}::uuid
        AND ${executionWorkspaceSnapshots.status} = 'committed')`,
  )).returning({ id: environmentLeases.id });
  return Boolean(fenced);
}

/** Lift the capture fence this run set, while the old box is not retired. */
export async function liftRestoreCaptureFence(db: Db, input: {
  companyId: string;
  leaseId: string;
  heartbeatRunId: string;
}): Promise<boolean> {
  const key = REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY;
  const [lifted] = await db.update(environmentLeases).set({
    metadata: sql`${environmentLeases.metadata} - ${key}::text`,
  }).where(and(
    eq(environmentLeases.id, input.leaseId),
    eq(environmentLeases.companyId, input.companyId),
    inArray(environmentLeases.status, ["released", "retained"]),
    sql`${environmentLeases.metadata}->${key}::text->>'runId' = ${input.heartbeatRunId}`,
  )).returning({ id: environmentLeases.id });
  return Boolean(lifted);
}

/** Every channel through which bytes from a box reach Paperclip, or Paperclip wakes it. */
export type KeptSandboxFenceChannel =
  | "runner_ingress" | "duplex_channel" | "execute" | "sync_out" | "resume";

export const REUSABLE_SANDBOX_KEPT_FENCED_CODE = "reusable_sandbox_kept_fenced";

/** A channel to a box that was kept after its chat moved to a new box, or
 * whose state was captured for a restore on a new box. */
export class ReusableSandboxKeptFencedError extends Error {
  readonly code = REUSABLE_SANDBOX_KEPT_FENCED_CODE;
  constructor(readonly providerLeaseId: string, readonly channel: KeptSandboxFenceChannel,
    readonly fence: "kept" | "restore_capture" = "kept") {
    super(fence === "kept"
      ? `${REUSABLE_SANDBOX_KEPT_FENCED_CODE}: the box ${providerLeaseId} was kept after its chat moved to a new box; `
        + `Paperclip accepts nothing from it (${channel}).`
      : `${REUSABLE_SANDBOX_KEPT_FENCED_CODE}: the box ${providerLeaseId} is being replaced from its captured state; `
        + `Paperclip accepts nothing from it (${channel}).`);
    this.name = "ReusableSandboxKeptFencedError";
  }
}

function countRefusalSql(key: string, channel: KeptSandboxFenceChannel, at: string) {
  return sql`jsonb_set(${environmentLeases.metadata}, array[${key}::text],
      (${environmentLeases.metadata}->${key}::text)
      || jsonb_build_object('fenceRefusals',
        coalesce((${environmentLeases.metadata}->${key}::text->>'fenceRefusals')::int, 0) + 1,
        'lastFenceRefusal', jsonb_build_object('channel', ${channel}::text, 'at', ${at}::text)))`;
}

/**
 * The write fence on a kept box, by its lease identity. Paperclip reaches a
 * box's Runner only through a channel it opens for a lease (provider ingress
 * for PRP events, checkpoints, results and tool calls; the duplex callback
 * bridge; command output; file sync-out; resume). Once any lease row of this
 * company names the box with the kept block, every such channel is refused
 * BEFORE the provider is called, so a Runner that survived on the kept box
 * (a resume within ~10 minutes can return the same machine with its memory
 * and programs) can never write to this chat again. The fresh row read means a
 * stale lease object held by an older controller cannot bypass it. Each
 * refusal is counted on the kept lease and logged.
 *
 * The same fence refuses a box under the retire case's capture fence
 * (`REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY`), counted on that marker.
 */
export async function assertSandboxNotKeptAfterReplacement(db: Db, input: {
  lease: Pick<EnvironmentLease, "companyId" | "providerLeaseId">;
  channel: KeptSandboxFenceChannel;
}): Promise<void> {
  const providerLeaseId = input.lease.providerLeaseId;
  if (!providerLeaseId) return;
  const at = new Date().toISOString();
  const key = REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY;
  const refused = await db.update(environmentLeases).set({
    metadata: countRefusalSql(key, input.channel, at),
  }).where(and(
    eq(environmentLeases.companyId, input.lease.companyId),
    eq(environmentLeases.providerLeaseId, providerLeaseId),
    sql`jsonb_typeof(${environmentLeases.metadata}->${key}::text) = 'object'`,
  )).returning({ id: environmentLeases.id });
  if (refused.length > 0) {
    logger.warn({ companyId: input.lease.companyId, providerLeaseId, channel: input.channel,
      keptLeaseIds: refused.map(row => row.id) }, "refused a channel to a box kept after its chat moved to a new box");
    throw new ReusableSandboxKeptFencedError(providerLeaseId, input.channel);
  }
  const captured = await db.update(environmentLeases).set({
    metadata: countRefusalSql(REUSABLE_SANDBOX_RESTORE_CAPTURE_FENCE_KEY, input.channel, at),
  }).where(and(
    eq(environmentLeases.companyId, input.lease.companyId),
    eq(environmentLeases.providerLeaseId, providerLeaseId),
    restoreCaptureFenceActiveSql(),
  )).returning({ id: environmentLeases.id });
  if (captured.length === 0) return;
  logger.warn({ companyId: input.lease.companyId, providerLeaseId, channel: input.channel,
    fencedLeaseIds: captured.map(row => row.id) }, "refused a channel to a box whose state was captured for a restore on a new box");
  throw new ReusableSandboxKeptFencedError(providerLeaseId, input.channel, "restore_capture");
}
