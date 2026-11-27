import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MODEL_HIDDEN_RUN_ID_KEYS, withoutModelHiddenRunIds } from "@paperclipai/adapter-utils/model-facing-history";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, heartbeatRunEvents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { buildNativeSessionHandoff, createNativeSessionHandoffLoader, NATIVE_HANDOFF_MAX_BYTES, NATIVE_WHOLE_HANDOFF_MAX_BYTES, renderNativeSessionHandoff } from "./native-session-handoff.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

const modelFacingHistorySources = [
  "../../../../packages/shared/src/types/execution-continuation.ts",
  "../execution-continuation.ts",
  "../source-trust.ts",
  "./child-review-outcomes.ts",
  "./native-session-handoff.ts",
];

describe("model-facing history run ids", () => {
  it("decides every run-id field in the sources that feed the continuation and fresh-session history", () => {
    const names = new Set(modelFacingHistorySources.flatMap((source) =>
      readFileSync(new URL(source, import.meta.url), "utf8").match(/\b(?:runId|[a-z][A-Za-z]*RunId)\b/g) ?? []));
    expect([...names].filter((name) => !MODEL_HIDDEN_RUN_ID_KEYS.has(name)).sort()).toEqual([]);
  });

  it("hides the reviewer run of a child review outcome", () => {
    const outcome = { id: "interaction-1", kind: "request_confirmation", status: "accepted",
      result: { sourceRunId: "run-a", reviewerRunId: "run-b", decision: "approved", resolvedAt: null } };
    expect(withoutModelHiddenRunIds(outcome)).toEqual({ id: "interaction-1", kind: "request_confirmation", status: "accepted",
      result: { decision: "approved", resolvedAt: null } });
  });
});

const swarmRunId = "5a1d0c2e-7f3b-4c41-9b0a-0d3c8e9f1a21";
const reply = "Both requested files have been created in the task folder and verified.";

describe("renderNativeSessionHandoff", () => {
  it("keeps retrievable source ids and names no run ids", () => {
    const packet = renderNativeSessionHandoff({
      issueId: "issue-48",
      generation: null,
      omittedEntriesAtLeast: 0,
      entries: [
        { kind: "original_request", id: "comment-request", body: "Create w1.txt and w2.txt.", author: "user" },
        { kind: "document", id: "document-summary", key: "continuation-summary", body: "# Continuation Summary" },
        { kind: "run_summary", id: swarmRunId, status: "succeeded", body: reply, sourceTrust: null },
        { kind: "agent_reply", id: "11171", runId: swarmRunId, body: reply, sourceTrust: {
          preset: "low_trust_review", disposition: "quarantined", sourceIssueId: "issue-48", sourceRunId: swarmRunId, sourceAgentId: "agent-1",
        } },
      ],
    });
    expect(packet).not.toContain(swarmRunId);
    expect(packet).not.toContain("11171");
    const entries = JSON.parse(packet.split("\n").at(-1)!).entries as Array<Record<string, unknown>>;
    expect(entries.map(({ kind, id }) => [kind, id])).toEqual([
      ["original_request", "comment-request"],
      ["document", "document-summary"],
      ["run_summary", undefined],
      ["agent_reply", undefined],
    ]);
    expect(entries[2]).toMatchObject({ status: "succeeded", body: reply, truncated: false });
    expect(entries[3]!.sourceTrust).toEqual({
      preset: "low_trust_review", disposition: "quarantined", sourceIssueId: "issue-48", sourceAgentId: "agent-1",
    });
  });

  it("preserves other_agent author labels alongside agent and user entries", () => {
    const packet = renderNativeSessionHandoff({
      issueId: "chat-1",
      generation: 0,
      omittedEntriesAtLeast: 0,
      entries: [
        { kind: "original_request", id: "c-user", body: "Plan the launch", author: "user" },
        { kind: "message", id: "c-peer", body: "PEER NOTE", author: "other_agent", authorAgentId: "agent-peer" },
        { kind: "message", id: "c-own", body: "OWN REPLY", author: "agent", authorAgentId: "agent-self" },
      ],
    });
    const entries = JSON.parse(packet.split("\n").at(-1)!).entries as Array<Record<string, unknown>>;
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "c-user", author: "user", body: "Plan the launch" }),
      expect.objectContaining({ id: "c-peer", author: "other_agent", authorAgentId: "agent-peer", body: "PEER NOTE" }),
      expect.objectContaining({ id: "c-own", author: "agent", authorAgentId: "agent-self", body: "OWN REPLY" }),
    ]));
  });
});

describe("whole fresh-session handoff", () => {
  it("bounds whole handoffs by keeping the newest messages whole and naming every omission", () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ kind: "message", id: String(i), body: `${i}:` + "🦖".repeat(45_000) }));
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: 1, mode: "whole", entries, omittedEntriesAtLeast: 0 });
    const packet = JSON.parse(rendered.split("\n").at(-1)!);
    expect(rendered.length).toBeLessThanOrEqual(400_000);
    expect(rendered.split("\n")[0]).toBe("4 earlier messages were not handed over.");
    expect(packet.entries.map((entry: { body: string }) => entry.body)).toEqual(entries.slice(4).map(entry => entry.body));
  });

  it("caps whole history by its bytes inside the journal command, including both escaping passes", () => {
    const origin = { kind: "original_request", id: "origin", body: "Repair the journal overflow; preserve the original objective." };
    const content = 'Review: "Résumé 日本語 🦖"\n```ts\nconst file = "C:\\work\\src";\nconsole.log({"ok": true});\n```\n';
    const messages = Array.from({ length: 6 }, (_, i) => ({ kind: "message", id: String(i), body: `${i}:\n${content.repeat(530)}` }));
    const entries = [origin, ...messages, { kind: "document", id: "support", body: "Existing plan" }];
    const args = { issueId: "task", generation: 1, mode: "whole" as const, omittedEntriesAtLeast: 2, omittedMessages: 3 };
    const empty = renderNativeSessionHandoff({ ...args, entries: [] }).split("\n");
    const unsafe = [...empty.slice(0, -1), JSON.stringify({ ...JSON.parse(empty.at(-1)!), entries })].join("\n");
    const commandBytes = (packet: string) => Buffer.byteLength(JSON.stringify({ type: "turn.start", payload: {
      text: JSON.stringify({ task: { prompt: packet } }),
    } }));
    const maxCommandBytes = Math.floor((1024 * 1024 - 4096) / 2);
    expect(unsafe.length).toBeLessThan(400_000);
    expect(commandBytes(unsafe)).toBeGreaterThan(maxCommandBytes);
    const rendered = renderNativeSessionHandoff({ ...args, entries });
    const packet = JSON.parse(rendered.split("\n").at(-1)!);
    expect(commandBytes(rendered) - commandBytes("")).toBeLessThanOrEqual(NATIVE_WHOLE_HANDOFF_MAX_BYTES);
    expect(commandBytes(rendered)).toBeLessThanOrEqual(maxCommandBytes);
    expect(packet.entries.map((entry: { body: string }) => entry.body)).toEqual([origin, ...messages.slice(3)].map(entry => entry.body));
    expect(packet.omittedMessages).toBe(3 + messages.length - (packet.entries.length - 1));
    expect(packet.omittedSupportingEntriesAtLeast).toBe(3);
    expect(packet.omittedEntriesAtLeast).toBe(packet.omittedMessages + packet.omittedSupportingEntriesAtLeast);
    expect(rendered).toContain(`${packet.omittedMessages} earlier messages were not handed over.`);
    expect(rendered).toContain("At least 3 supporting entries were not handed over.");
  });

  it("reserves the original request while rendering the newest whole messages", () => {
    const origin = { kind: "original_request", id: "origin", body: "Keep the original objective" };
    const newer = Array.from({ length: 70 }, (_, i) => ({ kind: "message", id: String(i), body: `${i}:` + "x".repeat(100_000) }));
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: null, mode: "whole",
      entries: [origin, ...newer], omittedEntriesAtLeast: 0 });
    const packet = JSON.parse(rendered.split("\n").at(-1)!);
    expect(rendered.length).toBeLessThanOrEqual(400_000);
    expect(packet.entries.map((entry: { id: string }) => entry.id)).toEqual(["origin", "67", "68", "69"]);
    expect(packet.entries[0].body).toBe(origin.body);
    expect(packet.omittedMessages).toBe(67);
  });

  it("keeps a marked original excerpt when that request alone exceeds the whole budget", () => {
    const rendered = renderNativeSessionHandoff({ issueId: "task", generation: null, mode: "whole", omittedEntriesAtLeast: 0,
      entries: [{ kind: "original_request", id: "origin", body: "START" + "x".repeat(500_000) + "END" }] });
    const packet = JSON.parse(rendered.split("\n").at(-1)!);
    expect(rendered.length).toBeLessThanOrEqual(400_000);
    expect(packet.entries[0]).toMatchObject({ id: "origin", truncated: true });
    expect(packet.entries[0].body).toMatch(/^START.*END$/s);
  });

  it("counts support-only omissions separately from messages", () => {
    const result = renderNativeSessionHandoff({ issueId: "task", generation: null, mode: "whole", omittedEntriesAtLeast: 1,
      entries: [{ kind: "message", id: "message", body: "retained" }] });
    expect(result).not.toContain("earlier messages were not handed over");
    expect(result).toContain("At least 1 supporting entries were not handed over.");
  });

  it("counts mixed budget evictions by message and supporting entry", () => {
    const result = renderNativeSessionHandoff({ issueId: "task", generation: null, mode: "whole", omittedEntriesAtLeast: 1,
      entries: [{ kind: "message", id: "old", body: "x".repeat(250_000) }, { kind: "message", id: "new", body: "y".repeat(250_000) },
        { kind: "document", id: "doc", body: "support" }] });
    expect(result.split("\n")[0]).toBe("1 earlier messages were not handed over.");
    expect(result).toContain("At least 2 supporting entries were not handed over.");
    const packet = JSON.parse(result.split("\n").at(-1)!);
    expect(packet.omittedMessages).toBe(1);
    expect(packet.entries.map((entry: { id: string }) => entry.id)).toEqual(["new"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("whole handoff history scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), boundaryId = randomUUID(), requestId = randomUUID();
  const workflowDocumentId = randomUUID(), workflowRevisionId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-handoff-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "HAND" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dickens", role: "general", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "user", conversationState: "active", conversationSessionGeneration: 2 });
    await db.insert(issueComments).values([
      { companyId, issueId, body: "OLD TOPIC", authorUserId: "user", createdAt: new Date(1_000) },
      { id: boundaryId, companyId, issueId, body: "/new", authorUserId: "user", createdAt: new Date(2_000) },
      { id: requestId, companyId, issueId, body: "Build a GitHub PR review bot\n" + "x".repeat(6_000) + "\nFinal constraint: require a team review", authorUserId: "user", createdAt: new Date(3_000) },
      { companyId, issueId, body: "Deleted private message", authorUserId: "user", createdAt: new Date(4_000), deletedAt: new Date(5_000) },
      { companyId, issueId, body: "UNTRUSTED BODY", authorAgentId: agentId, createdAt: new Date(5_000),
        sourceTrust: { preset: "low_trust_review", disposition: "quarantined", sourceIssueId: issueId } },
      { companyId, issueId, body: "FUTURE MESSAGE", authorUserId: "user", createdAt: new Date(30_000) },
      { companyId, issueId, body: "I’ll check the review request.", authorAgentId: agentId, origin: "fast_response", createdAt: new Date(4_500) },
    ]);
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId }).where(eq(issues.id, issueId));
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(6_000), resolvedAt: new Date(7_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "Use CODEOWNERS and publish a Storybook per PR" },
    });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(2_500), resolvedAt: new Date(3_500),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "LATER CUTOFF DECISION" },
    });
    const laterAnswerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: laterAnswerRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(2_500), finishedAt: new Date(3_600),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "LATER CUTOFF RUN SUMMARY" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: laterAnswerRunId, seq: 1, eventType: "item.completed", createdAt: new Date(3_500),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "LATER CUTOFF REPLY" } } } });
    const runId = randomUUID(), documentId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "succeeded",
      nativeIssueId: issueId, contextSnapshot: { issueId, conversationSessionGeneration: 2 }, createdAt: new Date(8_000), finishedAt: new Date(9_500),
      runnerProfileJson: { sessionCheckpoint: { semanticResult: { summary: "Waiting for GitHub access before configuring PR checks" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "item.completed", createdAt: new Date(9_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text: "Repository research complete; next configure PR checks" } } } });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "Saved plan: review changed files by CODEOWNERS", updatedAt: new Date(10_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan", createdAt: new Date(10_000) });
    await db.insert(documents).values({ id: workflowDocumentId, companyId, title: "Workflow",
      latestBody: "WORKFLOW_BODY_CANARY: triage then implementation then verification.\n".repeat(100),
      latestRevisionId: workflowRevisionId, updatedAt: new Date(11_000) });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: workflowDocumentId, key: "workflow", createdAt: new Date(11_000) });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId, conversationSessionGeneration: 2 },
        resultJson: { summary: "Legacy answer: repository selection is complete" }, createdAt: new Date(12_000), finishedAt: new Date(13_000) },
      { companyId, agentId, status: "succeeded", runtimeMode: "legacy", contextSnapshot: { issueId: randomUUID(), conversationSessionGeneration: 2 },
        resultJson: { summary: "UNRELATED TASK ANSWER" }, createdAt: new Date(14_000), finishedAt: new Date(15_000) },
    ]);
  });
  afterAll(async () => database?.cleanup());

  it("keeps whole comments and unmatched finals chronological beyond every stock cap, with stock form/document context", async () => {
    const taskId = randomUUID(), commentedRun = randomUUID(), finalRun = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Long handoff", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([commentedRun, finalRun].map(id => ({ id, companyId, agentId,
      nativeIssueId: taskId, status: "succeeded", createdAt: new Date(29_000) })));
    const comments = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), companyId, issueId: taskId,
      body: `comment-${i}:` + "x".repeat(i === 0 ? 5_000 : 2_500), createdAt: new Date(30_000 + i * 1_000),
      ...(i === 1 ? { authorAgentId: agentId, createdByRunId: commentedRun, clientRequestId: `native-final:${commentedRun}:saved-comment` } : { authorUserId: "user" }),
    }));
    await db.insert(issueComments).values(comments);
    const finals = Array.from({ length: 6 }, (_, i) => `final-${i}:` + "y".repeat(i === 0 ? 5_000 : 10));
    await db.insert(heartbeatRunEvents).values(finals.map((text, i) => ({ companyId, agentId, runId: finalRun,
      seq: i + 1, eventType: "item.completed", createdAt: new Date(30_500 + i * 1_000),
      payload: { prpEvent: { payload: { kind: "agentMessage", channel: "final", text } } },
    })));
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: commentedRun, seq: 1,
      eventType: "item.completed", createdAt: new Date(31_000),
      payload: { prpEvent: { itemId: "saved-comment", payload: { kind: "agentMessage", channel: "final", text: comments[1].body } } } });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: taskId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(30_000), resolvedAt: new Date(30_800),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "FORM ANSWER: keep CODEOWNERS" } });
    const args = { db, companyId, issueId: taskId, agentId, before: new Date(50_000) };
    const whole = await buildNativeSessionHandoff({ ...args, mode: "whole" });
    const stock = await buildNativeSessionHandoff(args);
    const entries = JSON.parse(whole!.split("\n").at(-1)!).entries;
    const expected = comments.flatMap((comment, i) => i < finals.length ? [comment.body, finals[i]] : [comment.body]);
    expect(entries.filter((entry: { kind: string }) => entry.kind !== "resolved_interaction").map((entry: { body: string }) => entry.body)).toEqual(expected);
    expect(entries.filter((entry: { body: string }) => entry.body === comments[1].body)).toHaveLength(1);
    expect(Buffer.byteLength(whole!)).toBeGreaterThan(NATIVE_HANDOFF_MAX_BYTES);
    expect(Buffer.byteLength(stock!)).toBeLessThanOrEqual(NATIVE_HANDOFF_MAX_BYTES);
    expect(stock).not.toContain(comments[0].body);
    expect(whole).toContain("FORM ANSWER: keep CODEOWNERS");
    const input = buildNativeExecutionInput({ companyId, runId: randomUUID(), agentId, normalizedSessionId: "session", conversationMode: true,
      issue: { id: taskId, identifier: "HAND-2", title: "Long handoff", description: null, workMode: "standard" },
      taskPrompt: "Continue", freshSessionHandoff: whole, runtimeContext: nativeRuntimeContextFixture(),
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Continue" }] } },
    });
    expect(buildNativeModelEnvelope(input).task.prompt).toContain(whole);
    const resumed = buildNativeModelEnvelope(input, { resumedSession: true });
    expect("task" in resumed && resumed.task.prompt).not.toContain("Fresh session handoff");
    const context = await buildNativeSessionHandoff({ db, companyId, issueId, agentId, before: new Date(20_000), mode: "whole" });
    for (const text of ["Saved plan", 'read_document using key \\"workflow\\"', "Use CODEOWNERS"]) expect(context).toContain(text);
    for (const text of ["OLD TOPIC", "Deleted private message", "FUTURE MESSAGE", "UNTRUSTED BODY", "WORKFLOW_BODY_CANARY"]) expect(context).not.toContain(text);
  });

  it.each(["mapped", "keyed"])("keeps a progress comment and distinct finals once each, deduping only the saved item (%s)", async (identity) => {
    const taskId = randomUUID(), runId = randomUUID(), savedId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Per-item handoff", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: taskId, status: "succeeded",
      createdAt: new Date(30_000), resultJson: identity === "mapped" ? { continuousReplies: { saved: { commentId: savedId } } } : {} });
    const rows = [
      { body: "PROGRESS: investigating", createdAt: new Date(31_000) },
      { id: savedId, body: "SAVED FINAL", createdAt: new Date(32_000),
        ...(identity === "keyed" ? { clientRequestId: `native-final:${runId}:saved:opening` } : {}) },
    ];
    await db.insert(issueComments).values(rows.map(row => ({ ...row, companyId, issueId: taskId, authorAgentId: agentId, createdByRunId: runId })));
    await db.insert(heartbeatRunEvents).values(["saved", "distinct"].map((itemId, i) => ({ companyId, agentId, runId, seq: i + 1,
      eventType: "item.completed", createdAt: new Date(32_000 + i * 1_000),
      payload: { prpEvent: { itemId, payload: { kind: "agentMessage", channel: "final", text: i === 0 ? "SAVED FINAL" : "DISTINCT FINAL" } } } })));
    const result = await buildNativeSessionHandoff({ db, companyId, issueId: taskId, agentId, before: new Date(40_000), mode: "whole" });
    const packet = JSON.parse(result!.split("\n").at(-1)!);
    expect(packet.entries.map((entry: { body: string }) => entry.body)).toEqual(["PROGRESS: investigating", "SAVED FINAL", "DISTINCT FINAL"]);
    expect(packet.omittedEntriesAtLeast).toBe(0);
  });

  it("counts zero omitted messages with thirty supporting interactions", async () => {
    const taskId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Budgeted history", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ companyId, issueId: taskId, authorUserId: "user", body: "retained", createdAt: new Date(30_000) });
    await db.insert(issueThreadInteractions).values(Array.from({ length: 30 }, () => ({ companyId, issueId: taskId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: agentId, createdAt: new Date(30_000), resolvedAt: new Date(31_000),
      payload: { version: 1 as const, questions: [] }, result: { version: 1 as const, summaryMarkdown: "resolved" } })));
    const args = { db, companyId, issueId: taskId, agentId, before: new Date(100_000), mode: "whole" as const };
    const supportOnly = await buildNativeSessionHandoff(args);
    expect(supportOnly).not.toContain("earlier messages were not handed over");
    expect(supportOnly).toContain("supporting entries were not handed over");
  });

  it.each(["comments", "finals"] as const)("loads full %s bodies only within the whole-message budget", async kind => {
    const taskId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Large history", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ companyId, issueId: taskId, authorUserId: "user", body: "old request", createdAt: new Date(30_000) });
    const args = { db, companyId, issueId: taskId, agentId, before: new Date(200_000), mode: "whole" as const };
    const rows = Array.from({ length: 70 }, (_, i) => ({ id: randomUUID(), companyId, issueId: taskId, authorUserId: "user",
      body: `${i}:` + "x".repeat(100_000), createdAt: new Date(32_000 + i * 1_000) }));
    if (kind === "comments") await db.insert(issueComments).values(rows);
    else {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: taskId, status: "succeeded", createdAt: new Date(31_000) });
      await db.insert(heartbeatRunEvents).values(rows.map((row, i) => ({ companyId, agentId, runId, seq: i + 1,
        eventType: "item.completed", createdAt: new Date(50_000),
        payload: { prpEvent: { itemId: String(i), payload: { kind: "agentMessage", channel: "final", text: row.body } } } })).reverse());
    }
    let loadedBodyChars = 0;
    const originalSelect = db.select.bind(db);
    const select = vi.spyOn(db, "select");
    select.mockImplementation(((...selectArgs: Parameters<typeof db.select>) => {
      const builder = originalSelect(...selectArgs);
      const originalFrom = builder.from.bind(builder);
      builder.from = ((...fromArgs: Parameters<typeof builder.from>) => {
        const query = originalFrom(...fromArgs);
        const execute = query.execute.bind(query);
        query.execute = (async (...executeArgs: Parameters<typeof query.execute>) => {
          const result = await execute(...executeArgs);
          for (const row of result) if (typeof row.body === "string") loadedBodyChars += row.body.length;
          return result;
        }) as typeof query.execute;
        return query;
      }) as typeof builder.from;
      return builder;
    }) as typeof db.select);
    let result: string;
    try { result = (await buildNativeSessionHandoff({ ...args, before: new Date(200_000) }))!; }
    finally { select.mockRestore(); }
    expect(loadedBodyChars).toBeLessThan(400_000);
    expect(loadedBodyChars).toBeGreaterThan(100_000);
    const packet = JSON.parse(result.split("\n").at(-1)!);
    const retained = packet.entries.filter((entry: { kind: string }) => ["original_request", "message", "agent_reply"].includes(entry.kind));
    expect(packet.omittedMessages).toBe(71 - retained.length);
    expect(result.length).toBeLessThanOrEqual(400_000);
    expect(retained.at(-1).body).toBe(rows.at(-1)!.body);
    expect(retained[0]).toMatchObject({ kind: "original_request", body: "old request" });
    expect(retained.slice(1).map((entry: { body: string }) => entry.body)).toEqual(rows.slice(-3).map(row => row.body));
  });

  it.each(["full", "partial", "foreign"] as const)("dedupes comments only against full same-task continuation coverage (%s)", async coverage => {
    const taskId = randomUUID(), runId = randomUUID(), savedId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Continue the review", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: taskId, status: "succeeded",
      createdAt: new Date(30_000), resultJson: { continuousReplies: { saved: { commentId: savedId } } } });
    const comments = [
      { id: randomUUID(), body: "ORIGINAL-COMMENT-CANARY", authorUserId: "user" },
      { id: savedId, body: "SAVED-FINAL-CANARY", authorAgentId: agentId },
      { id: randomUUID(), body: "LATEST-COMMENT-CANARY", authorUserId: "user" },
    ];
    await db.insert(issueComments).values(comments.map((row, i) => ({ ...row, companyId, issueId: taskId, createdAt: new Date(31_000 + i * 1_000) })));
    await db.insert(heartbeatRunEvents).values(["saved", "distinct"].map((itemId, i) => ({ companyId, agentId, runId, seq: i + 1,
      eventType: "item.completed", createdAt: new Date(35_000 + i * 1_000),
      payload: { prpEvent: { itemId, payload: { kind: "agentMessage", channel: "final", text: i === 0 ? comments[1].body : "UNMATCHED-FINAL-CANARY" } } } })));
    await db.insert(issueThreadInteractions).values({ companyId, issueId: taskId, kind: "ask_user_questions", status: "answered",
      createdByAgentId: agentId, createdAt: new Date(34_000), resolvedAt: new Date(35_000),
      payload: { version: 1, questions: [] }, result: { version: 1, summaryMarkdown: "INTERACTION-CANARY" } });
    const continuation = await buildExecutionContinuation({ db, companyId, issueId: taskId, agentId,
      context: {}, summary: null, exposeLowTrustRaw: false });
    if (coverage === "partial") continuation.coverage.kind = "task_history_delta";
    if (coverage === "foreign") continuation.issueId = randomUUID();
    const load = createNativeSessionHandoffLoader({ db, companyId, issueId: taskId, agentId, before: new Date(40_000),
      mode: "whole", continuation, excludeCommentIds: coverage === "full" ? [savedId] : [] });
    const handoff = (await load())!;
    const packet = JSON.parse(handoff.split("\n").at(-1)!);
    expect(packet.entries.filter((entry: { kind: string }) => ["message", "original_request"].includes(entry.kind))).toHaveLength(coverage === "full" ? 0 : 3);
    expect(handoff).toContain("UNMATCHED-FINAL-CANARY");
    expect(handoff).toContain("INTERACTION-CANARY");
    expect(packet.omittedMessages).toBe(0);
    if (coverage === "full") {
      const prompt = `${handoff}\n\n${renderPaperclipWakePrompt({ issue: { id: taskId }, executionContinuation: continuation })}`;
      for (const comment of comments) expect(prompt.split(comment.body).length - 1).toBe(1);
    }
  });

  it("bounds hydration of an oversized original without dropping its slot", async () => {
    const taskId = randomUUID();
    await db.insert(issues).values({ id: taskId, companyId, title: "Long original", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ companyId, issueId: taskId, authorUserId: "user", createdAt: new Date(30_000),
      body: "START" + "x".repeat(500_000) + "END" });
    const rendered = (await buildNativeSessionHandoff({ db, companyId, issueId: taskId, agentId, before: new Date(40_000), mode: "whole" }))!;
    const packet = JSON.parse(rendered.split("\n").at(-1)!);
    expect(rendered.length).toBeLessThanOrEqual(400_000);
    expect(packet.entries[0]).toMatchObject({ kind: "original_request", truncated: true });
    expect(packet.entries[0].body).toMatch(/^START.*END$/s);
    expect(packet.omittedMessages).toBe(0);
  });
});
