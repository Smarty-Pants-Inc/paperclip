import { vi } from 'vitest';
import type { Db } from '@paperclipai/db';
import { createHeartbeatRunState } from '../heartbeat/run-state.js';
import { createHeartbeatLifecycle } from '../heartbeat/run-lifecycle.js';
import { createHeartbeatRunPreparation } from '../heartbeat/run-preparation.js';
// Same local service boundary as the established run-completion PG rows.
// Provider execution, output storage and UI delivery are test ports, not live credentials.
export function callbacks(db: Db): any {
 const state = createHeartbeatRunState(db);
 const lifecycle = createHeartbeatLifecycle(db, {
  ...state, ...createHeartbeatRunPreparation(db),
  issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
  recovery: { escalateStrandedAssignedIssue: vi.fn() }, companySkills: { completeTestRunForIssue: vi.fn() },
  budgets: { getInvocationBlock: vi.fn(async()=>null) }, treeControlSvc: { getActivePauseHoldGate: vi.fn(async()=>null) },
  enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async()=>({enabled:false})),
  getAgentInvokability: vi.fn(async()=>({invokable:true})), emitTerminalAgentTaskRun: vi.fn(), budgetHooks:{},
 } as never);
 return {
  ...state,...lifecycle,
  classifyAndPersistRunLiveness:vi.fn(async(run:unknown)=>run),
  completeSkillTestRunForHeartbeatOutcome:vi.fn(async()=>null),
  refreshContinuationSummaryForRun:vi.fn(async()=>null),findRunIssueComment:vi.fn(async()=>null),
  findLatestCompletedFinalAgentMessage:vi.fn(async()=>null),
  finalizeIssueCommentPolicy:vi.fn(async()=>({outcome:'not_applicable',queuedRun:null})),
  handleIssueReviewPathDisposition:vi.fn(async()=>undefined),handleRunLivenessContinuation:vi.fn(),
  handleSuccessfulRunHandoff:vi.fn(),updateRuntimeState:vi.fn(),scheduleBoundedRetryForRun:vi.fn(),
  scheduleInteractionContinuationInfrastructureRetryIfEligible:vi.fn(async()=>null),timerClaimWasFirstHeartbeat:vi.fn(),
  releaseIssueExecutionAndPromote:vi.fn(async()=>undefined),finalizeAgentStatus:vi.fn(async()=>undefined),
  enqueueWakeup:vi.fn(),issuesSvc:{addComment:vi.fn()},
  recovery:{reconcileLegacyContinuation:vi.fn(),reconcileResolvedDependencyWakeBackstop:vi.fn()},
  getCurrentUserRedactionOptions:vi.fn(async()=>({enabled:false})),budgetHooks:{},
  runLogStore:{finalize:vi.fn(async()=>({bytes:0,sha256:'log-hash',compressed:false}))},traceStore:{finalize:vi.fn()},
  processRunCancellationSettlements:new Map(),failedProcessRunCancellations:new Map(),
 };
}
