import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentTaskSessions, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { classifyRetryConsequence, type RetryConsequence, type RetrySelectorFacts } from "./native-runtime/continued-session.js";
import { isChatTask } from "./fresh-continuation-retry-fold.js";
import { proveRunProcessGone } from "./run-process-owner.js";
import { conflict } from "../errors.js";
export { agentRetryStartsNewSession, classifyRetryConsequence, type RetryConsequence, type RetrySelectorFacts } from "./native-runtime/continued-session.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const retryRunFields = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
  errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error, resultJson: heartbeatRuns.resultJson,
  contextSnapshot: sql<Record<string, unknown> | null>`jsonb_build_object('taskKey', ${heartbeatRuns.contextSnapshot}->'taskKey', 'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
  processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt, processHostHash: heartbeatRuns.processHostHash,
  responsibleUserId: heartbeatRuns.responsibleUserId,
};
type RetryRun = Pick<typeof heartbeatRuns.$inferSelect, keyof typeof retryRunFields>;

/** A cheap read-only offer, NOT a second dispatch selector. Do not reconstruct
 * fingerprints from dummy inputs, allocate router accounts or inspect secrets.
 * Actual reset/identity decisions and checkpoint rebinds compare the carried
 * expectation at their owning forks before persisting/starting a session. */
export async function readRetrySelectorFacts(db: Db, companyId: string, runId: string, selectedRun?: RetryRun): Promise<RetrySelectorFacts | null> {
  const run = selectedRun ?? (await db.select(retryRunFields).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))))[0];
  if (!run || run.companyId !== companyId || run.id !== runId) return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
  if (!agent) return null;
  const context = record(run.contextSnapshot);
  const issueId = [run.nativeIssueId, run.issueId, context.issueId].find((value): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) ?? null;
  const [issue] = issueId ? await db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeAdapterOverrides: issues.assigneeAdapterOverrides }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))) : [];
  const overrides = issue?.assigneeAgentId === agent.id ? record(record(issue.assigneeAdapterOverrides).adapterConfig) : {};
  const config = { ...record(agent.adapterConfig), ...overrides };
  const [hold] = issueId ? await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`)).limit(1) : [];
  const requiresIsolatedWorkspace = Boolean(hold && ((await proveRunProcessGone(run, "retry_consequence"))?.verdict !== "gone" ||
    await (await import("./execution-blocker.js")).hasPendingRunCleanup(db, companyId, run.id)));
  const { deriveTaskKey } = await import("./heartbeat/run-preparation.js");
  const taskKey = deriveTaskKey(context, null) ?? issueId;
  const sessions = taskKey ? await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
    eq(agentTaskSessions.agentId, agent.id), eq(agentTaskSessions.taskKey, taskKey))) : [];
  // A configuration edit must not hide the old authority by changing adapterType.
  const taskSession = sessions.find(value => value.adapterType === agent.adapterType) ?? sessions.find(value => record(value.sessionParamsJson).paperclipSavedSessionReset === true);
  const params = record(taskSession?.sessionParamsJson);
  // Checkpoint presence alone says nothing about actual rebinding (or whether
  // legacy dispatch even requires a native checkpoint). Do not guess that here.
  // The selected execution checks its real rebind below the dispatch boundary.
  return { adapterType: agent.adapterType, config, chat: issueId ? await isChatTask(db, companyId, issueId) : false, run,
    requiresIsolatedWorkspace,
    hardResetCategories: params.paperclipSavedSessionReset === true ? ["agent execution configuration changed"] : [] };
}
export async function readRetryConsequence(db: Db, companyId: string, runId: string): Promise<RetryConsequence> {
  const facts = await readRetrySelectorFacts(db, companyId, runId);
  return facts ? classifyRetryConsequence(facts) : { retryStartsNewSession: false };
}
/** Newly introduced refusal choices were never drawn by old clients. */
export function retryChoiceAllowsFresh(retry: RetryConsequence, expected: boolean | undefined) {
  const newlyDisclosed = retry.retryReasonCode && ["saved_session_unavailable", "side_effect_pending", "configuration_reset", "credential_changed"].includes(retry.retryReasonCode);
  return retry.retryStartsNewSession && (!newlyDisclosed || expected === true);
}
export async function assertRetryExpectation(db: Db, companyId: string, runId: string, expected: boolean | undefined) {
  const retry = await readRetryConsequence(db, companyId, runId);
  if (expected !== undefined && expected !== retry.retryStartsNewSession) throw conflict("retry_expectation_changed", { retry });
  return retry;
}
export async function withRetryConsequence<T extends { id: string }>(db: Db, companyId: string, run: T): Promise<T & RetryConsequence> {
  return { ...run, ...await readRetryConsequence(db, companyId, run.id) };
}
export const retryStartsNewSessionColumn = sql<boolean>`false`;
