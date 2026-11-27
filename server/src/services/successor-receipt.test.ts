// Reuses the designer Stop-retained and challenger's S/Q2b/Q3 constructor
// probes with actual normalized output + saved checkpoint evidence. Real PG;
// provider events/checkpoints are fixtures, not a live Pi/provider session.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issues } from "@paperclipai/db";
import { CONTINUATION_NOTHING_NEW_SCHEMA } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { buildExecutionContinuation, StaleExecutionContinuationError } from "./execution-continuation.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import * as continuedSession from "./native-runtime/continued-session.js";
import * as nativeContinuation from "./native-runtime/native-continuation.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { buildNativeModelEnvelope } from "../vendor/paperclip-runner/index.js";
import { publishContinuousNativeReply } from "./native-runtime/native-continuous-reply.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { buildPaperclipWakePayload, enrichWakeContextSnapshot } from "./heartbeat/run-preparation.js";

// Native history is an unloaded provider boundary here, not another server.
// Retained correlation IDs prove old input retention, not a new submission.
const retainedHistory = vi.hoisted(() => ({ ids: null as string[] | null }));
vi.mock("./native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native-runtime/native-session-executor.js")>();
  return { ...actual, readNativeSessionUserInputIds: async () => retainedHistory.ids };
});
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("retained successor receipt rule", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  const t0 = new Date("2026-01-01T00:00:00Z"), t1 = new Date("2026-01-01T00:05:00Z");
  const user = { authorType: "user", authorUserId: "local-board" } as const;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("successor-receipt-"); db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Receipt probes", issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", adapterType: "paperclip_runner" });
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function setup() {
    const s = { taskId: randomUUID(), sessionId: randomUUID(), runId: randomUUID(), originId: randomUUID(), commentId: randomUUID(), provider: `pi-${randomUUID()}` };
    await db.insert(issues).values({ id: s.taskId, companyId, title: "Receipt probe", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ id: s.originId, companyId, issueId: s.taskId, ...user, body: "STOPPED_ORIGINAL_REQUEST", createdAt: t0, updatedAt: t0 });
    return s;
  }
  type S = Awaited<ReturnType<typeof setup>>;
  const session = (s: S, seq: number, provider = s.provider) => ({ companyId, agentId, runId: s.runId, seq, sourceSeq: seq + 1,
    sourceEventId: `session-${seq}`, eventType: "session.started", payload: { prpEvent: { normalizedSessionId: s.sessionId, payload: { providerSessionId: provider } } } });
  const event = (s: S, seq: number, eventType: string, payload: Record<string, unknown> = {}, turnId = "turn-1") => ({ companyId, agentId, runId: s.runId,
    seq, sourceSeq: seq + 1, sourceEventId: `event-${seq}`, eventType, payload: { prpEvent: { normalizedSessionId: s.sessionId, turnId, payload } } });
  const checkpoint = (s: S, cursor: string | null = "99") => ({ sessionCheckpoint: { sessionId: s.sessionId, identity: { runId: s.runId, companyId, agentId, issueId: s.taskId, sessionId: s.sessionId }, providerSessionId: s.provider, cursor } });
  const first = (s: S) => buildExecutionContinuation({ db, companyId, issueId: s.taskId, agentId, context: { commentId: s.originId }, summary: null, exposeLowTrustRaw: false });
  const next = (s: S, id = s.commentId) => buildExecutionContinuation({ db, companyId, issueId: s.taskId, agentId, runId: randomUUID(), previousContextRunId: s.runId,
    nativeSessionId: s.sessionId, nativeProviderSessionId: s.provider, context: { commentId: id, commentIds: [id], wakeReason: "issue_commented" }, summary: null, exposeLowTrustRaw: false });
  function turn(s: S, wakePayload: Record<string, unknown>, road: "plain" | "JSON") {
    const issue = { id: s.taskId, identifier: null, title: "Receipt probe", description: null, workMode: "standard" };
    try {
      const execution = buildNativeExecutionInput({ companyId, runId: randomUUID(), agentId, provider: "pi_rpc", sessionContinuity: road === "plain" ? "continuous" : "paperclip",
        normalizedSessionId: s.sessionId, resumedSession: true, previousTurn: { runId: s.runId, task: issue }, issue, taskPrompt: "Keep working.", wakePayload,
        workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Continue", criteria: [{ id: "output", requirement: "Continue" }] } } });
      const envelope = buildNativeModelEnvelope(execution, { resumedSession: true });
      return { events: "events" in envelope ? String(envelope.events) : JSON.stringify(envelope), noop: null, continuationPrompt: execution.continuationPrompt };
    } catch (error) {
      if (!(error instanceof StaleExecutionContinuationError)) throw error;
      return { events: null, noop: error.continuationNothingNew, code: error.code };
    }
  }
  it.each(["succeeded", "running", "cancelled", "timed_out", "failed"])("saved committed output survives carrier status %s, including a person's Stop", async status => {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status,
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s), resultJson: { personStop: { returned: [s.originId] }, continuousReplies: { origin: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Committed work" })]);
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "No, do this instead.", createdAt: t1, updatedAt: t1 });
    const snapshot = await next(s);
    expect(snapshot.resumeDelta?.messages.map(message => message.id)).toEqual([s.commentId]);
    const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, "plain");
    expect(result.events).toBe("No, do this instead.");
    const jsonRoad = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, "JSON");
    expect(JSON.parse(jsonRoad.events!).messages.map((message: { id: string }) => message.id)).toEqual([s.commentId]);
    expect(jsonRoad.events).not.toContain("STOPPED_ORIGINAL_REQUEST");
    console.log("RECEIPT_ROW", JSON.stringify({ status, runId: s.runId, originId: s.originId, correctionId: s.commentId, delta: snapshot.resumeDelta, result, jsonRoad }));
  });
  it.each(["no output (pass-1 A)", "no checkpoint", "unloadable checkpoint", "checkpoint before output", "replaced generation", "output before turn", "other turn", "empty output", "tool output"])("keeps input owed: %s", async mode => {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: mode === "no output (pass-1 A)" ? "failed" : "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) },
      runnerProfileJson: mode === "no checkpoint" ? {} : mode === "unloadable checkpoint" ? { sessionCheckpoint: { ...checkpoint(s).sessionCheckpoint, sessionId: null } }
        : checkpoint(s, mode === "checkpoint before output" ? "2" : "99") });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, mode === "output before turn" ? 3 : 1, "turn.accepted"),
      ...(mode === "no output (pass-1 A)" ? [] : [event(s, 2, "item.completed", { kind: mode === "tool output" ? "toolCall" : "agentMessage", text: mode === "empty output" ? "" : "Logged output" }, mode === "other turn" ? "turn-2" : "turn-1")]),
      ...(mode === "replaced generation" ? [session(s, 4, "replacement-generation")] : [])]);
    const snapshot = await next(s, s.originId);
    expect(snapshot.resumeDelta?.messages.map(message => message.id)).toContain(s.originId);
    for (const road of ["plain", "JSON"] as const) expect(turn(s, { reason: "issue_commented", commentIds: [s.originId], executionContinuation: snapshot }, road).events).toContain("STOPPED_ORIGINAL_REQUEST");
    console.log("RECEIPT_OWED", JSON.stringify({ mode, runId: s.runId, originId: s.originId, delta: snapshot.resumeDelta }));
  });
  it.each(["plain", "JSON"] as const)("three person-comment cases on the %s road (hydrated Q2b and Q3)", async road => {
    for (const state of ["unseen", "seen answered", "seen unanswered"] as const) {
      const s = await setup(), queueId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "cancelled",
        contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s),
        resultJson: { continuousReplies: { origin: { questionCommentIds: [s.originId] }, ...(state === "seen answered" ? { steer: { questionCommentIds: [s.commentId], cursor: 5 } } : {}) },
          // Stop retires the origin, not the new steer whose three states this
          // row distinguishes. A returned steer would now be retired too.
          personStop: { returned: [s.originId] }, queuedSteeringAcknowledgements: { [s.commentId]: { status: "acknowledged", queueId, turnId: "turn-1", commentUpdatedAt: t1.toISOString() } } } });
      await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Original answered" }),
        ...(state === "unseen" ? [] : [{ ...event(s, 3, "item.completed", { kind: "steering_acknowledgement", status: "acknowledged" }), payload: { prpEvent: {
          normalizedSessionId: s.sessionId, turnId: "turn-1", itemId: `turn-1:steer:${s.commentId}`, payload: { kind: "steering_acknowledgement", status: "acknowledged" } } } }]),
        ...(state === "seen answered" ? [event(s, 4, "item.completed", { kind: "agentMessage", text: "Steer answered" })] : [])]);
      await db.insert(issueComments).values([{ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "STEER_TEXT $& exact", createdAt: t1, updatedAt: t1 },
        { id: randomUUID(), companyId, issueId: s.taskId, authorType: "agent", authorAgentId: agentId, createdByRunId: s.runId, body: "Own previous reply", createdAt: new Date(t1.getTime() + 1000) }]);
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "issue", reason: "issue_commented", status: "cancelled", createdAt: t1,
        payload: withQueuedCommentIdsInWakePayload({ issueId: s.taskId }, [s.commentId]) });
      const snapshot = await next(s);
      const wakeRunId = randomUUID();
      const { contextSnapshot } = enrichWakeContextSnapshot({ contextSnapshot: { executionContinuation: snapshot }, reason: "issue_commented",
        source: "automation", triggerDetail: "system", payload: { issueId: s.taskId, commentId: s.commentId, mutation: "comment" } });
      await db.insert(heartbeatRuns).values({ id: wakeRunId, companyId, agentId, status: "running", contextSnapshot });
      const [storedWake] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, wakeRunId));
      expect(storedWake!.context).toMatchObject({ wakeCommentId: s.commentId, wakeCommentIds: [s.commentId] });
      const wakePayload = await buildPaperclipWakePayload({ db, companyId, agentId, retainFullCommentBodies: true, contextSnapshot });
      if (!wakePayload) throw new Error("Person wake hydration must produce input");
      expect(wakePayload.commentIds).toEqual([s.commentId]);
      const result = turn(s, wakePayload, road);
      if (state === "unseen") expect(result.events).toContain("STEER_TEXT $& exact");
      if (state === "seen answered") {
        expect(result.code).toBe("continuation_nothing_new");
        expect(result.noop).toEqual({ schema: CONTINUATION_NOTHING_NEW_SCHEMA, namedCommentIds: [s.commentId], answeredCommentIds: [s.commentId], cause: "all_named_answered" });
      }
      if (state === "seen unanswered") {
        expect(result.events).toContain(`(id ${s.commentId})`); expect(result.events).toContain("Reply to the comment you received at");
        expect(result.events).not.toContain("STEER_TEXT"); expect(result.code).toBeUndefined();
      }
      console.log("RECEIPT_THREE_CASES", JSON.stringify({ road, state, runId: s.runId, wakeRunId, commentId: s.commentId,
        storedWakeIds: { wakeCommentId: storedWake!.context?.wakeCommentId, wakeCommentIds: storedWake!.context?.wakeCommentIds }, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each(["unseen", "seen answered", "seen unanswered", "stale receipt", "agent only", "named answered plus unnamed owed", "empty user body"] as const)("keeps unnamed prompt-only delta input owed: %s", async state => {
    const s = await setup(), snapshot = await first(s);
    const message = { ...snapshot.messages[0]!, body: state === "empty user body" ? "" : "UNNAMED_PERSON_TEXT $& exact" };
    if (state === "agent only") Object.assign(message, { authorType: "agent", authorId: agentId, body: "Own previous reply" });
    snapshot.messages = [message];
    snapshot.resumeDelta = { baseRunId: s.runId, messages: [message],
      receivedComments: ["seen answered", "seen unanswered", "stale receipt"].includes(state)
        ? [{ id: message.id, updatedAt: state === "stale receipt" ? t1.toISOString() : message.updatedAt,
          receivedAt: message.createdAt, answered: state !== "seen unanswered" }] : [] };
    const namedCommentIds: string[] = [];
    if (state === "named answered plus unnamed owed") {
      const named = { ...message, id: s.commentId, body: "ANSWERED_NAMED_TEXT" };
      snapshot.messages.push(named);
      snapshot.resumeDelta.receivedComments!.push({ id: named.id, updatedAt: named.updatedAt, receivedAt: named.createdAt, answered: true });
      namedCommentIds.push(named.id);
    }
    // Exercise the prompt-only projection/settlement contract explicitly. The
    // current selector sends unnamed deltas to JSON; do not widen that selector
    // just to reproduce this branch's missing-input failure.
    const selection = vi.spyOn(continuedSession, "decideNativeContinuation").mockReturnValueOnce({ continue: true, promptOnly: true });
    let result: ReturnType<typeof turn>;
    try { result = turn(s, { reason: "issue_commented", commentIds: namedCommentIds, executionContinuation: snapshot }, "plain"); }
    finally { selection.mockRestore(); }
    console.log("UNNAMED_DELTA_ROW", JSON.stringify({ state, promptOnly: true, selectorStubbed: true, runId: s.runId, messageId: message.id, delta: snapshot.resumeDelta, result }));
    if (state === "seen answered") {
      expect(result.code).toBe("continuation_nothing_new");
      expect(result.noop).toEqual({ schema: CONTINUATION_NOTHING_NEW_SCHEMA, namedCommentIds: [message.id], answeredCommentIds: [message.id], cause: "all_named_answered" });
    } else if (state === "agent only") {
      expect(result.code).toBe("continuation_nothing_new");
      expect(result.noop).toEqual({ schema: CONTINUATION_NOTHING_NEW_SCHEMA, namedCommentIds: [], answeredCommentIds: [], cause: "own_reply_only" });
    } else {
      expect(result.code).toBeUndefined();
      if (state === "seen unanswered") {
        expect(result.events).toBe(`Reply to the comment you received at ${message.createdAt} (id ${message.id}).`);
        expect(result.events).not.toContain(message.body);
      } else if (state !== "empty user body") {
        expect(result.events).toBe(message.body);
      }
      expect(result.events).not.toContain("ANSWERED_NAMED_TEXT");
    }
  });
  it.each(["missing", "before receipt"])("uses only the selected checkpoint, not another run's covering save: %s", async mode => {
    const s = await setup(), envelope = await first(s);
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope }, runnerProfileJson: checkpoint(s),
      resultJson: { continuousReplies: { reply: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Answered" })]);
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope }, runnerProfileJson: mode === "missing" ? {} : checkpoint(selected, "2"),
      resultJson: { continuousReplies: { selectedReply: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(selected, 0), event(selected, 1, "turn.accepted"),
      event(selected, 2, "item.completed", { kind: "agentMessage", text: "Selected run output after its saved cursor" })]);
    const snapshot = await next(selected, s.originId);
    expect(snapshot.resumeDelta?.messages.map(message => message.id)).toContain(s.originId);
    for (const road of ["plain", "JSON"] as const) expect(turn(selected, { reason: "issue_commented", commentIds: [s.originId], executionContinuation: snapshot }, road).events).toContain("STOPPED_ORIGINAL_REQUEST");
    console.log("SELECTED_CHECKPOINT_ROW", JSON.stringify({ mode, selected: selected.runId, other: s.runId, delta: snapshot.resumeDelta }));
  });
  async function acknowledgedSteer(status: string, after: "progress" | "tool" | "comment" | "none" | "compaction" | "pi compaction") {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status,
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s),
      resultJson: { continuousReplies: { origin: { questionCommentIds: [s.originId] } }, queuedSteeringAcknowledgements: { [s.commentId]: { status: "acknowledged", turnId: "turn-1", commentUpdatedAt: t1.toISOString() } } } });
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "PERSON_STEER_OWED", createdAt: t1, updatedAt: t1 });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Origin reply" }),
      { ...event(s, 3, "item.completed"), payload: { prpEvent: { normalizedSessionId: s.sessionId, turnId: "turn-1", itemId: `turn-1:steer:${s.commentId}`, payload: { kind: "steering_acknowledgement", status: "acknowledged" } } } },
      ...(after === "progress" || after === "tool" ? [event(s, 4, "item.completed", { kind: after === "tool" ? "toolCall" : "agentMessage", text: "Unrelated progress only" })] : []),
      ...(after === "compaction" ? [event(s, 4, "context.compacted", { schema: "paperclip.context.compacted.v1", compactionId: "compact-1", sameSession: true })] : []),
      ...(after === "pi compaction" ? [event(s, 4, "provider.notice.recorded", { schema: "paperclip.provider.notice.v1", category: "pi.compaction_end", scope: "session", summary: "Compacted" })] : [])]);
    if (after === "comment") await db.insert(issueComments).values({ companyId, issueId: s.taskId, authorType: "agent", authorAgentId: agentId, createdByRunId: s.runId, body: "An uncorrelated task comment" });
    return { s, snapshot: await next(s) };
  }
  it.each(["inherited only", "reply instruction", "revision text", "provider explicit"] as const)("real publisher only answers carried or explicit person input: %s", async mode => {
    const { s, snapshot } = await acknowledgedSteer("failed", "progress");
    const child = { ...s, runId: randomUUID() };
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, agentId));
    const instruction = `Reply to the comment you received at ${t1.toISOString()} (id ${s.commentId}).`;
    const prompt = JSON.stringify({ childResults: [{ id: "child-build", summary: "Child build passed" }],
      ...(mode === "reply instruction" ? { replyInstructions: [instruction] } : {}),
      ...(mode === "revision text" ? { messages: [{ id: s.commentId, updatedAt: t1.toISOString(), body: "PERSON_STEER_OWED" }] } : {}) });
    await db.insert(heartbeatRuns).values({ id: child.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId,
      nativeSessionId: s.sessionId, status: "running", contextSnapshot: { issueId: s.taskId, executionContinuation: snapshot },
      runnerProfileJson: { ...checkpoint(child), nativeExecutionInput: { continuationPrompt: prompt } } });
    await db.update(issues).set({ executionRunId: child.runId }).where(eq(issues.id, s.taskId));
    const finalEvent = { runId: child.runId, normalizedSessionId: s.sessionId, turnId: "child-turn", sourceEventId: "child-final", itemId: "child-final",
      eventType: "item.completed" as const, payload: { kind: "agentMessage", channel: "final", text: "Child build passed; unrelated to the person's question",
        ...(mode === "provider explicit" ? { answers: [s.commentId] } : {}) } };
    await db.insert(heartbeatRunEvents).values([session(child, 0), event(child, 1, "turn.accepted", {}, "child-turn"),
      { ...event(child, 2, "item.completed"), payload: { prpEvent: finalEvent } }]);
    retainedHistory.ids = [s.commentId];
    try {
      await publishContinuousNativeReply({ db, cursor: 2, execution: { binding: { companyId, agentId, issueId: s.taskId, runId: child.runId }, provider: { kind: "pi_rpc" } }, event: finalEvent });
    } finally { retainedHistory.ids = null; }
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, child.runId));
    const ledger = saved.resultJson?.continuousReplies as Record<string, { questionCommentIds: string[]; answerAttribution?: string }>;
    const nextSnapshot = await next(child);
    const receipt = nextSnapshot.resumeDelta?.receivedComments?.find(receipt => receipt.id === s.commentId);
    const named = turn(child, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: nextSnapshot }, "JSON");
    console.log("PUBLISHER_ATTRIBUTION_ROW", JSON.stringify({ mode, runId: child.runId, commentId: s.commentId, prompt, ledger, receipt, named }));
    expect(ledger["child-final"].questionCommentIds).toEqual(mode === "inherited only" ? [] : [s.commentId]);
    expect(receipt?.answered).toBe(mode !== "inherited only");
    if (mode === "inherited only") {
      expect(named.code).toBeUndefined();
      expect(named.events?.split(instruction).length).toBe(2);
      expect(named.events).not.toContain("PERSON_STEER_OWED");
      // Old deployments saved an undifferentiated server-inferred ledger.
      // Reconciliation must reject it too, not only prevent new bad writes.
      for (const answerAttribution of [undefined, "server_inferred"]) {
        const legacy = { ...ledger["child-final"], questionCommentIds: [s.commentId], answerAttribution };
        await db.update(heartbeatRuns).set({ resultJson: { ...saved.resultJson, continuousReplies: { "child-final": legacy } } }).where(eq(heartbeatRuns.id, child.runId));
        const reconciled = await next(child);
        const reply = turn(child, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: reconciled }, "JSON");
        console.log("LEGACY_INFERRED_LEDGER_ROW", JSON.stringify({ runId: child.runId, answerAttribution: answerAttribution ?? "absent", receipt: reconciled.resumeDelta?.receivedComments?.find(r => r.id === s.commentId), reply }));
        expect(reconciled.resumeDelta?.receivedComments?.find(r => r.id === s.commentId)?.answered).toBe(false);
        expect(reply.events?.split(instruction).length).toBe(2);
      }
    } else expect(named.code).toBe("continuation_nothing_new");
  });
  it("rejects a legacy inferred ledger backed only by an ACK in another turn", async () => {
    const { s } = await acknowledgedSteer("succeeded", "progress");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...checkpoint(s), nativeExecutionInput: {
      continuationPrompt: JSON.stringify({ messages: [], childResults: [{ id: "child", summary: "Unrelated child result" }] }),
    } }, resultJson: { ...run.resultJson, continuousReplies: { origin: { questionCommentIds: [s.originId] },
      child: { questionCommentIds: [s.commentId], cursor: 6, turnId: "child-turn" } } } }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(heartbeatRunEvents).values([event(s, 5, "turn.accepted", {}, "child-turn"),
      event(s, 6, "item.completed", { kind: "agentMessage", channel: "final", text: "Unrelated child result" }, "child-turn")]);
    const snapshot = await next(s);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, "JSON");
    console.log("OTHER_TURN_INFERRED_ROW", JSON.stringify({ runId: s.runId, commentId: s.commentId, receipt, result }));
    expect(receipt?.answered).toBe(false);
    expect(result.events?.split(`Reply to the comment you received at ${t1.toISOString()} (id ${s.commentId}).`).length).toBe(2);
  });
  it.each([
    ["failed", "progress"], ["timed_out", "progress"], ["succeeded", "progress"], ["failed", "tool"], ["failed", "comment"], ["succeeded", "none"],
  ] as const)("keeps ACK'd input unanswered without attribution: %s / %s", async (status, after) => {
    const { s, snapshot } = await acknowledgedSteer(status, after);
    expect(snapshot.resumeDelta?.receivedComments?.find(receipt => receipt.id === s.commentId)?.answered).toBe(false);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      expect(result.code).toBeUndefined();
      expect(result.events).toContain(`Reply to the comment you received at ${t1.toISOString()} (id ${s.commentId}).`);
      expect(result.events).not.toContain("PERSON_STEER_OWED");
      console.log("UNANSWERED_ROW", JSON.stringify({ status, after, road, commentId: s.commentId, result }));
    }
  });
  it("sends the text after compaction rather than a reference to dropped context", async () => {
    const { s, snapshot } = await acknowledgedSteer("failed", "compaction");
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      expect(result.events).toContain("PERSON_STEER_OWED");
      expect(result.events).not.toContain("Reply to the comment you received at");
    }
  });
  it("sends the text after Pi's provider.notice.recorded compaction receipt", async () => {
    const { s, snapshot } = await acknowledgedSteer("failed", "pi compaction");
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      expect(result.events).toContain("PERSON_STEER_OWED");
      expect(result.events).not.toContain("Reply to the comment you received at");
    }
  });
  it.each(["issue_reopened_via_comment", "issue_continuation_needed", "resumeIntent", "followUpRequested", "reopenedFrom"])("never swallows independent reopen/resume work: %s", async intent => {
    const s = await setup(), snapshot = await first(s), message = snapshot.messages[0]!;
    snapshot.resumeDelta = { baseRunId: s.runId, messages: [], receivedComments: [{ id: message.id, updatedAt: message.updatedAt, receivedAt: message.createdAt, answered: true }] };
    const wake = { reason: intent.startsWith("issue_") ? intent : "issue_commented", commentIds: [s.originId], executionContinuation: snapshot,
      ...(!intent.startsWith("issue_") ? { [intent]: intent === "reopenedFrom" ? "done" : true } : {}) };
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, wake, road);
      expect(result.code).toBeUndefined(); expect(result.events).not.toBeNull();
      console.log("REOPEN_ROW", JSON.stringify({ intent, road, result }));
    }
  });
  it("uses the real runner snapshot serializer's string cursor and treats its null cursor as no coverage", async () => {
    const { HarnessDriverBackend } = await import("../../../packages/paperclip-runner/dist/backends/harness-driver-backend.js");
    const s = await setup();
    let lastSourceSequence: number | undefined;
    const backend = new HarnessDriverBackend({ descriptor: async () => ({ kind: "pi_rpc", displayName: "Serializer probe", version: "1", capabilities: { resume: true, typedEvents: true, steering: true, interruption: true, structuredResult: true } }),
      openSession: async () => ({ ids: () => ({ driverSessionId: "driver-probe", providerSessionId: s.provider }), async *events() {},
        startTurn: async () => ({ turnId: "turn-1" }), close: async () => {},
        snapshot: async () => ({ driverKind: "pi_rpc", driverSessionId: "driver-probe", providerSessionId: s.provider, lastSourceSequence }) }) });
    const runner = await backend.openSession({ identity: { companyId, agentId, issueId: s.taskId, runId: s.runId, sessionId: s.sessionId } });
    const empty = await runner.snapshot(); expect(empty.cursor).toBeNull();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: { sessionCheckpoint: JSON.parse(JSON.stringify(empty)) },
      resultJson: { continuousReplies: { origin: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Real serializer carrier" })]);
    expect((await next(s, s.originId)).resumeDelta?.messages.map(message => message.id)).toContain(s.originId);
    lastSourceSequence = 3;
    const saved = await runner.snapshot(); expect(saved.cursor).toBe("3");
    await db.update(heartbeatRuns).set({ runnerProfileJson: { sessionCheckpoint: JSON.parse(JSON.stringify(saved)) } }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "NEW_COMMENT_AFTER_SUCCEEDED", createdAt: t1, updatedAt: t1 });
    const snapshot = await next(s);
    expect(snapshot.resumeDelta?.messages.map(message => message.id)).toEqual([s.commentId]);
    for (const road of ["plain", "JSON"] as const) expect(turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road).events).not.toContain("STOPPED_ORIGINAL_REQUEST");
    console.log("REAL_SERIALIZER_ROW", JSON.stringify({ cursorType: typeof saved.cursor, empty, saved, delta: snapshot.resumeDelta }));
    await runner.close({ reason: "probe complete" });
  });
  // Reuses the independent C56E designer's RED, including the failed v2
  // carrier's unrelated progress (not answer attribution).
  it("qualifies an answer by the carried revision, never by comment id alone", async () => {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s),
      resultJson: { continuousReplies: { answer: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Answered v1" })]);
    await db.update(issueComments).set({ body: "EDITED_QUESTION_NEEDS_NEW_ANSWER", updatedAt: new Date("2026-01-01T00:10:00Z") }).where(eq(issueComments.id, s.originId));
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(selected), resultJson: {} });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted"), event(selected, 12, "item.completed", { kind: "agentMessage", text: "Unrelated carrier progress, not a reply" })]);
    const snapshot = await next(selected, s.originId);
    expect(snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.originId)).toMatchObject({ answered: false, updatedAt: "2026-01-01T00:10:00.000Z" });
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(selected, { reason: "issue_commented", commentIds: [s.originId], executionContinuation: snapshot }, road);
      expect(result.code).toBeUndefined(); expect(result.events).toContain(`(id ${s.originId})`);
      expect(result.noop?.answeredCommentIds ?? []).not.toContain(s.originId);
      console.log("REVISION_ANSWER_ROW", JSON.stringify({ road, oldRun: s.runId, selected: selected.runId, delta: snapshot.resumeDelta, result }));
    }
  });
  it("qualifies answers within a held run by publication cursor, not a later edit's ACK", async () => {
    const s = await setup(), initial = await first(s), changedAt = new Date("2026-01-01T00:10:00Z");
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: initial }, runnerProfileJson: checkpoint(s),
      resultJson: { continuousReplies: { old: { questionCommentIds: [s.originId], cursor: 2 } },
        queuedSteeringAcknowledgements: { [s.originId]: { status: "acknowledged", turnId: "turn-1", afterEventSeq: 4, commentUpdatedAt: changedAt.toISOString() } } } });
    await db.update(issueComments).set({ body: "EDITED_HELD_QUESTION", updatedAt: changedAt }).where(eq(issueComments.id, s.originId));
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", channel: "final", text: "Answer v1" }),
      { ...event(s, 4, "item.completed"), payload: { prpEvent: { normalizedSessionId: s.sessionId, turnId: "turn-1", itemId: `turn-1:steer:${s.originId}`, payload: { kind: "steering_acknowledgement", status: "acknowledged" } } } },
      event(s, 5, "item.completed", { kind: "agentMessage", channel: "commentary", text: "Unrelated progress after edited question" })]);
    const snapshot = await next(s, s.originId);
    expect(snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.originId)?.answered).toBe(false);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.originId], executionContinuation: snapshot }, road);
      expect(result.code).toBeUndefined(); expect(result.events).toContain(`(id ${s.originId})`);
      console.log("HELD_REVISION_ANSWER_ROW", JSON.stringify({ road, runId: s.runId, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each([true, false])("does not revive a person's stopped input (returned ledger: %s)", async returned => {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "cancelled",
      contextSnapshot: { issueId: s.taskId, wakeCommentIds: [s.originId], executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s),
      resultJson: { personStop: { requestedAt: t1.toISOString(), ...(returned ? { returned: [s.originId] } : {}) } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Work before Stop, no answer" })]);
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "No, do this instead.", createdAt: t1, updatedAt: t1 });
    const snapshot = await next(s);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      if (road === "plain") expect(result.events).toBe("No, do this instead.");
      else expect(JSON.parse(result.events!).messages.map((m: { id: string }) => m.id)).toEqual([s.commentId]);
      expect(result.events).not.toContain(s.originId); expect(result.events).not.toContain("STOPPED_ORIGINAL_REQUEST");
      console.log("STOP_NO_REVIVAL_ROW", JSON.stringify({ returned, road, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each(["never accepted", "accepted without output", "saved output"])("Stop on the first carrier retires only its request: %s", async mode => {
    const s = await setup(), earlierId = randomUUID(), requestId = randomUUID();
    await db.insert(issueComments).values([
      { id: earlierId, companyId, issueId: s.taskId, ...user, body: "EARLIER_NEVER_HELD", createdAt: new Date(t0.getTime() + 1000), updatedAt: new Date(t0.getTime() + 1000) },
      { id: requestId, companyId, issueId: s.taskId, ...user, body: "WITHDRAWN_REQUEST", createdAt: new Date(t0.getTime() + 2000), updatedAt: new Date(t0.getTime() + 2000) },
    ]);
    const initial = await buildExecutionContinuation({ db, companyId, issueId: s.taskId, agentId,
      context: { commentId: requestId }, summary: null, exposeLowTrustRaw: false });
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "cancelled",
      contextSnapshot: { issueId: s.taskId, wakeCommentId: requestId, wakeCommentIds: [requestId], executionContinuation: initial },
      runnerProfileJson: mode === "never accepted" ? checkpoint(s, null) : checkpoint(s),
      resultJson: { personStop: { requestedAt: t1.toISOString() } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0),
      ...(mode === "never accepted" ? [] : [event(s, 1, "turn.accepted")]),
      ...(mode === "saved output" ? [event(s, 2, "item.completed", { kind: "agentMessage", text: "Saved work before Stop" })] : [])]);
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "No, do this instead.", createdAt: t1, updatedAt: t1 });
    const snapshot = await next(s);
    const ids = snapshot.resumeDelta?.messages.map(m => m.id);
    expect(ids).toEqual(mode === "saved output" ? [s.commentId] : [s.originId, earlierId, s.commentId]);
    expect(snapshot.resumeDelta?.receivedComments?.filter(r => r.stopped).map(r => r.id)).toEqual([requestId]);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      expect(result.events).not.toContain("WITHDRAWN_REQUEST");
      expect(result.events).toContain("No, do this instead.");
      if (mode !== "saved output") {
        expect(result.events).toContain("EARLIER_NEVER_HELD");
        expect(result.events).toContain("STOPPED_ORIGINAL_REQUEST");
      }
      expect(result.events).not.toContain("Reply to the comment you received at");
      console.log("FIRST_STOP_ROW", JSON.stringify({ mode, road, runId: s.runId, requestId, earlierId, delta: snapshot.resumeDelta, result }));
    }
  });
  it("does not widen a named Stop to other still-owed delta messages", async () => {
    const s = await setup(), correctionId = randomUUID();
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "WITHDRAWN_DELTA_REQUEST", createdAt: t1, updatedAt: t1 });
    const initial = await first(s);
    initial.resumeDelta = { baseRunId: randomUUID(), messages: initial.messages };
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "cancelled",
      contextSnapshot: { issueId: s.taskId, wakeCommentIds: [s.commentId], executionContinuation: initial,
        firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId: randomUUID(), wakeupRequestIds: [], commentIds: [s.originId], claimedAt: t0.toISOString() } },
      runnerProfileJson: checkpoint(s, null),
      resultJson: { personStop: { requestedAt: new Date(t1.getTime() + 1000).toISOString() } } });
    await db.insert(heartbeatRunEvents).values(session(s, 0));
    await db.insert(issueComments).values({ id: correctionId, companyId, issueId: s.taskId, ...user, body: "CORRECTION_AFTER_DELTA_STOP", createdAt: new Date(t1.getTime() + 2000), updatedAt: new Date(t1.getTime() + 2000) });
    const snapshot = await next(s, correctionId);
    expect(snapshot.resumeDelta?.messages.map(m => m.id)).toEqual([s.originId, correctionId]);
    expect(snapshot.resumeDelta?.receivedComments?.filter(r => r.stopped).map(r => r.id)).toEqual([s.commentId]);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [correctionId], executionContinuation: snapshot }, road);
      expect(result.events).toContain("STOPPED_ORIGINAL_REQUEST"); expect(result.events).toContain("CORRECTION_AFTER_DELTA_STOP");
      expect(result.events).not.toContain("WITHDRAWN_DELTA_REQUEST");
      console.log("DELTA_STOP_ROW", JSON.stringify({ road, runId: s.runId, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each(["no output", "output after checkpoint", "tool only"])("carries inherited receipts through a selected checkpoint chain: %s", async mode => {
    const s = await setup();
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded", createdAt: t0,
      contextSnapshot: { issueId: s.taskId, executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s, "3"), resultJson: { continuousReplies: { origin: { questionCommentIds: [s.originId] } } } });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Origin answered" })]);
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "NEW1_BODY", createdAt: t1, updatedAt: t1 });
    const envelope = await next(s), selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed", createdAt: t1,
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope }, runnerProfileJson: checkpoint(selected, mode === "tool only" ? "13" : "3") });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2"),
      ...(mode === "no output" ? [] : [event(selected, 12, "item.completed", { kind: mode === "tool only" ? "toolCall" : "agentMessage", text: "Selected output" }, "turn-2")])]);
    const newId = randomUUID();
    await db.insert(issueComments).values({ id: newId, companyId, issueId: s.taskId, ...user, body: "NEW2_BODY", createdAt: new Date(t1.getTime() + 1000) });
    const snapshot = await next(selected, newId);
    expect(snapshot.resumeDelta?.messages.map(m => m.id)).not.toContain(s.originId);
    expect(snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.originId)?.answered).toBe(true);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(selected, { reason: "issue_commented", commentIds: [newId], executionContinuation: snapshot }, road);
      expect(result.events).not.toContain("STOPPED_ORIGINAL_REQUEST"); expect(result.events).toContain("NEW2_BODY");
      console.log("CHECKPOINT_CHAIN_ROW", JSON.stringify({ mode, road, source: s.runId, selected: selected.runId, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each([true, false])("only requests a reply to new input after a full-history carrier (attributed: %s)", async attributed => {
    const s = await setup();
    const historyIds = Array.from({ length: 5 }, () => randomUUID());
    await db.insert(issueComments).values(historyIds.map((id, i) => ({ id, companyId, issueId: s.taskId, ...user,
      body: `OLD_HISTORY_${i}`, createdAt: new Date(t0.getTime() + (i + 1) * 1000), updatedAt: new Date(t0.getTime() + (i + 1) * 1000) })));
    await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, wakeCommentIds: [s.originId], executionContinuation: await first(s) }, runnerProfileJson: checkpoint(s),
      resultJson: attributed ? { continuousReplies: { first: { questionCommentIds: [s.originId] } } } : {} });
    await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", channel: "final", text: "First reply" })]);
    await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "Thanks, one more thing.", createdAt: t1, updatedAt: t1 });
    const snapshot = await next(s);
    expect(snapshot.resumeDelta?.messages.map(m => m.id)).toEqual([s.commentId]);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
      expect(result.events).toContain("Thanks, one more thing.");
      expect(result.events).not.toContain("Reply to the comment you received at");
      for (const id of historyIds) expect(result.events).not.toContain(id);
      console.log("NEW_AFTER_HISTORY_ROW", JSON.stringify({ attributed, road, delta: snapshot.resumeDelta, result }));
    }
  });
  it.each(["plain", "JSON"] as const)("keeps a reply owed after an accepted request fails before output on %s", async road => {
    const { s, snapshot: envelope } = await acknowledgedSteer("failed", "progress");
    const initial = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: envelope }, road);
    expect(initial.events).toContain(`(id ${s.commentId})`);
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope },
      runnerProfileJson: { ...checkpoint(selected), nativeExecutionInput: { continuationPrompt: initial.continuationPrompt } } });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2")]);
    const snapshot = await next(selected, s.commentId);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    expect(receipt?.answered).toBe(false); expect(receipt?.replyRequested).not.toBe(true);
    const result = turn(selected, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
    expect(result.events?.match(/Reply to the comment you received at/g)).toHaveLength(1);
    expect(result.events).toContain(`(id ${s.commentId})`);
    console.log("RETRY_REPLY_ROW", JSON.stringify({ road, receipt, initial, result }));
  });
  it.each(["plain", "JSON"] as const)("child-results-only output never answers an uninstructed person revision on %s", async road => {
    const { s, snapshot: envelope } = await acknowledgedSteer("failed", "progress");
    const child = turn(s, { reason: "issue_children_completed", commentIds: [], childIssueSummaries: [{ id: "child", status: "done", summary: "Child build passed" }], executionContinuation: envelope }, road);
    expect(JSON.parse(child.continuationPrompt!)).toMatchObject({ messages: [], childResults: [{ id: "child", summary: "Child build passed" }] });
    expect(child.continuationPrompt).not.toContain("PERSON_STEER_OWED");
    expect(child.continuationPrompt).not.toContain("replyInstructions");
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope },
      runnerProfileJson: { ...checkpoint(selected), nativeExecutionInput: { continuationPrompt: child.continuationPrompt } }, resultJson: {} });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2"),
      event(selected, 12, "item.completed", { kind: "agentMessage", channel: "final", text: "Child build passed; unrelated to the person's question." }, "turn-2")]);
    const snapshot = await next(selected, s.commentId);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    const result = turn(selected, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
    console.log("CHILD_FALSE_ANSWER_ROW", JSON.stringify({ road, sourceRun: s.runId, selectedRun: selected.runId, child, receipt, result }));
    expect(receipt?.answered).toBe(false); expect(receipt?.replyRequested).not.toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.events?.match(/Reply to the comment you received at/g)).toHaveLength(1);
    expect(result.events).toContain(`(id ${s.commentId})`);
  });
  it.each(["plain", "JSON"] as const)("a bootstrap carrier does not claim it sent a reply instruction on %s", async road => {
    const { s, snapshot: envelope } = await acknowledgedSteer("failed", "progress");
    const bootstrap = turn(s, { reason: "heartbeat_timer", commentIds: [], executionContinuation: envelope }, road);
    expect(bootstrap.continuationPrompt).toBeNull();
    expect(bootstrap.events).not.toContain("Reply to the comment you received at");
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope },
      runnerProfileJson: { ...checkpoint(selected), nativeExecutionInput: { continuationPrompt: bootstrap.continuationPrompt } } });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2"),
      event(selected, 12, "item.completed", { kind: "agentMessage", channel: "final", text: "Unrelated bootstrap output" }, "turn-2")]);
    const snapshot = await next(selected, s.commentId);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    expect(receipt?.answered).toBe(false); expect(receipt?.replyRequested).not.toBe(true);
    const result = turn(selected, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
    expect(result.events?.match(/Reply to the comment you received at/g)).toHaveLength(1);
    console.log("BOOTSTRAP_REPLY_ROW", JSON.stringify({ road, receipt, bootstrap, result }));
  });
  it("recognizes a sent reply instruction in the legacy unclaimed preamble plus JSON", async () => {
    const { s, snapshot: envelope } = await acknowledgedSteer("failed", "progress");
    const initial = turn(s, { reason: "issue_continuation_needed", nativeTaskUnclaimed: true,
      commentIds: [s.commentId], executionContinuation: envelope }, "plain");
    expect(initial.continuationPrompt).toContain("without an accepted completion report");
    expect(initial.continuationPrompt).toContain(`(id ${s.commentId})`);
    expect(initial.continuationPrompt).not.toContain("PERSON_STEER_OWED");
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope },
      runnerProfileJson: { ...checkpoint(selected), nativeExecutionInput: { continuationPrompt: initial.continuationPrompt } }, resultJson: {} });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2"),
      event(selected, 12, "item.completed", { kind: "agentMessage", channel: "final", text: "Replied to the unclaimed carried reference" }, "turn-2")]);
    const snapshot = await next(selected, s.commentId);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    const repeated = turn(selected, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, "plain");
    console.log("UNCLAIMED_REPLY_ONCE_ROW", JSON.stringify({ sourceRun: s.runId, selectedRun: selected.runId, initial, receipt, repeated }));
    expect(receipt?.answered).toBe(true);
    expect(repeated.noop?.answeredCommentIds).toEqual([s.commentId]);
    expect(repeated.events).toBeNull();
  });
  it.each(["reply", "no output", "progress only"])("sends a reply instruction once and clears a carried instruction after %s", async mode => {
    const { s, snapshot: envelope } = await acknowledgedSteer("failed", "progress");
    const initial = turn(s, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: envelope }, "plain");
    expect(initial.events).toContain(`(id ${s.commentId})`);
    const selected = { ...s, runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: selected.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: mode === "reply" ? "succeeded" : "failed",
      contextSnapshot: { issueId: s.taskId, executionContinuation: envelope },
      runnerProfileJson: { ...checkpoint(selected), nativeExecutionInput: { continuationPrompt: initial.continuationPrompt } }, resultJson: {} });
    await db.insert(heartbeatRunEvents).values([session(selected, 10), event(selected, 11, "turn.accepted", {}, "turn-2"),
      ...(mode === "no output" ? [] : [event(selected, 12, "item.completed", { kind: "agentMessage", channel: mode === "reply" ? "final" : "commentary", text: mode === "reply" ? "Replied to the carried reference" : "Unrelated progress only" }, "turn-2")])]);
    const snapshot = await next(selected, s.commentId);
    const receipt = snapshot.resumeDelta?.receivedComments?.find(r => r.id === s.commentId);
    expect(receipt?.answered).toBe(mode === "reply");
    for (const road of ["plain", "JSON"] as const) {
      const empty = turn(selected, { reason: "issue_commented", commentIds: [], executionContinuation: snapshot }, road);
      expect(empty.noop?.cause).toBe("empty_system_wake");
      const child = turn(selected, { reason: "issue_children_completed", commentIds: [], executionContinuation: snapshot }, road);
      expect(child.code).toBeUndefined(); expect(child.events).not.toContain("replyInstructions");
      expect(child.events!.length).toBeGreaterThan(300);
      if (mode === "reply") {
        const repeated = turn(selected, { reason: "issue_commented", commentIds: [s.commentId], executionContinuation: snapshot }, road);
        expect(repeated.noop?.answeredCommentIds).toEqual([s.commentId]);
      }
      console.log("REPLY_ONCE_ROW", JSON.stringify({ mode, road, delta: snapshot.resumeDelta, empty, child }));
    }
    const newId = randomUUID();
    await db.insert(issueComments).values({ id: newId, companyId, issueId: s.taskId, ...user, body: "ONLY_NEW_PERSON_TEXT" });
    const later = await next(selected, newId);
    for (const road of ["plain", "JSON"] as const) {
      const result = turn(selected, { reason: "issue_commented", commentIds: [newId], executionContinuation: later }, road);
      expect(result.events).toContain("ONLY_NEW_PERSON_TEXT");
      if (mode === "no output") {
        expect(result.events).toContain(`(id ${s.commentId})`);
        expect(result.events?.match(/Reply to the comment you received at/g)).toHaveLength(1);
      } else expect(result.events).not.toContain(`(id ${s.commentId})`);
    }
  });
  it("keeps pass-4 delivered-input behavior for an actual null-provider-id serializer", async () => {
    const { HarnessDriverBackend } = await import("../../../packages/paperclip-runner/dist/backends/harness-driver-backend.js");
    const s = await setup(), retainedId = randomUUID();
    await db.insert(issueComments).values({ id: retainedId, companyId, issueId: s.taskId, ...user, body: "RETAINED_NON_ORIGIN_HISTORY", createdAt: new Date(t0.getTime() + 1000) });
    const backend = new HarnessDriverBackend({ descriptor: async () => ({ kind: "openai_dot_mcp", displayName: "Nullable provider probe", version: "1", capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true } }),
      openSession: async () => ({ ids: () => ({ driverSessionId: "dot-driver", providerSessionId: null }), async *events() {}, startTurn: async () => ({ turnId: "turn-1" }), close: async () => {},
        snapshot: async () => ({ driverKind: "openai_dot_mcp", driverSessionId: "dot-driver", providerSessionId: null, lastSourceSequence: 3 }) }) });
    const runner = await backend.openSession({ identity: { companyId, agentId, issueId: s.taskId, runId: s.runId, sessionId: s.sessionId } });
    try {
      const saved = JSON.parse(JSON.stringify(await runner.snapshot()));
      expect(saved.providerSessionId).toBeNull(); expect(saved.cursor).toBe("3");
      const prior = await first(s);
      await db.insert(heartbeatRuns).values({ id: s.runId, companyId, agentId, runtimeMode: "native", nativeIssueId: s.taskId, nativeSessionId: s.sessionId, status: "succeeded",
        contextSnapshot: { issueId: s.taskId, executionContinuation: prior }, runnerProfileJson: { sessionCheckpoint: saved } });
      await db.insert(heartbeatRunEvents).values([session(s, 0), event(s, 1, "turn.accepted"), event(s, 2, "item.completed", { kind: "agentMessage", text: "Prior output" })]);
      await db.insert(issueComments).values({ id: s.commentId, companyId, issueId: s.taskId, ...user, body: "NEW_NULL_PROVIDER_INPUT", createdAt: t1, updatedAt: t1 });
      const snapshot = await buildExecutionContinuation({ db, companyId, issueId: s.taskId, agentId, previousContextRunId: s.runId, nativeSessionId: s.sessionId,
        nativeProviderSessionId: null, context: { commentId: s.commentId, executionContinuation: prior }, summary: null, exposeLowTrustRaw: false });
      expect(snapshot.resumeDelta?.messages.map(m => m.id)).toEqual([s.originId, s.commentId]);
      expect(snapshot.resumeDelta?.receivedComments).toBeUndefined();
      console.log("NULL_PROVIDER_PASS4_ROW", JSON.stringify({ saved, delta: snapshot.resumeDelta, limitation: "Pass-4 diff, not generation-qualified receipt coverage; the origin is still replayed" }));
    } finally { await runner.close({ reason: "probe complete" }); }
  });
  it("does not call an unproved named user comment nothing-new on either road", async () => {
    const s = await setup(), snapshot = await first(s);
    snapshot.resumeDelta = { baseRunId: s.runId, messages: [] };
    for (const road of ["plain", "JSON"] as const) expect(turn(s, { reason: "issue_commented", commentIds: [s.originId], executionContinuation: snapshot }, road).events).toContain("STOPPED_ORIGINAL_REQUEST");
  });
  it.each(["issue_continuation_needed", "issue_status_changed", "issue_assigned", "issue_blockers_resolved", "retry_failed_run", "heartbeat_timer", "issue_monitor_due"])("never settles automatic work as an empty wake: %s", async reason => {
    const s = await setup(), snapshot = await first(s);
    snapshot.resumeDelta = { baseRunId: s.runId, messages: [] };
    for (const road of ["plain", "JSON"] as const) {
      const wake = { reason, commentIds: [], executionContinuation: snapshot };
      const current = turn(s, wake, road);
      expect(current.code).toBeUndefined(); expect(current.events).not.toBeNull();
      // The next delta-road consumer can return empty text for these reasons.
      // Exercise that constructor boundary now, without widening routing here.
      const projection = vi.spyOn(nativeContinuation, "buildNativeContinuationPrompt").mockReturnValueOnce(road === "plain" ? "" : '{"messages":[]}');
      const selection = vi.spyOn(continuedSession, "decideNativeContinuation").mockReturnValueOnce({ continue: true, promptOnly: road === "plain" });
      let projected: ReturnType<typeof turn>;
      try { projected = turn(s, wake, road); } finally { projection.mockRestore(); selection.mockRestore(); }
      expect(projected.code).toBeUndefined(); expect(projected.events).not.toBeNull();
      expect(projected.events!.length).toBeGreaterThan(0);
      console.log("AUTOMATIC_EMPTY_ROW", JSON.stringify({ reason, road, current, projected }));
    }
  });
  it("settles own-reply-only and empty system wakes, but exempts child completion without summaries", async () => {
    const s = await setup(), snapshot = await first(s);
    snapshot.resumeDelta = { baseRunId: s.runId, messages: [] };
    const empty = turn(s, { reason: "issue_commented", commentIds: [], executionContinuation: snapshot }, "JSON");
    expect(empty.noop?.cause).toBe("empty_system_wake");
    snapshot.resumeDelta.messages = [{ ...snapshot.messages[0]!, id: randomUUID(), authorType: "agent", authorId: agentId, body: "Own reply" }];
    expect(turn(s, { reason: "issue_commented", commentIds: [], executionContinuation: snapshot }, "JSON").noop?.cause).toBe("own_reply_only");
    snapshot.resumeDelta.messages = [];
    expect(turn(s, { reason: "issue_children_completed", commentIds: [], executionContinuation: snapshot }, "JSON").code).toBeUndefined();
    for (const road of ["plain", "JSON"] as const) {
      expect(turn(s, { reason: "issue_commented", commentIds: [], comments: [{ body: "PERSON WITHOUT AN ID", author: { type: "user", id: "local-board" } }], executionContinuation: snapshot }, road).code).toBeUndefined();
      // Interaction responses are person input but may have no comment ID.
      expect(turn(s, { reason: "issue_commented", commentIds: [], interactionId: randomUUID(), executionContinuation: snapshot }, road).code).toBeUndefined();
    }
  });
});
