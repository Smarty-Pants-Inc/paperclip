import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions,
  heartbeatRunEvents, issues, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { allocateHeartbeatRunEventSeq } from "../services/heartbeat-run-events.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

// Keep (never-OK rule: no false "no run started" / "wasn't answered" line after the person's own Stop). review-fleet-5
// 20:34Z: what a person's REAL Stop leaves on this line, read from the rows below: the run is cancelled with
// cancelledByActorType "user" and the person's cancelledByUserId, AND the Stop leaves a board-owned hold on it
// (issue_recovery_actions kind active_run_watchdog, cause native_continuation_requires_reconciliation for a native
// run, legacy_execution_requires_reconciliation for a legacy one, evidence.runId = the stopped run); a message the
// person sent while the run worked keeps its wake in line (deferred_issue_execution). Before this fix the hold made
// the sweep ignore that waiting wake and write "Your message is saved, but no run started for it" for it.
// Real disposable PostgreSQL, the real cancel route and cancelRun (no service or route mock); no model is launched
// (a second running task holds the agent's one slot). Harness: rf-5's famnotices-independent seed, plus a TASK shape.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("the sender's own Stop wins over the board hold the Stop itself left (STOP_HOLD_YIELDS_TO_SENDER_STOP)", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    pg = await startEmbeddedPostgresTestDatabase("sender-stop-hold-");
    db = createDb(pg.connectionString);
  }, 60000);
  afterAll(async () => { await db?.$client.end(); await pg?.cleanup(); });

  function app(companyId: string, userId: string) {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId, source: "session", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: true };
      next();
    });
    a.use("/api", agentRoutes(db));
    a.use("/api", issueRoutes(db, {} as any, {}));
    a.use(errorHandler); return a;
  }

  async function seed(mode: "native" | "legacy" = "native", chat = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sender = `sender-${randomUUID()}`, other = `other-${randomUUID()}`, messageId = randomUUID();
    const t = Date.now() - 15 * 60000;
    await db.insert(companies).values({ id: companyId, name: "RF5 independent BAR", issuePrefix: companyId.slice(0, 8), requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values([sender, other].map(principalId => ({ companyId, principalId,
      principalType: "user", membershipRole: "owner", status: "active" })));
    await db.insert(agents).values({ id: agentId, companyId, name: "BAR agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: mode, nativeIssueId: issueId, scopeKind: "issue", issueId,
      responsibleUserId: sender, status: "running", startedAt: new Date(t + 1000), createdAt: new Date(t + 1000),
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", wakeCommentId: messageId,
        wakeCommentIds: [messageId], firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId,
          commentIds: [], wakeupRequestIds: [], claimedAt: new Date(t + 2000).toISOString() } } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `RF5-${Math.floor(Math.random()*100000000)}`,
      title: chat ? "Chat with BAR agent" : "A task", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: sender, conversationState: "active" } : {}) });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: sender,
      body: "Write the requested document.", createdAt: new Date(t) });
    await db.update(heartbeatRuns).set({ issueId }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
    // Hold provider work in the existing admission queue. This task is unrelated.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", runtimeMode: "legacy",
      contextSnapshot: { issueId: randomUUID() } });
    const event = async (eventType: string, kind?: string, itemId?: string) => {
      const n = await allocateHeartbeatRunEventSeq(db, runId);
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: n, eventType,
        sourceEventId: `source-${randomUUID()}`, payload: { prpEvent: { eventType, turnId: `turn-${runId}`,
          itemId: itemId ?? `item-${n}`, payload: kind ? { kind, item: { type: kind } } : {} } } });
    };
    await event("turn.started"); await event("item.started", "userMessage"); await event("item.started", "agentMessage");
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
    const settle = (offset = 0) => settleUnansweredPersonMessage(db, { companyId, issueId, now: new Date(Date.now() + offset) });
    const settleFromStop = (offset: number) => settleUnansweredPersonMessage(db, { companyId, issueId, now: new Date(t + 30000 + offset) });
    const sweep = () => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId, unanswered: true });
    const message = async (body: string) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: sender,
        body, createdAt: new Date(t + 20000) }).returning(); return row!.id;
    };
    const stop = async (by = sender) => {
      const stored = await readRun();
      const projected = await heartbeatService(db).getRun(runId);
      void projected; if (false) console.log("RF5_STOP_BEFORE", JSON.stringify({ companyId, by, stored: { scopeKind: stored.scopeKind, issueId: stored.issueId }, projected: projected && { scopeKind: projected.scopeKind, issueId: projected.issueId, companyId: projected.companyId } }));
      const response = await request(app(companyId, by)).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const r = await readRun();
      expect(r.status).toBe("cancelled"); expect(r.resultJson?.cancelledByUserId).toBe(by);
      expect(r.resultJson?.cancelledByActorType).toBe("user");
      // Notice settle grace has elapsed, without faking any producer attribution.
      await db.update(heartbeatRuns).set({ finishedAt: new Date(t + 30000) }).where(eq(heartbeatRuns.id, runId));
      return r;
    };
    const queue = async (commentId: string) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, status: "deferred_issue_execution",
        source: "issue_comment", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: sender,
        payload: { issueId, commentId, _paperclipWakeContext: { issueId, commentId, wakeCommentId: commentId,
          wakeCommentIds: [commentId], wakeReason: "issue_commented" } } }).returning(); return wake!.id;
    };
    const interrupt = async (commentId: string) => {
      const wakeId = await queue(commentId), a = app(companyId, sender);
      const q = await request(a).get(`/api/issues/${issueId}/queued-comments`).expect(200);
      const res = await request(a).post(`/api/issues/${issueId}/queued-comments/interrupt`)
        .send({ queueId: wakeId, targetRunId: runId, revision: q.body.revision });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const r = await readRun(); expect(r.status).toBe("cancelled"); expect(r.errorCode).toBe("operator_interrupted");
      expect(r.resultJson?.cancelledByUserId).toBe(sender);
      expect(r.resultJson?.interruptedByActorId).toBe(sender);
      expect(r.resultJson?.interruptedByActorType).toBe("user");
      await db.update(heartbeatRuns).set({ finishedAt: new Date(t + 30000) }).where(eq(heartbeatRuns.id, runId));
      return wakeId;
    };
    /** A question card the running run posted for the sender (the card row is inserted, as in rf-5's seeds). */
    const card = async () => (await db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: runId,
      kind: "ask_user_questions", status: "pending", createdByAgentId: agentId, addresseeUserId: sender, continuationPolicy: "wake_assignee",
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", required: true, selectionMode: "single",
        options: [{ id: "first", label: "First" }] }] } as never }).returning())[0]!.id;
    /** The person answers the card through the REAL route (POST /issues/:id/interactions/:id/respond) and its real
     * delivery: the answer's delivery row and its own wake are the route's, not inserted. */
    const answer = async (cardId: string, by = sender) => {
      const response = await request(app(companyId, by)).post(`/api/issues/${issueId}/interactions/${cardId}/respond`)
        .send({ answers: [{ questionId: "scope", optionIds: ["first"] }] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "answered", resolvedByUserId: by });
    };
    return { companyId, agentId, issueId, runId, messageId, sender, other, t, event, notes, readRun, settle, settleFromStop, sweep, message, stop, queue, interrupt,
      card, answer };
  }

  const lines = <T extends { body: string }>(notes: T[]) => notes.filter(n => /wasn't answered|no run started|wasn't acted on/i.test(n.body));
  it.each([["CHAT", "native", true], ["TASK", "native", false], ["CHAT", "legacy", true], ["TASK", "legacy", false]] as const)(
    "%s (%s run): the sender's real Stop with a message waiting behind it -> no 'wasn't answered' or no-run line at +1/+3/+11 min",
    async (_shape, mode, chat) => {
      const f = await seed(mode, chat); const m2 = await f.message("Then deploy it."); await f.queue(m2); await f.stop();
      const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(holds, "the real Stop left ONE board-owned hold on the stopped run").toHaveLength(1);
      expect(holds[0]).toMatchObject({ kind: "active_run_watchdog", status: "active", ownerType: "board",
        cause: mode === "native" ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
        evidence: { runId: f.runId, originalFailureCode: "cancelled" } });
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(wakes.map(w => w.status), "M2's wake still waits in line").toEqual(["deferred_issue_execution"]);
      for (const min of [1, 3, 11]) {
        const decision = await f.settle(min * 60000);
        expect(decision.kind, `+${min} min`).not.toBe("noticed");
        expect(lines(await f.notes()), `+${min} min`).toHaveLength(0);
      }
      await f.sweep(); await f.sweep();
      expect(await f.notes(), "the real sweep writes nothing either").toHaveLength(0);
    }, 60000);

  it("negative: ANOTHER board user's real Stop leaves the same hold -> the sender's waiting message keeps its one line", async () => {
    const f = await seed(); const m2 = await f.message("Then deploy it."); await f.queue(m2); await f.stop(f.other);
    await f.settle(); await f.settle(11 * 60000);
    const notes = await f.notes();
    expect(lines(notes).length, "the sender did not stop it: never silence").toBeGreaterThanOrEqual(1);
    const covered = notes.flatMap(n => [String(n.metadata?.authorizationReason).split(":")[1], ...((n.metadata as any)?.unansweredMessageIds ?? [])]);
    expect(covered).toContain(m2);
    expect(new Set(covered).size, "never two lines for one message").toBe(covered.filter((id, i) => covered.indexOf(id) === i).length);
  }, 60000);

  it("negative: the sender's own Stop, a later message with NO wake waiting in line -> one line, never silence", async () => {
    const f = await seed(); await f.stop(); const m2 = await f.message("A queued message without a carrier");
    await f.settle(); await f.settle(11 * 60000);
    const notes = await f.notes(); expect(notes).toHaveLength(1);
    expect(notes[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${m2}`);
  }, 60000);

  // RFL 22:22Z (am6 gap 19): the sender-Stop exemption applies to a person's CARD ANSWER too. What the real routes
  // leave (logs/probe/item3-card-answer-stop-footprint.txt): the answer route marks the card answered by the person,
  // writes its delivery (fallback_queued, wake_fallback) and ONE wake that waits in line (deferred_issue_execution,
  // payload.interactionId = the card); the Stop leaves the cancelled run and the board hold. Before this fix the
  // sweep wrote "Your answer is saved, but no run started for it" at +3 min, beside the person's own Stop.
  const cardFootprint = async (f: Awaited<ReturnType<typeof seed>>, cardId: string) => {
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, cardId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    return { delivery: delivery?.status, wakes: wakes.map(w => [w.status, (w.payload as Record<string, unknown>).interactionId === cardId]),
      holds: holds.map(h => [h.kind, h.status, h.ownerType, (h.evidence as Record<string, unknown>).runId === f.runId]) };
  };
  it.each([["CHAT", "answer, then Stop", true], ["TASK", "answer, then Stop", false], ["CHAT", "Stop, then answer", true]] as const)(
    "%s card answer (real answer route + the answerer's real Stop; %s): no 'no run started' line for the answer at +1/+3/+11/+30 min",
    async (_shape, order, chat) => {
      const f = await seed("native", chat); const cardId = await f.card();
      if (order === "answer, then Stop") { await f.answer(cardId); await f.stop(); } else { await f.stop(); await f.answer(cardId); }
      expect(await cardFootprint(f, cardId), "the real routes' footprint: the answer's own wake waits behind the Stop's hold").toEqual({
        delivery: "fallback_queued", wakes: [["deferred_issue_execution", true]], holds: [["active_run_watchdog", "active", "board", true]] });
      for (const min of [1, 3, 11, 30]) {
        const decision = await f.settle(min * 60000);
        expect(decision.kind, `+${min} min`).not.toBe("noticed");
        expect(lines(await f.notes()), `+${min} min`).toHaveLength(0);
      }
      await f.sweep(); await f.sweep();
      expect(await f.notes(), "the real sweep writes nothing either").toHaveLength(0);
    }, 60000);

  it("negative: ANOTHER board user's real Stop -> the person's card answer keeps its ONE line, never silence", async () => {
    const f = await seed(); const cardId = await f.card(); await f.answer(cardId); await f.stop(f.other);
    expect((await cardFootprint(f, cardId)).wakes).toEqual([["deferred_issue_execution", true]]);
    await f.settle(60000); await f.settle(3 * 60000); await f.settle(11 * 60000); await f.settle(30 * 60000);
    const notes = lines(await f.notes());
    expect(notes, "exactly one line").toHaveLength(1);
    expect(notes[0]!.body).toBe("Your answer is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.");
    expect(notes[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${cardId}`);
  }, 60000);

  it("negative: the answerer's own Stop, but the answer's wake no longer waits in line (PLANTED: the wake row ended 'failed') -> one line, never silence", async () => {
    const f = await seed(); const cardId = await f.card(); await f.answer(cardId); await f.stop();
    // PLANTED: the real routes left the wake waiting (row above); here it ended without a run.
    await db.update(agentWakeupRequests).set({ status: "failed", error: "planted: the wake ended without a run", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    await f.settle(3 * 60000); await f.settle(11 * 60000);
    const notes = lines(await f.notes());
    expect(notes, "exactly one line").toHaveLength(1);
    expect(notes[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${cardId}`);
  }, 60000);

  it.each([["the answerer", true, 0], ["ANOTHER board user", false, 1]] as const)(
    "the run that took the card answer and had started answering it is stopped by %s (real Stop route; own Stop %s) -> %s line(s) for the answer",
    async (_who, own, expected) => {
      const f = await seed(); const cardId = await f.card(); await f.answer(cardId);
      // The first run ends (PLANTED status), and the answer's resume run is PLANTED as the real wake's context names it
      // (interactionId = the card), with the model's read and first reply item (as rf-5's seeds plant them).
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(f.t + 25000) }).where(eq(heartbeatRuns.id, f.runId));
      const resumeId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: resumeId, companyId: f.companyId, agentId: f.agentId, runtimeMode: "native",
        nativeIssueId: f.issueId, scopeKind: "issue", issueId: f.issueId, responsibleUserId: f.sender, status: "running",
        startedAt: new Date(f.t + 26000), createdAt: new Date(f.t + 26000),
        contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_commented", source: "issue.interaction.respond",
          interactionId: cardId, interactionStatus: "answered" } });
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: resumeId, phase: "observed" });
      await db.update(issues).set({ executionRunId: resumeId }).where(eq(issues.id, f.issueId));
      await db.update(agentWakeupRequests).set({ status: "completed", runId: resumeId, finishedAt: new Date() }).where(eq(agentWakeupRequests.companyId, f.companyId));
      await db.update(issueQuestionResponseDeliveries).set({ targetRunId: resumeId }).where(eq(issueQuestionResponseDeliveries.interactionId, cardId));
      for (const [index, kind] of ["userMessage", "agentMessage"].entries()) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: resumeId, seq: index + 1, eventType: "item.started", sourceEventId: `source-${randomUUID()}`,
        payload: { prpEvent: { eventType: "item.started", turnId: `turn-${resumeId}`, itemId: `item-${index}`, payload: { kind, item: { type: kind } } } } });
      const response = await request(app(f.companyId, own ? f.sender : f.other)).post(`/api/heartbeat-runs/${resumeId}/cancel`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, resumeId));
      expect(stopped).toMatchObject({ status: "cancelled", resultJson: { cancelledByActorType: "user", cancelledByUserId: own ? f.sender : f.other } });
      await db.update(heartbeatRuns).set({ finishedAt: new Date(f.t + 30000) }).where(eq(heartbeatRuns.id, resumeId));
      for (const min of [1, 3, 11, 30]) await f.settle(min * 60000);
      const notes = (await f.notes()).filter(n => String(n.metadata?.authorizationReason).startsWith("unanswered_message:"));
      expect(notes, own ? "the answerer's own Stop line is the one note" : "someone else's Stop: the answer keeps its one line").toHaveLength(expected);
      if (!own) expect(notes[0]!.metadata?.authorizationReason).toBe(`unanswered_message:${cardId}`);
    }, 60000);
});
