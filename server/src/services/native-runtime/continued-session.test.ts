import { expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { buildPaperclipWakePayload } from "../heartbeat/run-preparation.js";
import { shouldResetTaskSessionForWake } from "../heartbeat/run-state.js";
import { decideNativeContinuation, withPiOpenTurnDefault } from "./continued-session.js";
import { configuredEnvironmentProjection, buildNativeModelEnvelope, PAPERCLIP_CONVERSATION_REPLY_INSTRUCTION, PAPERCLIP_EXECUTION_FINISH_INSTRUCTION, canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
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
  const wakePayload = { reason: "issue_commented", commentIds: ["comment"], comments: [], executionContinuation: { version: 1, messages, resumeDelta: { baseRunId: "prior", messages } } };
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
  for (const provider of ["pi_rpc", "codex"] as const) for (const sessionContinuity of [undefined, "continuous", "paperclip"]) {
    const reply = buildNativeExecutionInput({ ...args, issue: { ...task, conversationAgentId: null }, provider, sessionContinuity, finishedTaskConversation: true });
    const conversation = provider === "pi_rpc" && sessionContinuity !== "paperclip";
    const ordinary = buildNativeExecutionInput({ ...args, issue: { ...task, conversationAgentId: null }, provider, sessionContinuity });
    expect(reply.provider).toEqual(ordinary.provider);
    expect(reply.runtimeContext).toEqual(ordinary.runtimeContext);
    expect(reply.turnIntent).toBe(conversation ? "conversation_reply" : undefined);
    expect(reply.runtimeContext.prompt.text).toContain(PAPERCLIP_EXECUTION_FINISH_INSTRUCTION);
    if (conversation) expect(buildNativeModelEnvelope(reply, { resumedSession: true })).toMatchObject({ completion: { instruction: PAPERCLIP_CONVERSATION_REPLY_INSTRUCTION } });
    expect(reply.runtimeContext.aggregateDigest).toBe(canonicalNativeRuntimeContextDigest(reply.runtimeContext));
    if (conversation) expect(reply.continuationPrompt).toBe(messages[0].body);
  }
  expect(args.runtimeContext.prompt.text).toContain(PAPERCLIP_EXECUTION_FINISH_INSTRUCTION);
});
it("keeps a reopened task's next prompt bare when only the agent's own reply is new", () => {
  const wake = (authorId: string) => { const messages = [{ id: "r", body: "Reply", authorType: "agent", authorId }, { id: "c", body: "Next", authorType: "user", authorId: "board" }]; return { reason: "issue_reopened_via_comment", commentIds: ["c"], comments: [], executionContinuation: { version: 1, messages, resumeDelta: { baseRunId: "prior", messages } } }; };
  for (const [authorId, expected] of [["agent", true], ["other", false]] as const) expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: wake(authorId) }).promptOnly).toBe(expected);
  expect(decideNativeContinuation({ provider: "pi_rpc", hasSession: true, agentId: "agent", previousRunId: "prior", wakePayload: { ...wake("agent"), reason: "issue_continuation_needed" } }).promptOnly).toBe(true);
});
