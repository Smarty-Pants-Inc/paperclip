import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export type RuntimePreparationPhase = "workspace_prep" | "instruction_prep" | "selection_txn";

/** This is progress, not a runtime choice. The resolution timestamp stays NULL.
 * Persist the boundary so cancellation or a different recovery owner can name
 * the phase even if the preparing controller or its request connection dies. */
export async function recordRuntimePreparationPhase(db: Db, runId: string, phase: RuntimePreparationPhase): Promise<void> {
  await db.update(heartbeatRuns).set({ runtimeModeReason: `not_selected_preparing:${phase}` })
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.runtimeMode, "legacy"), isNull(heartbeatRuns.runtimeModeResolvedAt)));
}

/** Evaluate under the terminal writer's row lock/UPDATE, not from a stale run
 * snapshot: a concurrent committed native/direct selection always wins. */
export function runtimeModeReasonForTerminalSql() {
  return sql<string | null>`case
    when ${heartbeatRuns.runtimeModeResolvedAt} is null and ${heartbeatRuns.runtimeMode} = 'legacy' then
      case ${heartbeatRuns.runtimeModeReason}
        when 'not_selected_preparing:instruction_prep' then 'not_selected_run_ended_before_selection:instruction_prep'
        when 'not_selected_preparing:selection_txn' then 'not_selected_run_ended_before_selection:selection_txn'
        when 'not_selected_run_ended_before_selection:instruction_prep' then 'not_selected_run_ended_before_selection:instruction_prep'
        when 'not_selected_run_ended_before_selection:selection_txn' then 'not_selected_run_ended_before_selection:selection_txn'
        else 'not_selected_run_ended_before_selection:workspace_prep'
      end
    else ${heartbeatRuns.runtimeModeReason} end`;
}
