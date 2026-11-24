import { expect, it } from "vitest";
import { shouldResetTaskSessionForWake } from "../heartbeat/run-state.js";
import { decideNativeContinuation } from "./continued-session.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
it("honors explicit fresh-session resets under continuous", () => {
  const context = { forceFreshSession: true, explicitFreshSession: true };
  expect(decideNativeContinuation({ provider: "pi_rpc", sessionContinuity: "continuous", hasSession: true, wakeReset: shouldResetTaskSessionForWake(context), resetRequired: context.explicitFreshSession === true }).continue).toBe(false);
});
it("retains recovery history, sends exact comments, and preserves other unseen events", () => {
  const task = { id: "issue", identifier: "CHAT-1", title: "Brief", description: null, workMode: "standard", conversationAgentId: "agent" };
  const messages = [{ id: "comment", body: "  Next prompt\n", authorType: "user", authorId: "board" }];
  const wakePayload = { reason: "issue_commented", commentIds: ["comment"], comments: [], executionContinuation: { version: 1, messages, resumeDelta: { baseRunId: "prior", messages } } };
  const args: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD_BRIEF", provider: "pi_rpc", normalizedSessionId: "session", resumedSession: true, previousTurn: { runId: "prior", task },
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(), wakePayload,
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Reply", criteria: [{ id: "reply", requirement: "Reply" }] } },
  };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, wakeReset: shouldResetTaskSessionForWake({ forceFreshSession: true }) }).continue).toBe(true);
  for (const conversationMode of [false, true]) expect(buildNativeExecutionInput({ ...args, conversationMode }).continuationPrompt).toBe(messages[0].body);
  const mixed = { ...wakePayload, executionContinuation: { ...wakePayload.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [...messages, { ...messages[0], id: "other", body: "Unseen event" }] } } };
  expect(JSON.parse(buildNativeExecutionInput({ ...args, wakePayload: mixed }).continuationPrompt!).messages).toHaveLength(2);
  expect(buildNativeExecutionInput({ ...args, sessionContinuity: "paperclip" }).continuationPrompt).toBe(JSON.stringify({ messages }));
});
