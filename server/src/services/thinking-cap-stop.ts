import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { resolvePaperclipRunnerPiRpcThinkingLevel } from "@paperclipai/adapter-utils";
import { PI_RPC_BUILTIN_THINKING_CATALOG } from "../vendor/paperclip-runner/index.js";
import { isRecoveryRun } from "./continuation-cause.js";
import { NATIVE_MID_STREAM_CUT_CODE } from "./native-runtime/native-mid-stream-cut-cause.js";
import { parseIssueAssigneeAdapterOverrides, type ParsedIssueAssigneeAdapterOverrides } from "./execution-workspace-policy.js";
import {
  readThinkingOnlyCapStop,
  THINKING_CAP_STOP_AGAIN_NOTE,
  THINKING_CAP_STOP_NOTE,
  type CompletedFinalAgentMessageCandidate,
} from "./heartbeat-run-summary.js";

/**
 * The run events that decide how a run's last turn ended and whether it
 * streamed answer text: turn terminals and agent-message items. The same
 * selection the cut-answer readers use (dl-n5-cont).
 */
export function readRunAnswerEvents(tx: Pick<Db, "select">, companyId: string, runId: string) {
  return tx.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), or(
      inArray(heartbeatRunEvents.eventType, ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]),
      and(inArray(heartbeatRunEvents.eventType, ["item.delta", "item.completed"]),
        // dl-n5-cont5 (b): both agent-message spellings, as the readers accept.
        sql`${heartbeatRunEvents.payload} #>> '{prpEvent,payload,kind}' in ('agentMessage', 'assistant_message')`))))
    .orderBy(heartbeatRunEvents.seq);
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * dl-n5-cont2 item 3: a run whose last turn stopped at the output cap having
 * streamed no answer text (the model used its whole output budget thinking).
 *
 * `repeated` is the COST GUARD: the automatic successor budget is spent,
 * whether its parent capped or failed with another mid-stream cut. The lane's
 * durable marking is the same proof the finalizer uses to stop automatic
 * sends. The person gets one note with the choice to Retry. A
 * person's Retry (not a recovery run) starts a new ask with its own one
 * automatic continuation.
 */
export async function readThinkingCapStop(tx: Pick<Db, "select">, input: { companyId: string; runId: string }): Promise<{
  seq: number;
  sourceEventId: string | null;
  repeated: boolean;
} | null> {
  const stop = readThinkingOnlyCapStop(await readRunAnswerEvents(tx, input.companyId, input.runId));
  if (!stop) return null;
  const recovery = await readRecoveryRunParent(tx, input);
  const repeated = Boolean(recovery && (recovery.automaticCutSuccessor
    || readThinkingOnlyCapStop(await readRunAnswerEvents(tx, input.companyId, recovery.parentRunId))));
  return { ...stop, repeated };
}

/** The run's reply for a thinking-only cap stop: ONE true note (with Retry when the continuation stopped too). */
export function thinkingCapStopCandidate(stop: { seq: number; sourceEventId: string | null; repeated: boolean }):
  CompletedFinalAgentMessageCandidate & { reasonCode: string } {
  return {
    seq: stop.seq,
    text: stop.repeated ? THINKING_CAP_STOP_AGAIN_NOTE : THINKING_CAP_STOP_NOTE,
    sourceEventId: stop.sourceEventId,
    channel: "final",
    reasonCode: stop.repeated ? "thinking_only_output_cap_stop_repeated" : "thinking_only_output_cap_stop",
  };
}

/**
 * The run this run automatically continues (retryOfRunId, else the context's
 * previousRunId), and whether it spent the cut lane's one-successor budget.
 * Null for a person's ask or Retry, even when it carries a previousRunId.
 */
async function readRecoveryRunParent(tx: Pick<Db, "select">, input: { companyId: string; runId: string }): Promise<{
  parentRunId: string; automaticCutSuccessor: boolean;
} | null> {
  const [run] = await tx.select({ retryOfRunId: heartbeatRuns.retryOfRunId, scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  const context = object(run?.contextSnapshot);
  const parentRunId = run?.retryOfRunId
    ?? (typeof context.previousRunId === "string" && context.previousRunId ? context.previousRunId : null);
  return run && parentRunId && parentRunId !== input.runId && isRecoveryRun(run)
    ? { parentRunId, automaticCutSuccessor: Boolean(run.retryOfRunId) && run.scheduledRetryReason === NATIVE_MID_STREAM_CUT_CODE }
    : null;
}

/**
 * dl-n5-cont3: the thinking level of the ONE automatic recovery run after a
 * thinking-only output-cap stop (capacity-lead's probe on the 50 KiB ask:
 * xhigh spent 128k on thinking with no text; high wrote the whole answer at
 * 78k tokens). It is a run-level override: the agent's stored level is not
 * changed, and the next normal run uses it again.
 */
export const THINKING_CAP_STOP_RECOVERY_LEVEL = "high" as const;
const LEVELS_ABOVE_RECOVERY = new Set(["xhigh", "max"]);

/**
 * dl-n5-cont3: this run is the automatic recovery run of a thinking-only
 * output-cap stop that starts a new process on the SAME conversation; the cut
 * turn is not sent (`forceFreshSession` is the internal flag). A retry in the
 * live process is not: pi_rpc refuses a per-turn level change there
 * (pi-rpc-driver.ts :954-955).
 */
export async function isThinkingCapStopRecoveryRun(tx: Pick<Db, "select">, input: { companyId: string; runId: string }): Promise<boolean> {
  const [run] = await tx.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  if (object(run?.contextSnapshot).forceFreshSession !== true) return false;
  const recovery = await readRecoveryRunParent(tx, input);
  return Boolean(recovery && readThinkingOnlyCapStop(await readRunAnswerEvents(tx, input.companyId, recovery.parentRunId)));
}

/**
 * dl-n5-cont3: the run's adapter overrides with the recovery thinking level,
 * through the existing task-override path (projectPaperclipRunnerTaskConfig
 * -> the native input's piRpcThinkingLevel). A new process on the SAME
 * conversation admits it; the cut turn is not sent.
 * Only a pi_rpc agent whose effective level is above it is lowered; nothing
 * is raised. Returns the overrides unchanged otherwise.
 */
export function withThinkingCapStopRecoveryLevel(
  overrides: ParsedIssueAssigneeAdapterOverrides | null, agentAdapterConfig: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const agentConfig = object(agentAdapterConfig);
  if (agentConfig.provider !== "pi_rpc") return overrides;
  const taskConfig = object(overrides?.adapterConfig);
  const merged = { ...agentConfig, ...taskConfig };
  let effective: string | undefined;
  try {
    effective = resolvePaperclipRunnerPiRpcThinkingLevel("pi_rpc", merged.piRpcThinkingLevel, merged.model,
      merged.thinkingLevelMap, PI_RPC_BUILTIN_THINKING_CATALOG);
  } catch { return overrides; }
  if (!effective || !LEVELS_ABOVE_RECOVERY.has(effective)) return overrides;
  return { useProjectWorkspace: overrides?.useProjectWorkspace ?? null,
    adapterConfig: { ...taskConfig, piRpcThinkingLevel: THINKING_CAP_STOP_RECOVERY_LEVEL } };
}

/**
 * dl-n5-cont3: the run's task overrides as heartbeat applies them: the task's
 * assignee overrides (when this agent is the assignee), plus the recovery
 * thinking level on the one automatic recovery run of a thinking-only cap stop.
 */
export async function resolveRunAssigneeAdapterOverrides(tx: Pick<Db, "select">, input: {
  companyId: string; runId: string; agent: { id: string; adapterConfig: unknown };
  issueContext: { assigneeAgentId?: string | null; assigneeAdapterOverrides?: unknown } | null | undefined;
}): Promise<ParsedIssueAssigneeAdapterOverrides | null> {
  const overrides = input.issueContext && input.issueContext.assigneeAgentId === input.agent.id
    ? parseIssueAssigneeAdapterOverrides(input.issueContext.assigneeAdapterOverrides) : null;
  return await isThinkingCapStopRecoveryRun(tx, { companyId: input.companyId, runId: input.runId })
    ? withThinkingCapStopRecoveryLevel(overrides, input.agent.adapterConfig) : overrides;
}
