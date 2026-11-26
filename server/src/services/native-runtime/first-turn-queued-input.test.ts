import { randomUUID } from "node:crypto";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { buildNativeExecutionInput, budgetNativeFreshFallback } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, assets, authUsers, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueAttachments,
  issueComments, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { publishContinuousNativeReply } from "./native-continuous-reply.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { undeliveredLegacyUserCommentIds } from "../explicit-native-continuation.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import {
  claimFirstTurnQueuedInput, readFirstTurnQueuedInputReceipt, firstTurnClaimedCommentIds, firstTurnTakesAllQueuedComments, runAcceptsFirstTurnQueuedInput, renderFirstTurnQueuedInput,
} from "./first-turn-queued-input.js";

import { assertNativeQueuedTurnBound, commandEnvelopeBytes, NATIVE_TURN_KNOWN_MAX_BYTES, nativePromptCauseFromError, commandTextBytes, FIRST_TURN_QUEUED_INPUT_MAX_BYTES, NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND } from "./native-turn-budget.js";

describe("first-turn encoded byte budget", () => {
  const message = (id: string, body: string, kind?: "interaction") => ({ id, body, kind, createdAt: new Date("2026-01-01Z") });
  it.each([undefined, "interaction"] as const)("carries a long person's input whole or refuses before clipping (%s)", kind => {
    const body = "🦖".repeat(8000) + " END OF PERSON'S WORDS";
    const text = renderFirstTurnQueuedInput([message("person", body, kind)])!;
    expect(text).toContain(body);
    expect(commandTextBytes(text)).toBeLessThanOrEqual(FIRST_TURN_QUEUED_INPUT_MAX_BYTES);
    expect(() => renderFirstTurnQueuedInput([message("person", '"'.repeat(40000), kind)]))
      .toThrow(NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND);
  });
  it("takes the longest prefix of whole messages instead of clipping or stalling the batch", () => {
    const bodies = [0, 1, 2].map(i => `PERSON ${i} ` + '"'.repeat(10000));
    const text = renderFirstTurnQueuedInput(bodies.map((body, i) => message(`comment-${i}`, body)))!;
    expect(text).toContain(bodies[0]);
    expect(text).toContain(bodies[1]);
    expect(text).not.toContain("PERSON 2");
    expect(text).toContain("Message 2 of 2");
  });
  it("refuses oversized metadata instead of consuming invisible messages; preserves short output", () => {
    expect(() => renderFirstTurnQueuedInput([message("x".repeat(100000), "hi")])).toThrow(NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND);
    expect(renderFirstTurnQueuedInput([message("id", "hello")])).toBe("New messages from the user arrived while this run was starting. They were not in the request above. Handle each of them in this turn, oldest first, together with that request:\n\n[Message 1 of 1 · comment id · 2026-01-01T00:00:00.000Z]\nhello");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const USER = "first-turn-user";

describe.skipIf(!support.supported)("first-turn queued input", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-first-turn-queued-input-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: USER, name: "Queued input owner", email: "queued-input-owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "First turn", issuePrefix: `F${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Codie", adapterType: "paperclip_runner" }).returning();
    const issueId = randomUUID();
    const runId = await startRun(company!.id, agent!.id, issueId);
    await db.insert(issues).values({ id: issueId, companyId: company!.id, title: "Fix the reports", status: "in_progress",
      assigneeAgentId: agent!.id, executionRunId: runId });
    return { companyId: company!.id, agentId: agent!.id, issueId, runId };
  }

  async function startRun(companyId: string, agentId: string, issueId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: issueId, responsibleUserId: USER, startedAt: new Date(),
      contextSnapshot: { issueId } }).returning();
    return run!.id;
  }

  /** A user's comment saved behind the active run, in the shape the previous release writes. */
  async function queueMessage(f: Awaited<ReturnType<typeof seed>>, body: string) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: USER, body }).returning();
    const [existing] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then(rows => rows.filter(row => row.companyId === f.companyId));
    const ids = [...((existing?.payload?._paperclipWakeContext as { wakeCommentIds?: string[] } | undefined)?.wakeCommentIds ?? []), comment!.id];
    const payload = { issueId: f.issueId, commentId: comment!.id, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId,
      wakeReason: "issue_commented", source: "issue.comment", wakeCommentId: comment!.id, wakeCommentIds: ids } };
    if (existing) await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, existing.id));
    else await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: USER, payload });
    return comment!.id;
  }

  async function queueAnswer(f: Awaited<ReturnType<typeof seed>>, provider = "pi_rpc") {
    await db.update(agents).set({ adapterConfig: { provider, sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "answered", createdByAgentId: f.agentId, resolvedByUserId: USER, resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "color", prompt: "Which color?", selectionMode: "single", required: true,
        options: [{ id: "green", label: "Green" }] }] }, result: { version: 1, answers: [{ questionId: "color", optionIds: ["green"] }] } }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: USER,
      payload: { issueId: f.issueId, mutation: "interaction", interactionId: card.id, interactionStatus: "answered" } }).returning();
    return { card, wake };
  }

  const binding = (f: { companyId: string; issueId: string; agentId: string }, runId: string) =>
    ({ companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId });
  const accept = (f: { companyId: string; agentId: string }, runId: string) => appendHeartbeatRunEvent(db, {
    companyId: f.companyId, runId, agentId: f.agentId, eventType: "turn.accepted", stream: "system", level: "info", message: "turn accepted" });
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it.each([100, 900000])("budgets failed resume after the saved contextSnapshot makes a real JSONB round trip (%s)", async chars => {
    const f = await seed();
    const body = "Person's exact words: $& $' $` $$ END";
    const messages = Array.from({ length: 31 }, (_, i) => ({ id: `message-${i}`, authorType: i === 30 ? "user" : "agent", authorId: "author", createdByRunId: null,
      body: i === 30 ? body : "x".repeat(Math.floor(chars / 30)), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deleted: false, sourceTrust: null }));
    const continuation: ExecutionContinuationEnvelope = { version: 1, companyId: f.companyId, issueId: f.issueId, objective: "Preserve the objective.",
      objectiveSource: { kind: "comment", id: "message-30", revision: "2026-01-01T00:00:00Z" }, trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
      originCommentIds: ["message-30"], messages, resumeDelta: { baseRunId: "previous", messages: [messages[30]!] },
      completedActions: [{ runId: "old", receiptId: "receipt", operationId: "GET /api/issues/{id}/comments", result: { longerKeyFirst: "kept", a: "same receipt" } }],
      humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: "message-30", summaryThroughCommentId: null } };
    const wake = { reason: "issue_commented", commentIds: ["message-30"], executionContinuation: continuation };
    const issue = { id: f.issueId, identifier: "BUDGET-1", title: "Continue", description: null, workMode: "standard" };
    const input = buildNativeExecutionInput({ ...f, boundCommandBytes: true, wakePayload: wake, issue, taskPrompt: "Preserve the objective.",
      normalizedSessionId: "session", resumedSession: true, provider: "pi_rpc", previousTurn: { runId: "previous", task: issue },
      workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
        contract: { revision: "1", objective: "Continue", criteria: [{ id: "output", requirement: "Continue" }] } } });
    const originalPrompt = input.task.prompt;
    await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipWake: wake } }).where(eq(heartbeatRuns.id, f.runId));
    const savedWake = (await readRun(f.runId)).contextSnapshot!.paperclipWake;
    expect(savedWake).toEqual(wake);
    expect(JSON.stringify(savedWake)).not.toBe(JSON.stringify(wake));
    const bounded = budgetNativeFreshFallback(input, savedWake, { lastRunAt: "2026-01-02T00:00:00Z", readCommentIds: messages.map(m => m.id) });
    if (chars > 100) expect(bounded!.messages.length).toBeLessThan(messages.length);
    else expect(input.task.prompt).toBe(originalPrompt);
    expect(commandEnvelopeBytes(buildNativeModelEnvelope(input))).toBeLessThan(NATIVE_TURN_KNOWN_MAX_BYTES);
    expect(input.task.prompt.split(body)).toHaveLength(2);
    expect(input.task.prompt).toContain(body);
    if (chars > 100) expect(input.task.prompt).toContain("History was cut");
    expect(input.continuationPrompt).toBeNull();
    console.info(JSON.stringify({ jsonbFallback: "fresh-cut", knownBytes: commandEnvelopeBytes(buildNativeModelEnvelope(input)), retainedMessages: bounded!.messages.length }));
  });

  it("gives a message that arrived during preparation to the first turn, without a stop", async () => {
    const f = await seed();
    const message = await queueMessage(f, "oh i mean each of the ones that appeared within the last 24 hours");
    expect(await runAcceptsFirstTurnQueuedInput(db, await readRun(f.runId))).toBe(true);
    const startedAt = performance.now();
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    const sealMs = performance.now() - startedAt;
    console.info(`first-turn queued input seal took ${sealMs.toFixed(1)}ms before turn.start`);
    expect(firstTurn).toContain("oh i mean each of the ones that appeared within the last 24 hours");
    expect(firstTurn).toContain(`comment ${message}`);
    const run = await readRun(f.runId);
    expect(run.status).toBe("running");
    expect([...firstTurnClaimedCommentIds(run)]).toEqual([message]);
    // Sealed: a later message waits for the turn boundary and Interrupt applies.
    expect(await runAcceptsFirstTurnQueuedInput(db, run)).toBe(false);
    const later = await queueMessage(f, "one more thing");
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).not.toContain("one more thing");
    expect(firstTurnClaimedCommentIds(await readRun(f.runId)).has(later)).toBe(false);
    expect(sealMs).toBeLessThan(1_000);
  });

  it.each(["comment", "interaction"] as const)("refuses oversized queued person %s before claim and leaves its receipt unclaimed", async kind => {
    const f = await seed(), body = "whole person's input: " + "🦖".repeat(150000);
    const answer = kind === "interaction" ? await queueAnswer(f) : null;
    const id = answer ? answer.card.id : await queueMessage(f, body);
    if (answer) await db.update(issueThreadInteractions).set({ result: { version: 1,
      answers: [{ questionId: "color", optionIds: [], otherText: body }] } }).where(eq(issueThreadInteractions.id, id));
    await expect(claimFirstTurnQueuedInput(db, binding(f, f.runId))).rejects.toMatchObject({
      code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: kind === "interaction" ? "human_response" : "queued_input", bytes: expect.any(Number) },
    });
    const run = await readRun(f.runId);
    expect(readFirstTurnQueuedInputReceipt(run)).toBeNull();
    expect([...firstTurnClaimedCommentIds(run)]).toEqual([]);
    expect(await runAcceptsFirstTurnQueuedInput(db, run)).toBe(true);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    if (answer) {
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0])
        .toMatchObject({ status: "answered", result: { answers: [{ otherText: body }] } });
    } else {
      expect([...await deliveredQueuedCommentIds(db, { ...f, commentIds: [id] })]).toEqual([]);
      expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [id])).toEqual([id]);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, id)))[0]!.body).toBe(body);
    }
  });

  it("refuses the composed turn before claim when whole queued input crosses its remaining room", async () => {
    const f = await seed(), id = await queueMessage(f, "queued person's words ".repeat(1000));
    const error = await claimFirstTurnQueuedInput(db, binding(f, f.runId), text => {
      assertNativeQueuedTurnBound(f.runId, { task: { prompt: "request" } }, text,
        { attachmentPrompt: "late attachments: " + "a".repeat(490000) });
    }).catch(error => error);
    expect(error).toMatchObject({ code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "queued_input" } });
    expect(nativePromptCauseFromError(new Error(String(error)))).toEqual(error.promptCause);
    const run = await readRun(f.runId);
    expect(readFirstTurnQueuedInputReceipt(run)).toBeNull();
    expect([...firstTurnClaimedCommentIds(run)]).toEqual([]);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [id])).toEqual([id]);
  });

  it("refuses oversized attachment references before writing even an empty receipt", async () => {
    const f = await seed();
    await expect(claimFirstTurnQueuedInput(db, binding(f, f.runId), text =>
      assertNativeQueuedTurnBound(f.runId, { task: { prompt: "request" } }, text, { attachmentPrompt: "a".repeat(600000) })))
      .rejects.toMatchObject({ code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, promptCause: { kind: "command" } });
    expect(readFirstTurnQueuedInputReceipt(await readRun(f.runId))).toBeNull();
  });

  it("delivers the first two whole messages and leaves the third owed for the next turn", async () => {
    const f = await seed(), bodies = [0, 1, 2].map(i => `PERSON ${i} ` + '"'.repeat(10000));
    const sessionId = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    const ids: string[] = [];
    for (const body of bodies) ids.push(await queueMessage(f, body));
    const text = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(text).toContain(bodies[0]); expect(text).toContain(bodies[1]); expect(text).not.toContain("PERSON 2");
    expect([...firstTurnClaimedCommentIds(await readRun(f.runId))]).toEqual(ids.slice(0, 2));
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBe(text);
    await accept(f, f.runId);
    expect([...await deliveredQueuedCommentIds(db, { ...f, commentIds: ids })].sort()).toEqual(ids.slice(0, 2).sort());
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, ids)).toEqual([ids[2]]);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await publishContinuousNativeReply({ db, recoverTerminal: true, cursor: 100, execution: { binding: { ...f }, provider: { kind: "pi_rpc" } },
      event: { eventType: "item.completed", runId: f.runId, normalizedSessionId: sessionId, sourceEventId: "prefix-final", itemId: "prefix-item", turnId: "prefix-turn",
        payload: { kind: "agentMessage", channel: "final", text: "Handled the two delivered messages." } } });
    const afterReply = await readRun(f.runId);
    expect(afterReply.resultJson?.continuousReplies).toMatchObject({ "prefix-item": { questionCommentIds: ids.slice(0, 2) } });
    const [remainingWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(remainingWake!.status).toBe("deferred_issue_execution");
    expect(queuedCommentIdsFromWakePayload(remainingWake!.payload)).toEqual([ids[2]]);
    const next = await startRun(f.companyId, f.agentId, f.issueId);
    let readIds: string[] = [];
    const snapshot = await buildExecutionContinuation({ db, ...f, runId: next, previousContextRunId: f.runId, context: { wakeReason: "issue_commented" },
      summary: null, exposeLowTrustRaw: false, onNativeReadState: state => { readIds = state.readCommentIds; } });
    expect(readIds.sort()).toEqual(ids.slice(0, 2).sort());
    expect(JSON.stringify((snapshot.coverage as { omitted?: unknown }).omitted ?? [])).not.toContain(ids[2]);
    expect(snapshot.messages.find(message => message.id === ids[2])!.body).toBe(bodies[2]);
    await db.update(issues).set({ executionRunId: next }).where(eq(issues.id, f.issueId));
    const later = await claimFirstTurnQueuedInput(db, binding(f, next));
    expect(later).toContain(bodies[2]); expect(later).not.toContain("PERSON 0");
    expect([...firstTurnClaimedCommentIds(await readRun(next))]).toEqual([ids[2]]);
    await accept(f, next);
    expect([...await deliveredQueuedCommentIds(db, { ...f, commentIds: ids })].sort()).toEqual([...ids].sort());
  });

  it("also limits the whole-message prefix to the composed command's remaining room", async () => {
    const f = await seed(), ids: string[] = [], bodies = [0, 1, 2].map(i => `PERSON ${i} ` + "a".repeat(30000));
    for (const body of bodies) ids.push(await queueMessage(f, body));
    const validate = (text: string | null) => assertNativeQueuedTurnBound(f.runId, { task: { prompt: "request" } }, text,
      { attachmentPrompt: "a".repeat(420000) });
    const text = await claimFirstTurnQueuedInput(db, binding(f, f.runId), validate);
    expect(text).toContain(bodies[0]); expect(text).toContain(bodies[1]); expect(text).not.toContain("PERSON 2");
    expect([...firstTurnClaimedCommentIds(await readRun(f.runId))]).toEqual(ids.slice(0, 2));
    await accept(f, f.runId);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, ids)).toEqual([ids[2]]);
  });

  it("delivers two messages from preparation in their queued order", async () => {
    const f = await seed();
    await queueMessage(f, "FIRST follow-up");
    await queueMessage(f, "SECOND follow-up");
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(firstTurn).toMatch(/Message 1 of 2[^\n]*\nFIRST follow-up[\s\S]*Message 2 of 2[^\n]*\nSECOND follow-up/);
  });

  it("keeps the message queued when the run fails before turn.start, then delivers it exactly once", async () => {
    const f = await seed();
    const message = await queueMessage(f, "please include the staging run");
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toContain("please include the staging run");
    // A restart before the provider accepted the turn repeats the same input.
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toContain("please include the staging run");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    // Not consumed: release promotion and Send both still deliver it.
    const ids = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, commentIds: [message] };
    expect([...await deliveredQueuedCommentIds(db, ids)]).toEqual([]);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [message])).toEqual([message]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wake!.status).toBe("deferred_issue_execution");

    // The next run takes it into its own first turn; the provider accepts.
    const nextRunId = await startRun(f.companyId, f.agentId, f.issueId);
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, nextRunId))).toContain("please include the staging run");
    await accept(f, nextRunId);
    expect([...await deliveredQueuedCommentIds(db, ids)]).toEqual([message]);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [message])).toEqual([]);

    // Exactly once: a later run, and a retry that copied the context, take nothing.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, nextRunId));
    const thirdRunId = await startRun(f.companyId, f.agentId, f.issueId);
    await db.update(heartbeatRuns).set({ contextSnapshot: (await readRun(nextRunId)).contextSnapshot })
      .where(eq(heartbeatRuns.id, thirdRunId));
    await db.update(issues).set({ executionRunId: thirdRunId }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, thirdRunId))).toBeNull();
  });

  it("counts a message as delivered once the provider accepted the turn, even if the run later fails", async () => {
    const f = await seed();
    const message = await queueMessage(f, "ship it");
    await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    await accept(f, f.runId);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect([...await deliveredQueuedCommentIds(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      commentIds: [message] })]).toEqual([message]);
  });

  it("treats a run saved by the previous release as started once its provider accepted a turn", async () => {
    const f = await seed();
    await queueMessage(f, "mid-turn message");
    await accept(f, f.runId);
    expect(await runAcceptsFirstTurnQueuedInput(db, await readRun(f.runId))).toBe(false);
  });

  it("leaves another user's message and a run without a responsible user to their own delivery", async () => {
    const f = await seed();
    await queueMessage(f, "mine");
    await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" }).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBeNull();
  });
  it("seals on a one-connection pool without waiting for a second connection", async () => {
    const f = await seed();
    await queueMessage(f, "secret-free follow-up");
    const single = createDb(database.connectionString, { maxConnections: 1 });
    try {
      const sealed = await Promise.race([
        claimFirstTurnQueuedInput(single, binding(f, f.runId)),
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 5_000)),
      ]);
      expect(sealed).toContain("secret-free follow-up");
    } finally {
      await single.$client.end({ timeout: 1 });
    }
  });

  it("keeps a sealed card answer owed after a failed start and takes it in the next run", async () => {
    const f = await seed(), { card, wake } = await queueAnswer(f);
    const input = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(input).toContain(card.id);
    expect(input).toContain('"optionIds": [');
    expect([...firstTurnClaimedCommentIds(await readRun(f.runId))]).toEqual([card.id]);
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBe(input);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("deferred_issue_execution");
    const next = await startRun(f.companyId, f.agentId, f.issueId);
    // A copied predecessor's receipt cannot claim the new run's input.
    await db.update(heartbeatRuns).set({ contextSnapshot: (await readRun(f.runId)).contextSnapshot }).where(eq(heartbeatRuns.id, next));
    await db.update(issues).set({ executionRunId: next }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, binding(f, next))).toBe(input);
    expect([...firstTurnClaimedCommentIds(await readRun(next))]).toEqual([card.id]);
  });

  it.each(["fresh", "other-user", "resume", "non-pi", "paperclip-continuity"])("leaves a card's independent delivery fences intact (%s)", async mode => {
    const f = await seed(), { card, wake } = await queueAnswer(f, mode === "non-pi" ? "codex" : "pi_rpc");
    if (mode === "paperclip-continuity") await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "paperclip" } }).where(eq(agents.id, f.agentId));
    if (mode === "other-user") await db.update(issueThreadInteractions).set({ resolvedByUserId: "someone-else" }).where(eq(issueThreadInteractions.id, card.id));
    else if (mode === "fresh" || mode === "resume") await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      _paperclipWakeContext: mode === "fresh" ? { forceFreshSession: true } : { resumeIntent: true } } }).where(eq(agentWakeupRequests.id, wake.id));
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBeNull();
    expect([...firstTurnClaimedCommentIds(await readRun(f.runId))]).toEqual([]);
  });

  it("does not take a reset command or input from a stale conversation generation", async () => {
    const f = await seed();
    await queueMessage(f, "/new");
    expect(await claimFirstTurnQueuedInput(db, binding(f, f.runId))).toBeNull();
    const next = await startRun(f.companyId, f.agentId, f.issueId);
    await db.update(issues).set({ executionRunId: next, conversationAgentId: f.agentId, conversationUserId: USER,
      conversationState: "active", conversationSessionGeneration: 1 }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, next));
    await queueMessage(f, "for the old conversation");
    await queueAnswer(f);
    expect(await claimFirstTurnQueuedInput(db, binding(f, next))).toBeNull();
  });

  it("leaves a message with files on its own delivery path so the files reach the agent", async () => {
    const f = await seed();
    await queueMessage(f, "text only");
    const withFile = await queueMessage(f, "see the attached screenshot");
    const [asset] = await db.insert(assets).values({ companyId: f.companyId, provider: "local_disk",
      objectKey: `${f.companyId}/screenshot`, originalFilename: "screenshot.png", contentType: "image/png",
      byteSize: 1, sha256: "0".repeat(64) }).returning();
    await db.insert(issueAttachments).values({ companyId: f.companyId, issueId: f.issueId, assetId: asset!.id,
      issueCommentId: withFile });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const queuedIds = (wake!.payload?._paperclipWakeContext as { wakeCommentIds: string[] }).wakeCommentIds;
    // Interrupt keeps its meaning for this queue: the first turn cannot take all of it.
    expect(await firstTurnTakesAllQueuedComments(db, { companyId: f.companyId, issueId: f.issueId, responsibleUserId: USER,
      commentIds: queuedIds })).toBe(false);
    const firstTurn = await claimFirstTurnQueuedInput(db, binding(f, f.runId));
    expect(firstTurn).toContain("text only");
    expect(firstTurn).not.toContain("see the attached screenshot");
    const run = await readRun(f.runId);
    expect(firstTurnClaimedCommentIds(run).has(withFile)).toBe(false);
    await accept(f, f.runId);
    // Still owed after the turn: release promotion delivers it with its file.
    expect([...await deliveredQueuedCommentIds(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      commentIds: [withFile] })]).toEqual([]);
  });
});
