import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

export const REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY = "reusableSandboxKeptAfterReplacement";

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
 * retry or later run removes this key. Only a person's consented environment
 * delete (DELETE /api/environments/:id?destroyReusableSandboxLeases=true,
 * routes/environments.ts, `destroyReusableSandboxLeasesForEnvironment` with
 * `releasesKeptSandbox`) destroys the box and removes the key in the same write.
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

/** Every channel through which bytes from a box reach Paperclip, or Paperclip wakes it. */
export type KeptSandboxFenceChannel =
  | "runner_ingress" | "duplex_channel" | "execute" | "sync_out" | "resume";

export const REUSABLE_SANDBOX_KEPT_FENCED_CODE = "reusable_sandbox_kept_fenced";

/** A channel to a box that was kept after its chat moved to a new box. */
export class ReusableSandboxKeptFencedError extends Error {
  readonly code = REUSABLE_SANDBOX_KEPT_FENCED_CODE;
  constructor(readonly providerLeaseId: string, readonly channel: KeptSandboxFenceChannel) {
    super(`${REUSABLE_SANDBOX_KEPT_FENCED_CODE}: the box ${providerLeaseId} was kept after its chat moved to a new box; `
      + `Paperclip accepts nothing from it (${channel}).`);
    this.name = "ReusableSandboxKeptFencedError";
  }
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
    metadata: sql`jsonb_set(${environmentLeases.metadata}, array[${key}::text],
      (${environmentLeases.metadata}->${key}::text)
      || jsonb_build_object('fenceRefusals',
        coalesce((${environmentLeases.metadata}->${key}::text->>'fenceRefusals')::int, 0) + 1,
        'lastFenceRefusal', jsonb_build_object('channel', ${input.channel}::text, 'at', ${at}::text)))`,
  }).where(and(
    eq(environmentLeases.companyId, input.lease.companyId),
    eq(environmentLeases.providerLeaseId, providerLeaseId),
    sql`jsonb_typeof(${environmentLeases.metadata}->${key}::text) = 'object'`,
  )).returning({ id: environmentLeases.id });
  if (refused.length === 0) return;
  logger.warn({ companyId: input.lease.companyId, providerLeaseId, channel: input.channel,
    keptLeaseIds: refused.map(row => row.id) }, "refused a channel to a box kept after its chat moved to a new box");
  throw new ReusableSandboxKeptFencedError(providerLeaseId, input.channel);
}
