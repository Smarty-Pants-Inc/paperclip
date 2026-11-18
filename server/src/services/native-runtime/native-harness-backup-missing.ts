import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { writeEnvironmentCleanup } from "../environment-cleanup-notifications.js";

export type NativeHarnessBackupMissingReason = "close_failed" | "release_without_checkpoint" | "retries_exhausted";

export interface NativeHarnessBackupMissing {
  runId: string;
  sessionId: string;
  /** The Runner's sessions/<sha256(normalizedSessionId)> directory name. */
  sessionRootDigest: string;
  reason: NativeHarnessBackupMissingReason;
  at: string;
}

/** Presence fails closed, including a marker a newer release wrote. Stop keeps the disk. */
export function hasNativeHarnessBackupMissing(lease: { metadata: Record<string, unknown> | null }): boolean {
  return Object.hasOwn(lease.metadata ?? {}, "nativeHarnessBackupMissing");
}

/** Bind custody to the admitted row, never every lease of the same box or run. */
export async function markNativeHarnessBackupMissing(db: Db, input: {
  companyId: string; environmentId: string; providerLeaseId: string; runId: string;
  leaseId?: string; sessionId: string; reason: NativeHarnessBackupMissingReason;
}): Promise<void> {
  const identity = and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.environmentId, input.environmentId), eq(environmentLeases.providerLeaseId, input.providerLeaseId),
    eq(environmentLeases.heartbeatRunId, input.runId));
  let leaseId = input.leaseId;
  if (!leaseId) {
    // Old/in-process owners may predate the row-id binding. Ambiguity grants no
    // authority to mark a neighboring lease; retain the owner until reconciled.
    const candidates = await db.select().from(environmentLeases).where(identity);
    const retained = candidates.filter(row => row.companyId === input.companyId && row.environmentId === input.environmentId
      && row.providerLeaseId === input.providerLeaseId && row.heartbeatRunId === input.runId && row.status === "retained");
    if (!retained.length) return;
    if (retained.length !== 1) throw new Error("native_harness_backup_missing_lease_ambiguous");
    leaseId = retained[0]!.id;
  }
  const marker: NativeHarnessBackupMissing = { runId: input.runId, sessionId: input.sessionId,
    sessionRootDigest: createHash("sha256").update(input.sessionId).digest("hex"), reason: input.reason, at: new Date().toISOString() };
  // The UPDATE takes this row's lock, which the final destroy claim
  // (claimLeaseForDestroyUnlessHeld) holds on every row of the allocation: the
  // marker commits before that claim reads, or waits for it. Confirm the row.
  const updated = await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ nativeHarnessBackupMissing: marker })}::jsonb`,
    updatedAt: new Date(),
  }).where(and(identity, eq(environmentLeases.id, leaseId))).returning({ id: environmentLeases.id }),
  { companyId: input.companyId, runId: input.runId, leaseId });
  if (!Array.isArray(updated) || updated.length !== 1) throw new Error("native_harness_backup_missing_not_recorded");
}

/** Only a newer successful backup of this session on this allocation discharges custody.
 * The marker can remain on an earlier owner row after a warm reusable handoff. */
export async function clearNativeHarnessBackupMissing(db: Db, input: {
  companyId: string; providerLeaseId: string; sessionId: string; completedAt: string;
}): Promise<void> {
  const rows = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.providerLeaseId, input.providerLeaseId),
    sql`${environmentLeases.metadata}->'nativeHarnessBackupMissing'->>'sessionId' = ${input.sessionId}`,
  ));
  const sessionRootDigest = createHash("sha256").update(input.sessionId).digest("hex");
  for (const row of rows) {
    const marker = row.metadata?.nativeHarnessBackupMissing as Partial<NativeHarnessBackupMissing> | undefined;
    if (row.companyId !== input.companyId || row.providerLeaseId !== input.providerLeaseId
      || !marker || marker.sessionId !== input.sessionId || marker.sessionRootDigest !== sessionRootDigest
      || typeof marker.at !== "string" || !Number.isFinite(Date.parse(marker.at))
      || Date.parse(marker.at) > Date.parse(input.completedAt)) continue;
    await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} - 'nativeHarnessBackupMissing'`, updatedAt: new Date(),
    }).where(and(eq(environmentLeases.id, row.id), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.providerLeaseId, input.providerLeaseId),
      sql`${environmentLeases.metadata}->'nativeHarnessBackupMissing' = ${JSON.stringify(marker)}::jsonb`)),
    { companyId: input.companyId, runId: row.heartbeatRunId ?? undefined, leaseId: row.id });
  }
}
