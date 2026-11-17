// RFL SIZE RULE: explicit task-authorized real-Postgres regression, not a helper mock test.
// Reuses rf2-n5-cont3 judge-probes' real lifecycle + completion publication boundary.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, heartbeatRunEvents, issueComments, issues, authUsers, activityLog } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { issueService } from "../../services/issues.js";
import { resolveHeartbeatRunResponse, splitFinalAnswerComments, TRUNCATED_FINAL_UNDELIVERABLE_TEXT } from "../../services/heartbeat-run-summary.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../../services/heartbeat-run-status-payload.js";
import * as usageReceipts from "../../services/usage-receipts.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunPreparation } from "../../services/heartbeat/run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "../../services/heartbeat/run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "../../services/heartbeat/workspaces.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "../../services/heartbeat/run-completion.js";
import { createPiEventProjector, type PiProjectedEvent } from "../../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.js";


type Dependencies = HeartbeatRunCompletionDependencies;
export function callbacks(db: Db, realPresentation = false) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn<HeartbeatLifecycleDependencies["getCurrentUserRedactionOptions"]>(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(realPresentation ? lifecycle.findRunIssueComment : async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(realPresentation ? lifecycle.findLatestCompletedFinalAgentMessage : async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}


