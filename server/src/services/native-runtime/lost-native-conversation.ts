import { and, eq, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { reusableLeaseHistoryWithDeletedTaskBindings } from "../environment-lease-handoff.js";
import { HELD_BOX_LOST, HeldBoxLostError, ReusableConversationHeldError, LOST_CONVERSATION_SOURCE_KEY, LOST_CONVERSATION_SOURCE_SCHEMA,
  nativeConversationSourceIsLost } from "../held-conversation-state.js";
import { readNativeHarnessBackupStamp, type NativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { verifyRecoverableNativeHarnessBackup } from "./native-harness-backup-storage.js";
import { retiredSourceAuthorizesNativeBackupRestore } from "./native-retired-backup-source.js";

type LostSource = Pick<typeof environmentLeases.$inferSelect,
  "companyId" | "providerLeaseId" | "status" | "cleanupStatus" | "failureReason" | "metadata">;

/** An authoritative provider miss retires selection, not memory. Keep the backup and all
 * history on the lease; never queue a destroy, and never write a termination receipt we did not receive. */
export async function recordLostNativeConversationSource(db: Db, lease: EnvironmentLease, observation: string) {
  const [recorded] = await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", failureReason: HELD_BOX_LOST,
    metadata: { ...lease.metadata, [LOST_CONVERSATION_SOURCE_KEY]: { schema: LOST_CONVERSATION_SOURCE_SCHEMA,
      providerLeaseId: lease.providerLeaseId, observedAt: new Date().toISOString(), observation } }, updatedAt: new Date(),
  }).where(and(eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), eq(environmentLeases.status, lease.status),
    sql`${environmentLeases.heartbeatRunId} is not distinct from ${lease.heartbeatRunId}`,
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    sql`not exists (select 1 from ${environmentLeases} busy where busy.company_id = ${lease.companyId}
      and busy.provider_lease_id = ${lease.providerLeaseId} and busy.status = 'active' and busy.id <> ${lease.id})`,
  )).returning();
  if (!recorded) throw new ReusableConversationHeldError("source_ownership_changed"); // do not allocate
  return recorded;
}

async function lostNativeConversationSources(db: Db, input: {
  companyId: string; normalizedSessionId: string; currentRunId: string;
}) {
  const rows = await db.select({ lostSourceLease: environmentLeases }).from(environmentLeases)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, environmentLeases.companyId), eq(heartbeatRuns.id, environmentLeases.heartbeatRunId)))
    .where(and(eq(environmentLeases.companyId, input.companyId),
      or(eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
        sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'normalizedSessionId' = ${input.normalizedSessionId}`),
      ne(heartbeatRuns.id, input.currentRunId), eq(environmentLeases.status, "expired"), eq(environmentLeases.cleanupStatus, "success")));
  return rows.map(row => row.lostSourceLease).filter(row => row && nativeConversationSourceIsLost(row)
    && !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
}

/** Used before acquisition as well as by recovery without a retained binding. Looking up
 * the session, not the newest task run, keeps an earlier authoritative loss durable across retries.
 * Finding loss is not yet choosing a save: failed empty successors must not hide its real source. */
export async function findLostNativeConversationSource(db: Db, input: {
  companyId: string; normalizedSessionId: string; currentRunId: string; sourceProviderLeaseId?: string;
}) {
  if (input.sourceProviderLeaseId) {
    const history = await reusableLeaseHistoryWithDeletedTaskBindings(db, input.companyId, input.sourceProviderLeaseId);
    return history.find(row => row.companyId === input.companyId && row.providerLeaseId === input.sourceProviderLeaseId
      && !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor") && nativeConversationSourceIsLost(row)) ?? null;
  }
  return (await lostNativeConversationSources(db, input))[0] ?? null;
}

/** ONE lost-box settlement decision, shared by acquisition, executor preparation, and
 * retained-binding recovery. A verified save continues the SAME provider session. No proof
 * means one named operator state, never permission to initialize a new provider session.
 * Restoration still checks the execution fingerprint and provider identity at its consumer. */
export async function settleLostNativeConversation(db: Db, input: {
  source: LostSource;
  currentRunId: string; normalizedSessionId: string; runnerInstanceId?: string;
  manifestSha256?: string; targetProviderLeaseId?: string | null;
}) {
  if (!nativeConversationSourceIsLost(input.source) || !input.source.providerLeaseId) throw new HeldBoxLostError();
  // A consumer can discover an unusable controller/provider save after byte
  // verification. Once that run named the loss, later messages must not buy a
  // new empty box per attempt. Only the explicit Retry/reset boundary clears it.
  const [settledLoss] = await db.select({ heldLossRunId: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.source.companyId), ne(heartbeatRuns.id, input.currentRunId),
    eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.errorCode, HELD_BOX_LOST),
    or(eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId), eq(heartbeatRuns.sessionIdBefore, input.normalizedSessionId)),
  )).limit(1);
  if (settledLoss) throw new HeldBoxLostError();
  const sources: LostSource[] = [input.source, ...await lostNativeConversationSources(db, {
    companyId: input.source.companyId, normalizedSessionId: input.normalizedSessionId, currentRunId: input.currentRunId })];
  const seen = new Set<string>();
  const stamps: Array<{ source: LostSource; stamp: NativeHarnessBackupStamp }> = [];
  for (const source of sources) {
    if (!source.providerLeaseId || seen.has(source.providerLeaseId)) continue;
    seen.add(source.providerLeaseId);
    const history = await reusableLeaseHistoryWithDeletedTaskBindings(db, source.companyId, source.providerLeaseId);
    for (const row of history) {
      const stamp = readNativeHarnessBackupStamp(row.metadata?.nativeHarnessBackup, source.providerLeaseId);
      if (stamp) stamps.push({ source, stamp });
    }
  }
  // Timestamps only order attempts. Each source must independently cover the
  // current durable event cursor and pass the same ownership/lineage fences.
  stamps.sort((a, b) => Date.parse(b.stamp.completedAt) - Date.parse(a.stamp.completedAt));
  for (const { source, stamp } of stamps) {
    if (stamp.normalizedSessionId !== input.normalizedSessionId
      || input.runnerInstanceId && stamp.runnerInstanceId !== input.runnerInstanceId
      || input.manifestSha256 && stamp.manifestSha256 !== input.manifestSha256) continue;
    if (!await verifyRecoverableNativeHarnessBackup({ db, companyId: source.companyId, stamp, providerLeaseId: source.providerLeaseId! })) continue;
    if (await retiredSourceAuthorizesNativeBackupRestore(db, { companyId: source.companyId, currentRunId: input.currentRunId,
      normalizedSessionId: input.normalizedSessionId, manifest: stamp, manifestSha256: stamp.manifestSha256,
      targetProviderLeaseId: input.targetProviderLeaseId })) return stamp;
  }
  throw new HeldBoxLostError();
}
