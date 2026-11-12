import { describe, expect, it } from "vitest";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, nativeSessionKey } from "./native-session-executor.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000002";
const issueId = "30000000-0000-4000-8000-000000000003";
const firstRun = "40000000-0000-4000-8000-000000000004";
const nextRun = "50000000-0000-4000-8000-000000000005";
const sessionId = "60000000-0000-4000-8000-000000000006";
function execution(runId: string, id = sessionId) {
  return buildNativeExecutionInput({ companyId, agentId, runId,
    issue: { id: issueId, identifier: null, title: "Daily conversation", description: null, workMode: "standard" },
    taskPrompt: "Current message", workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: id, provider: "pi_rpc", model: "provider/model-a",
    completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}
function prior(previous = execution(firstRun)) {
  return { id: firstRun, companyId, agentId, nativeSessionId: sessionId, runnerProfileJson: {
    nativeExecutionInput: previous, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", "pi_rpc"),
    sessionCheckpoint: { backendKind: "runner", driverKind: "pi_rpc", sessionId: "pi-facade", providerSessionId: "pi-header",
      identity: { runId: firstRun, sessionId, companyId, issueId, agentId }, cursor: "42", semanticResult: null,
      terminal: null, activeTurnId: null, terminalTurns: [], pendingRuntimeRequests: [] },
  } };
}

describe("Pi conversation identity is not a checkpoint/config generation (data safety, #20303)", () => {
  it("does not remint on first admission without a checkpoint", () => {
    const result = buildNativeExecutionWithCheckpoint({ previousRun: null, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId }) => execution(nextRun, normalizedSessionId) });
    expect(result.normalizedSessionId).toBe(sessionId);
    expect(result.execution.session.normalizedSessionId).toBe(sessionId);
  });
  it("keeps the record id when no reusable checkpoint exists", () => {
    const result = buildNativeExecutionWithCheckpoint({ previousRun: { ...prior(), runnerProfileJson: {} }, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId }) => execution(nextRun, normalizedSessionId) });
    expect(result.normalizedSessionId).toBe(sessionId);
    expect(result.checkpoint).toBeNull();
  });
  it("fails closed at the executor mint site instead of using session-${runId}", () => {
    const current = execution(nextRun);
    current.session.normalizedSessionId = undefined as unknown as string;
    expect(() => nativeSessionKey(current)).toThrow("pi_conversation_identity_missing");
  });
});
