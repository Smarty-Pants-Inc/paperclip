import { expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildPaperclipWakePayload } from "../heartbeat/run-preparation.js";
import { shouldResetTaskSessionForWake } from "../heartbeat/run-state.js";
import { decideNativeContinuation, NATIVE_FRESH_SESSION_MARKER, sessionCannotContinue, withPiOpenTurnDefault } from "./continued-session.js";
import { configuredEnvironmentProjection } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionInput as buildExecution } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import type { NativeTaskSnapshot } from "./native-continuation.js";
// These retained-session fixtures represent new turns with complete saved task context.
const snapshot = (task: { title: string; description: string | null; workMode?: string }): NativeTaskSnapshot => ({
  identifier: "TASK-1", title: task.title, description: task.description, workMode: task.workMode ?? "standard",
  status: "todo", priority: "medium", assigneeAgentId: "agent", assigneeUserId: null,
  parentId: null, projectId: null, goalId: null, conversationAgentId: null, reviewPolicy: null,
  responsibleUserId: null, billingCode: null, titleNeedsGeneration: false, executionPolicy: null,
});
function buildNativeExecutionInput(input: Parameters<typeof buildExecution>[0]) {
  return buildExecution({ ...input, taskSnapshot: snapshot(input.issue), previousTurn: input.previousTurn
    ? { ...input.previousTurn, status: "succeeded", acceptedResultId: "accepted-prior-result", wakePayload: input.wakePayload, taskSnapshot: snapshot(input.previousTurn.task) } : input.previousTurn });
}
const promptText = (reason: string, body: string) => `Wake reason: ${reason}\n\nstatus: todo; assigneeAgentId: agent; assigneeUserId: null; priority: medium\n\n${body}`;
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
it.each([1, 9])("keeps the full path for %i truncated 5,000-character comments, even with retained full bodies", async (count) => {
  const query = { from: () => query, innerJoin: () => query, leftJoin: () => query, where: () => query, orderBy: () => query, limit: () => query, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
  const task = { id: "issue", identifier: "CHAT-1", title: "Brief", description: null, workMode: "standard", conversationAgentId: "agent" };
  const rows = Array.from({ length: count }, (_, index) => ({ id: `c${index}`, companyId: "company", issueId: task.id, body: ` ${index}\n${"x".repeat(4995)}\n `, origin: "comment" as const,
    authorType: "user" as const, authorAgentId: null, authorUserId: "board", presentation: null, metadata: null, sourceTrust: null,
    deletedAt: null, deletedByType: null, deletedByAgentId: null, deletedByUserId: null, deletedByRunId: null, createdAt: new Date(0) }));
  for (const conversationMode of [false, true]) {
    const wakePayload = await buildPaperclipWakePayload({ db: { select: () => query } as unknown as Db, companyId: "company", retainFullCommentBodies: true, wakeCommentRows: rows,
      contextSnapshot: { issueId: task.id, wakeReason: "issue_commented", wakeCommentIds: rows.map(row => row.id), conversationMode,
        reviewDecision: "changes_requested", notificationReason: "review", retryCause: "provider_busy", retrySummary: "Retry unfinished work",
        unblockAction: "resume", monitor: { state: "needs_attention" },
      }, issueSummary: { ...task, status: "in_progress", priority: "medium" } });
    expect(wakePayload).toMatchObject({ reviewDecision: "changes_requested", notificationReason: "review", retryCause: "provider_busy",
      retrySummary: "Retry unfinished work", unblockAction: "resume", monitor: { state: "needs_attention" } });
    const result = buildNativeExecutionInput({ companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD_BRIEF", provider: "pi_rpc", normalizedSessionId: "session", resumedSession: true,
      previousTurn: { runId: "prior", task }, workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(), wakePayload, conversationMode,
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Reply", criteria: [{ id: "reply", requirement: "Reply" }] } },
    });
    expect(result.continuationPrompt).toBeNull();
    expect(result.task.prompt).toContain("OLD_BRIEF");
    expect(wakePayload!.comments.map(comment => comment.fullBody)).toEqual(rows.map(row => row.body));
  }
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
  for (const conversationMode of [false, true]) expect(buildNativeExecutionInput({ ...args, conversationMode }).continuationPrompt).toBe(promptText("issue_commented", messages[0].body));
  expect(buildNativeExecutionInput({ ...args, previousTurn: { runId: "different", task } }).continuationPrompt).toBeNull();
  const mixed = { ...wakePayload, executionContinuation: { ...wakePayload.executionContinuation, resumeDelta: { baseRunId: "prior", messages: [...messages, { ...messages[0], id: "other", body: "Unseen event" }] } } };
  expect(JSON.parse(buildNativeExecutionInput({ ...args, wakePayload: mixed }).continuationPrompt!.split("\n\n").at(-1)!).messages).toHaveLength(2);
  expect(buildNativeExecutionInput({ ...args, sessionContinuity: "paperclip" }).continuationPrompt).toBe(JSON.stringify({ messages }));
});
it.each(["issue_status_changed", "issue_continuation_needed", "issue_commented"])("sends only the new prompt for a retained Pi session woken by %s", reason => {
  const task = { id: "issue", identifier: "TASK-1", title: "Original task", description: null, workMode: "standard" };
  const messages = [{ id: "new", body: "New direction", authorType: "user", authorId: "board" }];
  const wakePayload = { reason, commentIds: ["new"], comments: [], executionContinuation: {
    version: 1, messages: [{ id: "old", body: "OLD HISTORY", authorType: "user" }, ...messages], resumeDelta: { baseRunId: "prior", messages },
  } };
  const input: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD BRIEF", provider: "pi_rpc",
    normalizedSessionId: "session", resumedSession: true, previousTurn: { runId: "prior", task }, wakePayload,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
      revision: "1", objective: "Continue", criteria: [{ id: "reply", requirement: "Reply" }],
    } },
  };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, previousRunId: "prior", wakePayload }).promptOnly).toBe(true);
  expect(buildNativeExecutionInput(input).continuationPrompt).toBe(promptText(reason, "New direction"));
  const statusMessage = { id: "status", body: "Status changed to in progress", authorType: "system" };
  const statusWake = { ...wakePayload, commentIds: [], executionContinuation: { ...wakePayload.executionContinuation,
    resumeDelta: { baseRunId: "prior", messages: [statusMessage] } } };
  expect(buildNativeExecutionInput({ ...input, wakePayload: statusWake }).continuationPrompt).toBe(promptText(reason, JSON.stringify({ messages: [statusMessage] })));
  if (reason !== "issue_commented") expect(buildNativeExecutionInput({ ...input, wakePayload: { ...statusWake,
    attachmentOmissions: [{ commentId: "status", notice: "Unavailable file" }],
  } }).continuationPrompt).toBeNull();
  expect(decideNativeContinuation({ provider: "codex", sessionContinuity: "continuous", hasSession: true, previousRunId: "prior", wakePayload }).promptOnly).toBe(false);
  expect(buildNativeExecutionInput({ ...input, resumedSession: false }).continuationPrompt).toBeUndefined();
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, resetRequired: true, previousRunId: "prior", wakePayload }).promptOnly).toBe(false);
});
it.each(["issue_continuation_needed", "issue_status_changed"])("does not replay history for an empty retained Pi delta on %s", reason => {
  const task = { id: "issue", identifier: "TASK-1", title: "Original task", description: null, workMode: "standard" };
  const wakePayload = { reason, executionContinuation: { version: 1,
    messages: [{ id: "old", body: "OLD ASK DO NOT REPEAT", authorType: "user" }], resumeDelta: { baseRunId: "prior", messages: [] },
  } };
  const input: Parameters<typeof buildNativeExecutionInput>[0] = {
    companyId: "company", runId: "next", agentId: "agent", issue: task, taskPrompt: "OLD BRIEF", provider: "pi_rpc",
    normalizedSessionId: "session", resumedSession: true, previousTurn: { runId: "prior", task }, wakePayload,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
      revision: "1", objective: "Continue", criteria: [{ id: "reply", requirement: "Reply" }],
    } },
  };
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, previousRunId: "prior", wakePayload }).promptOnly).toBe(true);
  expect(buildNativeExecutionInput(input).continuationPrompt).toBe(promptText(reason, "no new messages"));
  const staleCommentWake = { ...wakePayload, commentIds: ["old"], comments: [{ id: "old", body: "OLD ASK DO NOT REPEAT", fullBody: "OLD ASK DO NOT REPEAT", author: { type: "user" } }] };
  expect(buildNativeExecutionInput({ ...input, wakePayload: staleCommentWake }).continuationPrompt).toBe(promptText(reason, "no new messages"));
  expect(buildNativeExecutionInput({ ...input, previousTurn: { runId: "unrelated", task } }).continuationPrompt).toBeNull();
  expect(buildNativeExecutionInput({ ...input, sessionContinuity: "paperclip" }).continuationPrompt).toBeNull();
});
it("keeps a reopened task's next prompt bare when only the agent's own reply is new", () => {
  const wake = (authorId: string) => { const messages = [{ id: "r", body: "Reply", authorType: "agent", authorId, createdByRunId: "prior", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, { id: "c", body: "Next", authorType: "user", authorId: "board" }]; return { reason: "issue_reopened_via_comment", commentIds: ["c"], comments: [], executionContinuation: { version: 1, messages, resumeDelta: { baseRunId: "prior", messages } } }; };
  for (const [authorId, expected] of [["agent", true], ["other", false]] as const) expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: wake(authorId) }).promptOnly).toBe(expected);
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: { ...wake("agent"), reason: "issue_continuation_needed" } }).promptOnly).toBe(true);
  for (const createdByRunId of [undefined, null, "another-session-run"]) {
    const foreign = wake("agent");
    foreign.executionContinuation.resumeDelta.messages[0] = { ...foreign.executionContinuation.resumeDelta.messages[0], createdByRunId } as never;
    expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: foreign }).promptOnly).toBe(false);
  }
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
