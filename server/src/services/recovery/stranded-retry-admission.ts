import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { canRetryStoppedRun } from "../cancelled-native-startup.js";
import { heldRetryOffersRetry, heldTaskRetryRefusals } from "../task-retry-eligibility.js";
import { hasVerifiedWorkspaceRepair } from "../workspace-recovery-receipt.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";
import type { StrandedRetryAdmission } from "./stranded-notice.js";

/**
 * Whether the Retry a stranded notice would point to (`POST /issues/:id/retry`)
 * can start the task now. It reads the same predicates Retry's admission and
 * dispatch use: the persisted dispatch refusal (`heldRetryOffersRetry`), the
 * stopped-run eligibility (`canRetryStoppedRun`) and the required workspace
 * repair (`hasRequiredWorkspaceRecovery` + `hasVerifiedWorkspaceRepair`), plus
 * the assignee's pause, which holds every start.
 */
export async function decideStrandedRetryAdmission(db: Db, input: {
  companyId: string;
  issueId: string;
  runId: string | null | undefined;
}): Promise<StrandedRetryAdmission> {
  const [run] = input.runId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1) : [];
  if (!run) return { admits: false, refusal: "none" };
  const [agent] = await db.select({ name: agents.name, status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, run.agentId))).limit(1);
  if (agent?.status === "paused") return { admits: false, refusal: "agent_paused", agentName: agent.name };
  if (hasRequiredWorkspaceRecovery(run.resultJson) && !await hasVerifiedWorkspaceRepair(db, run))
    return { admits: false, refusal: "workspace_repair_required" };
  const held = (await heldTaskRetryRefusals(db, input.companyId, [input.issueId])).get(input.issueId);
  // Swap point: code-lead's `decideRetryAuthority` (task-retry-eligibility.ts)
  // replaces this one predicate call when that line lands.
  const offered = heldRetryOffersRetry(held);
  if (!offered) return held === "previous_execution_unverified" || held === "workspace_owner_stop_required"
    ? { admits: false, refusal: "previous_execution_unverified" } : { admits: false, refusal: "none" };
  if (!await canRetryStoppedRun(db, run)) return { admits: false, refusal: "previous_execution_unverified" };
  return { admits: true };
}
