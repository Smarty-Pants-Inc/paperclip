import { expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildPaperclipWakePayload } from "../heartbeat/run-preparation.js";
import { shouldResetTaskSessionForWake } from "../heartbeat/run-state.js";
import { decideNativeContinuation, isWarmRecoveryRefusal, NATIVE_FRESH_SESSION_MARKER, sessionCannotContinue, withPiOpenTurnDefault } from "./continued-session.js";
import { configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
it("projects the continuous Pi open-turn default while preserving configured overrides and stock modes", () => {
  const project = (provider: unknown, setting: unknown, environment: NodeJS.ProcessEnv = {}) =>
    configuredEnvironmentProjection(withPiOpenTurnDefault(provider, setting, environment));
  for (const setting of [undefined, "continuous"]) {
    const projected = project("pi_rpc", setting, { CUSTOM_VALUE: "kept" });
    expect(projected.PAPERCLIP_PI_OPEN_TURN_MS).toBe("600000");
    expect(projected.CUSTOM_VALUE).toBe("kept");
    expect(JSON.parse(projected.PAPERCLIP_CONFIGURED_ENV_KEYS!)).toContain("PAPERCLIP_PI_OPEN_TURN_MS");
    expect(project("pi_rpc", setting, { PAPERCLIP_PI_OPEN_TURN_MS: "0" }).PAPERCLIP_PI_OPEN_TURN_MS).toBe("0");
  }
  const configured = { CUSTOM_VALUE: "kept" };
  expect(project("pi_rpc", "paperclip", configured)).toEqual(configuredEnvironmentProjection(configured));
  expect(project("pi_rpc", "paperclip", configured)).not.toHaveProperty("PAPERCLIP_PI_OPEN_TURN_MS");
  for (const provider of ["codex", "acpx", "openai_dot"]) {
    expect(project(provider, "continuous", configured)).toEqual(configuredEnvironmentProjection(configured));
  }
  expect(configured).toEqual({ CUSTOM_VALUE: "kept" });
});

it("recognizes only an unrecoverable session's code or retained-binding refusal", () => {
  expect(sessionCannotContinue({ errorCode: "native_provider_state_incompatible" })).toBe(true);
  expect(sessionCannotContinue({ error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" })).toBe(true);
  expect(sessionCannotContinue({ error: "native_session_interrupted: x; exact checkpoint resume refused: native_controller_recovery_missing_evidence:retained_sandbox_binding",
    resultJson: { nativeExactResumeRefusal: { refusal: "native_controller_recovery_missing_evidence:retained_sandbox_binding" } } })).toBe(true);
  expect(sessionCannotContinue({ errorCode: "adapter_failed", error: "ordinary provider failure" })).toBe(false);
  expect(sessionCannotContinue({ errorCode: "adapter_failed", error: "expected native_controller_recovery_missing_evidence:retained_sandbox_binding" })).toBe(false);
});
// Pure classifier regression: current refusal precedence and exact tokens have no cheaper isolated proof.
it("classifies only the failed run's current warm-recovery refusal", () => {
  const run = { status: "failed", errorCode: "native_continuation_requires_reconciliation", error: "ordinary model/tool failure" };
  for (const error of [run.error, "expected remote_warm_session_not_idle in tool output", "remote_warm_session_not_idle_suffix",
    "native_continuation_requires_reconciliation", "expected native_controller_recovery_missing_evidence:retained_sandbox_binding"]) {
    expect(isWarmRecoveryRefusal({ ...run, error })).toBe(false);
  }
  expect(isWarmRecoveryRefusal({ ...run, error: null })).toBe(false);
  expect(isWarmRecoveryRefusal({ ...run, status: "succeeded", error: "remote_warm_session_not_idle" })).toBe(false);
  expect(isWarmRecoveryRefusal({ ...run, error: "remote_warm_session_not_idle", resultJson: {
    nativeExactResumeRefusal: { refusal: "ordinary current provider failure" },
  } })).toBe(false);
  expect(isWarmRecoveryRefusal({ ...run, error: "ordinary earlier provider failure; exact checkpoint resume refused: remote_warm_session_not_idle", resultJson: {
    nativeExactResumeRefusal: { refusal: "runner_state_identity_mismatch: remote_warm_session_not_idle" },
  } })).toBe(true);
  expect(isWarmRecoveryRefusal({ ...run, errorCode: "native_provider_state_incompatible" })).toBe(true);
  expect(isWarmRecoveryRefusal({ ...run, error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" })).toBe(true);
  expect(isWarmRecoveryRefusal(undefined)).toBe(false);
});
it("honors explicit fresh-session resets under continuous", () => {
  const context = { forceFreshSession: true, explicitFreshSession: true };
  expect(decideNativeContinuation({ provider: "pi_rpc", sessionContinuity: "continuous", hasSession: true, wakeReset: shouldResetTaskSessionForWake(context), resetRequired: context.explicitFreshSession === true }).continue).toBe(false);
});
it.each(["truncated", "fallbackFetchNeeded", "bodyTruncated"])("keeps stock framing for %s", (flag) => {
  const comment = { id: "comment", body: "Cut text", author: { type: "user", id: "board" } };
  const wakePayload = { reason: "issue_commented", commentIds: [comment.id], comments: [comment] };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, wakePayload }).promptOnly).toBe(true);
  const cutWake = flag === "bodyTruncated" ? { ...wakePayload, comments: [{ ...comment, bodyTruncated: true }] } : { ...wakePayload, [flag]: true };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, wakePayload: cutWake })).toEqual({ continue: true, promptOnly: false });
});
it.each([1, 9])("delivers %i whole 5,000-character comments on a continued session", async (count) => {
  const query = { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query, orderBy: () => query, limit: () => query, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
  const task = { id: "issue", identifier: "CHAT-1", title: "Brief", description: null, workMode: "standard", conversationAgentId: "agent" };
  const rows = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, companyId: "company", issueId: task.id, body: ` ${index}\n${"x".repeat(4995)}\n `, origin: "comment" as const,
    authorType: "user" as const, authorAgentId: null, authorUserId: "board", presentation: null, metadata: null, sourceTrust: null,
    deletedAt: null, deletedByType: null, deletedByAgentId: null, deletedByUserId: null, deletedByRunId: null, createdAt: new Date(0) }));
  for (const conversationMode of [false, true]) {
    const wakePayload = await buildPaperclipWakePayload({ db: { select: () => query } as unknown as Db, companyId: "company", retainFullCommentBodies: true, wakeCommentRows: rows,
      contextSnapshot: { issueId: task.id, wakeReason: "issue_commented", wakeCommentIds: rows.map(row => row.id), conversationMode }, issueSummary: { ...task, status: "in_progress", priority: "medium" } });
    expect(buildNativeExecutionInput({ companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD_BRIEF", provider: "pi_rpc", normalizedSessionId: "session", resumedSession: true,
      previousTurn: { runId: "prior", task }, workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(), wakePayload, conversationMode,
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Reply", criteria: [{ id: "reply", requirement: "Reply" }] } },
    }).continuationPrompt).toBe(rows.map(row => row.body).join("\n\n"));
  }
});
it("retains recovery history, sends exact comments, and preserves other unseen events", () => {
  const task = { id: "issue", identifier: "CHAT-1", title: "Brief", description: null, workMode: "standard", conversationAgentId: "agent" };
  const messages = [{ id: "comment", body: "  Next prompt\n", authorType: "user", authorId: "board" }];
  const wakePayload = { reason: "issue_commented", commentIds: ["comment"], comments: [], executionContinuation: { version: 1, messages,
    coverage: { kind: "full_task_history", throughCommentId: "comment", summaryThroughCommentId: null },
    resumeDelta: { baseRunId: "prior", messages } } };
  const args: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD_BRIEF", provider: "pi_rpc", normalizedSessionId: "session", resumedSession: true, previousTurn: { runId: "prior", task },
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(), wakePayload,
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Reply", criteria: [{ id: "reply", requirement: "Reply" }] } },
  };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, wakeReset: shouldResetTaskSessionForWake({ forceFreshSession: true }) }).continue).toBe(true);
  for (const conversationMode of [false, true]) expect(buildNativeExecutionInput({ ...args, conversationMode }).continuationPrompt).toBe(messages[0].body);
  expect(buildNativeExecutionInput({ ...args, previousTurn: { runId: "different", task } }).continuationPrompt).toBeNull();
  const mixed = { ...wakePayload, executionContinuation: { ...wakePayload.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [...messages, { ...messages[0], id: "other", body: "Unseen event" }] } } };
  expect(JSON.parse(buildNativeExecutionInput({ ...args, wakePayload: mixed }).continuationPrompt!).messages).toHaveLength(2);
  expect(buildNativeExecutionInput({ ...args, sessionContinuity: "paperclip" }).continuationPrompt).toBe(JSON.stringify({ messages }));
});
it("keeps a reopened task's next prompt bare when only the agent's own reply is new", () => {
  const wake = (authorId: string) => { const messages = [{ id: "r", body: "Reply", authorType: "agent", authorId }, { id: "c", body: "Next", authorType: "user", authorId: "board" }]; return { reason: "issue_reopened_via_comment", commentIds: ["c"], comments: [], executionContinuation: { version: 1, messages, resumeDelta: { baseRunId: "prior", messages } } }; };
  for (const [authorId, expected] of [["agent", true], ["other", false]] as const) expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: wake(authorId) }).promptOnly).toBe(expected);
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: { ...wake("agent"), reason: "issue_continuation_needed" } }).promptOnly).toBe(true);
  const withNote = (body: string, extra: Record<string, unknown> = { freshSessionMarker: true }) => { const w = wake("agent"); const note = { id: "n", body, authorType: "system", authorId: null, ...extra };
    return { ...w, executionContinuation: { ...w.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [note, ...w.executionContinuation.resumeDelta.messages] } } }; };
  for (const [body, expected] of [[NATIVE_FRESH_SESSION_MARKER, true], ["Saved work recovered.", false]] as const)
    expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: withNote(body) }).promptOnly).toBe(expected);
  // Only a session that is already loaded may skip the marker; a fresh turn always gets the history.
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: false, agentId: "agent", previousRunId: "prior", wakePayload: withNote(NATIVE_FRESH_SESSION_MARKER) }).promptOnly).toBe(false);
  // A person's comment with the same words is input, not the marker.
  const personSaid = withNote(NATIVE_FRESH_SESSION_MARKER);
  personSaid.executionContinuation.resumeDelta.messages[0] = { id: "n", body: NATIVE_FRESH_SESSION_MARKER, authorType: "user", authorId: "board" } as never;
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: personSaid }).promptOnly).toBe(false);
  // Same words without the server's marker provenance (an external or plug-in system comment), or with an author: input.
  for (const extra of [{}, { freshSessionMarker: true, authorId: "plugin" }])
    expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: withNote(NATIVE_FRESH_SESSION_MARKER, extra) }).promptOnly).toBe(false);
});
