import { agentRuntimeState, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * The agent runtime row's last-run pointer and status: the one writer behind
 * the live completion's updateRuntimeState and the native run terminal step
 * (smarty-dev#21005). `onlyIfNotOlder` keeps a late writer for an older run
 * from replacing the pointer of a newer run, and skips a write that changes
 * nothing, so a repeated call is a no-op.
 */
export async function writeRuntimeRunPointer(
  db: Db,
  agent: { id: string; companyId: string; adapterType: string },
  run: { id: string; status: string; error?: string | null; createdAt?: Date | null },
  options: { sessionId?: string | null; onlyIfNotOlder?: boolean } = {},
) {
  await db.insert(agentRuntimeState).values({
    agentId: agent.id, companyId: agent.companyId, adapterType: agent.adapterType, stateJson: {},
  }).onConflictDoNothing({ target: agentRuntimeState.agentId });
  const notOlder = options.onlyIfNotOlder
    ? sql`(${agentRuntimeState.lastRunId} is null or ${agentRuntimeState.lastRunId} = ${run.id}
        or not exists (select 1 from heartbeat_runs newer
          where newer.id = ${agentRuntimeState.lastRunId}
            and newer.created_at > (select current_run.created_at from heartbeat_runs current_run where current_run.id = ${run.id})))
      and (${agentRuntimeState.lastRunId} is distinct from ${run.id}
        or ${agentRuntimeState.lastRunStatus} is distinct from ${run.status}
        or ${agentRuntimeState.lastError} is distinct from ${run.error ?? null}
        or ${agentRuntimeState.adapterType} is distinct from ${agent.adapterType})`
    : undefined;
  const updated = await db
    .update(agentRuntimeState)
    .set({
      adapterType: agent.adapterType,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      lastRunId: run.id,
      lastRunStatus: run.status,
      lastError: run.error ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuntimeState.agentId, agent.id), notOlder))
    .returning({ agentId: agentRuntimeState.agentId });
  return updated.length > 0;
}
