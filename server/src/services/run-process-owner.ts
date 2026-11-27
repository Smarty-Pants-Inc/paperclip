import { heartbeatRuns, heartbeatRunEvents, type Db } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { proveOwnerGone, type LocalOwnerStamp, type OwnerProof, type ProcessProbe } from "./owner-proof.js";
import { runProcessOwnerStamp } from "./native-runtime/native-owner-stamps.js";

/** The process identity a heartbeat run records for its adapter child
 * (`persistHeartbeatRunProcessMetadata`). */
export type RunProcessIdentity = Pick<typeof heartbeatRuns.$inferSelect,
  "processPid" | "processGroupId" | "processStartedAt" | "processHostHash">;

/**
 * The owner stamp the lost-process reapers judge a run's adapter child by.
 *
 * It is the shared `runProcessOwnerStamp` (native-owner-stamps.ts) with the
 * one-release local proof for rows saved before `process_host_hash` (#19871,
 * #19883; single-host servers only). A row that recorded only a process group
 * is judged by that group: its leader's PID is the group id. The active
 * execution reaper, the orphan sweep and hot-restart adoption all read it, so
 * they reach one verdict for one row.
 *
 * Returns null when the run recorded no process.
 */
export function lostProcessOwnerStamp(run: RunProcessIdentity, scope: string): LocalOwnerStamp | null {
  const pid = run.processPid ?? run.processGroupId ?? null;
  if (pid === null) return null;
  return runProcessOwnerStamp({ ...run, processPid: pid }, scope, { legacyFallback: true });
}

/** No identity is different from a recorded process that cannot be proven gone.
 * Include the durable identity event: a remote PID need not be in the local columns. */
export async function runHasNoProcessIdentity(db: Pick<Db, "select">, companyId: string, runId: string) {
  const [row] = await db.select({ missing: sql<boolean>`${heartbeatRuns.processPid} is null
    and ${heartbeatRuns.processGroupId} is null and not exists (
      select 1 from ${heartbeatRunEvents} e where e.company_id = ${companyId}::uuid
        and e.run_id = ${runId}::uuid and e.event_type = 'native.process_identity_recorded')` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  return row?.missing === true;
}

/** Provider activity can have written files even when old releases lost identity.
 * Do not use launch/request events as evidence that files can be discarded. */
export async function runHasProviderWork(db: Pick<Db, "select">, companyId: string, runId: string) {
  const [event] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
    inArray(heartbeatRunEvents.eventType, ["session.started", "session.resumed", "session.updated", "turn.started",
      "turn.submitted", "turn.accepted", "item.started", "tool.execution.started", "provider.event", "provider.rpc_result"]),
  )).limit(1);
  return Boolean(event);
}

/** A warm transport does not spawn again. Record its existing owner on the
 * incoming run before admitting another turn; never invent an identity. */
export async function recordReusedRunProcessIdentity(db: Pick<Db, "select">, input: {
  companyId: string; agentId: string; sourceRunId: string;
  onSpawn: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}) {
  const [source] = await db.select({ pid: heartbeatRuns.processPid, group: heartbeatRuns.processGroupId,
    startedAt: heartbeatRuns.processStartedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.id, input.sourceRunId)));
  const pid = source?.pid ?? source?.group;
  if (!pid || !source?.startedAt) throw new Error("native_warm_process_identity_unavailable");
  await input.onSpawn({ pid, processGroupId: source.group, startedAt: source.startedAt.toISOString() });
}

/** Proves whether a run's adapter child is gone. Null when no process was
 * recorded. `unprovable` never releases the run: its operator action is Stop. */
export async function proveRunProcessGone(run: RunProcessIdentity, scope: string,
  probe?: ProcessProbe): Promise<OwnerProof | null> {
  const stamp = lostProcessOwnerStamp(run, scope);
  return stamp ? proveOwnerGone(stamp, probe) : null;
}
