import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

const ENV = "PAPERCLIP_DEFAULT_MAX_REVIEW_ROUNDS";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const executorId = "11111111-1111-4111-8111-111111111111";
const responsibleUserId = "board-user";

function requestChanges(priorCount: number, maxReviewRounds?: number) {
  const policy = normalizeIssueExecutionPolicy({
    stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    ...(maxReviewRounds === undefined ? {} : { maxReviewRounds }),
  })!;
  return applyIssueExecutionPolicyTransition({
    issue: {
      status: "in_review",
      assigneeAgentId: reviewerId,
      responsibleUserId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: executorId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: priorCount,
      },
    },
    policy,
    requestedStatus: "in_progress",
    requestedAssigneePatch: {},
    actor: { agentId: reviewerId },
    commentBody: "Please address this review feedback",
  });
}

// Keep: review escalation/data-safety boundary; exercises the real transition,
// not a copy of the resolver or a source-text assertion.
describe("PAPERCLIP_DEFAULT_MAX_REVIEW_ROUNDS configuration", () => {
  beforeEach(() => vi.stubEnv(ENV, undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the default of three when absent", () => {
    expect(() => loadConfig(null)).not.toThrow();
    expect(requestChanges(1).patch.assigneeAgentId).toBe(executorId);
    expect(requestChanges(2).patch.assigneeUserId).toBe(responsibleUserId);
  });

  it.each([" 10 ", "0010", "1000"])("raises the effective default with %j even beyond the issue field maximum", (raw) => {
    vi.stubEnv(ENV, raw);
    expect(() => loadConfig(null)).not.toThrow();
    const limit = Number(raw);
    expect(requestChanges(2).patch).toMatchObject({ status: "in_progress", assigneeAgentId: executorId });
    expect(requestChanges(limit - 2).patch.assigneeAgentId).toBe(executorId);
    expect(requestChanges(limit - 1).patch).toMatchObject({ status: "in_review", assigneeUserId: responsibleUserId });
  });

  it("preserves an issue's own value ahead of the environment default", () => {
    vi.stubEnv(ENV, "1000");
    expect(requestChanges(0, 1).patch.assigneeUserId).toBe(responsibleUserId);
    vi.stubEnv(ENV, "1");
    expect(requestChanges(0, 50).patch.assigneeAgentId).toBe(executorId);
  });

  it("keeps the issue field validator maximum at 50", () => {
    vi.stubEnv(ENV, "1000");
    expect(() => requestChanges(0, 51)).toThrow("Invalid execution policy");
    expect(requestChanges(49, 50).patch.assigneeUserId).toBe(responsibleUserId);
  });

  it.each(["1O00", "-1", "not-a-number", "0", "1.5", "9007199254740992", "", " ", "1000junk", "1e3"])(
    "refuses startup for explicit malformed value %j, naming the exact knob",
    (raw) => {
      vi.stubEnv(ENV, raw);
      expect(() => loadConfig(null)).toThrow(`Invalid ${ENV}: expected a positive safe integer.`);
    },
  );

  it.each(["1O00", "-1", "not-a-number", "0", "1.5", "9007199254740992", "", " ", "1000junk", "1e3"])(
    "does not silently restore three on a lazy transition with malformed value %j",
    (raw) => {
      vi.stubEnv(ENV, raw);
      expect(() => requestChanges(0)).toThrow(`Invalid ${ENV}: expected a positive safe integer.`);
    },
  );
});
