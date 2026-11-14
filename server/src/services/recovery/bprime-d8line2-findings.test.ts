// RFL VERDICT-d8line2-78a13a45 (11:25Z) F1-F5, on RFL's own fixture shape (rfl-d8-line2-attacks.test.ts, sha256
// 19d8065a..., kept unchanged and untracked). Isolated PostgreSQL, the real sweep and services.
// Keep reasons: a held reply's history is never edited or deleted (org 09:18Z); the replacement keeps the card
// relation; ONE current note per (card, follow-up); a follow-up is ended only when Paperclip's durable state says so.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { isCurrentNotice } from "@paperclipai/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";

type Meta = Record<string, unknown> | null;
const supersededBy = (n: { metadata: unknown }) => (n.metadata as Meta)?.supersededBy as string | undefined;
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("RFL d8line2 (11:25Z) F1-F5: held-reply history, card linkage, one note per follow-up, durable end (M1.5, Smarty fork, TEMPORARY)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("bprime-d8line2-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { if (db) await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "D8 line2", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Managed Pi", assigneeAgentId: agentId, status: "in_review",
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting" });
    let clock = Date.now() - 900_000;
    const at = (stepMs = 1_000) => new Date(clock += stepMs);
    const message = async (body: string) => (await db.insert(issueComments).values({ companyId, issueId, body, authorType: "user",
      authorUserId: userId, createdAt: at() }).returning())[0]!.id;
    const run = async (commentId: string, status: string, resultJson?: unknown) => (await db.insert(heartbeatRuns).values({ companyId, agentId,
      status, runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: commentId },
      createdAt: at(), finishedAt: at(), ...(resultJson ? { resultJson: resultJson as never } : {}) }).returning())[0]!.id;
    const reply = async (runId: string) => (await db.insert(issueComments).values({ companyId, issueId, body: "Here is my answer.",
      authorType: "agent", authorAgentId: agentId, createdByRunId: runId, createdAt: at() }).returning())[0]!;
    const sweep = async () => {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
      const fresh = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"), gt(issueComments.createdAt, new Date(clock))));
      for (const row of fresh) await db.update(issueComments).set({ createdAt: at() }).where(eq(issueComments.id, row.id));
    };
    const notes = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(c => (c.metadata as Meta)?.recoveryResponsibility !== "system");
    const current = async () => (await notes()).filter(n => isCurrentNotice(n.metadata));
    return { companyId, agentId, issueId, userId, at, message, run, reply, sweep, notes, current };
  }
  const HELD_RESULT = { nativeResult: { summary: "SWAP-3c85065bf96c460282" },
    presentationDecision: { chosenSource: "none", commentAction: "none", reasonCodes: ["yielded_control_plane_wait"], activityDisposition: "collapse" },
    finalizationReasonCode: "board_response_wait_superseded" };
  const QUESTION = { version: 1, questions: [{ id: "format", prompt: "Bullets or a paragraph?", selectionMode: "single",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] };
  type F = Awaited<ReturnType<typeof fixture>>;
  async function held(opts: { card?: boolean; sweep?: boolean } = {}) {
    const f = await fixture();
    const first = await f.message("Write me a summary.");
    const seed = await f.run(first, "succeeded");
    const card = opts.card === false ? null : (await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", sourceRunId: seed, createdByAgentId: f.agentId, addresseeUserId: f.userId,
      title: "Bullets or a paragraph?", payload: QUESTION as never, createdAt: f.at() }).returning())[0]!;
    const m = await f.message("What was the word?");
    const heldRun = await f.run(m, "succeeded", HELD_RESULT);
    let initial: Awaited<ReturnType<F["notes"]>>[number] | undefined;
    if (opts.sweep !== false) { await f.sweep(); [initial] = await f.notes(); expect(initial).toBeDefined(); }
    return { f, first, card, m, heldRun, initial: initial! };
  }
  type H = Awaited<ReturnType<typeof held>>;
  async function answer(h: H) {
    await issueThreadInteractionService(db).answerQuestions({ id: h.f.issueId, companyId: h.f.companyId, status: "in_review" }, h.card!.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: h.f.userId });
    await db.update(issueThreadInteractions).set({ resolvedAt: h.f.at() }).where(eq(issueThreadInteractions.id, h.card!.id));
  }
  async function continuation(h: H, status: string, errorCode = "adapter_failed") {
    return (await db.insert(heartbeatRuns).values({ companyId: h.f.companyId, agentId: h.f.agentId, status,
      errorCode: status === "failed" ? errorCode : null, runtimeMode: "native", nativeIssueId: h.f.issueId,
      contextSnapshot: { issueId: h.f.issueId, taskId: h.f.issueId, interactionId: h.card!.id, interactionKind: "ask_user_questions",
        interactionStatus: "answered", mutation: "interaction", sourceCommentId: h.first, wakeCommentId: h.first, wakeCommentIds: [h.first],
        wakeReason: "issue_commented", source: "issue.interaction.respond" },
      createdAt: h.f.at(), finishedAt: ["queued", "running", "scheduled_retry"].includes(status) ? null : h.f.at() }).returning())[0]!;
  }
  const expectKept = async (before: { id: string; body: string; presentation: unknown }, by: string) => {
    const [kept] = await db.select().from(issueComments).where(eq(issueComments.id, before.id));
    expect(kept!.deletedAt, "never deleted").toBeNull();
    expect(kept!.body, "never edited").toBe(before.body);
    expect(kept!.presentation).toEqual(before.presentation);
    expect(supersededBy(kept!), "marked superseded by the visible reply").toBe(by);
  };

  // F1 (15): the successful-reply paths rewrote the held note ("Earlier: ...", new title).
  it("F1 a card continuation reply: the held note stays byte-identical and is marked supersededBy the reply", async () => {
    const h = await held(); await answer(h);
    const r = await continuation(h, "succeeded"); const visible = await h.f.reply(r.id); await h.f.sweep();
    await expectKept(h.initial, visible.id);
    expect(await h.f.current(), "no current B' note after the reply").toHaveLength(0);
    await h.f.sweep();
    expect(await h.f.notes(), "no second note for the message").toHaveLength(1);
  });

  it("F1 a generic held source reply: the held note stays byte-identical and is marked supersededBy the reply", async () => {
    const h = await held({ card: false });
    const visible = await h.f.reply(h.heldRun); await h.f.sweep();
    await expectKept(h.initial, visible.id);
    expect(await h.f.current()).toHaveLength(0);
  });

  // F2 (16): the replacement note keeps the card relation; a late reply supersedes it, nothing deletes it.
  it("F2 no-run note, then a late successful card continuation: the no-run note is kept and marked supersededBy the reply", async () => {
    const h = await held(); await answer(h); await h.f.sweep();
    const [noRun] = await h.f.current();
    expect(noRun!.body).toMatch(/no follow-up run started/);
    const r = await continuation(h, "succeeded"); const visible = await h.f.reply(r.id); await h.f.sweep();
    await expectKept(noRun!, visible.id);
    expect(await h.f.current()).toHaveLength(0);
  });

  it("F2 failed follow-up note, then a successful card retry: the failure note is kept and marked supersededBy the reply", async () => {
    const h = await held(); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const [failed] = await h.f.current();
    expect(failed!.body).toMatch(/follow-up run failed/);
    const r = await continuation(h, "succeeded"); const visible = await h.f.reply(r.id); await h.f.sweep();
    await expectKept(failed!, visible.id);
    expect(await h.f.current()).toHaveLength(0);
  });

  it("F2 the held source answer is published after the card was answered: no no-run note; the held note is marked supersededBy the reply", async () => {
    const h = await held(); await answer(h);
    const visible = await h.f.reply(h.heldRun); await h.f.sweep();
    expect(await h.f.notes(), "only the held note, never a no-run note").toHaveLength(1);
    await expectKept(h.initial, visible.id);
  });

  it("F2 guard: a failure note whose message a later reply answers is kept (never deleted) and marked supersededBy that reply", async () => {
    const h = await held(); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const [failed] = await h.f.current();
    const retry = await h.f.message("Please try again.");
    const visible = await h.f.reply(await h.f.run(retry, "succeeded")); await h.f.sweep();
    await expectKept(failed!, visible.id);
  });

  // F3 (6): two held messages for ONE card and ONE follow-up gave two current failure notes.
  it("F3 two held messages, one card, one failed follow-up: ONE current failure note, and both held notes are marked superseded by it", async () => {
    const h = await held();
    const second = await h.f.message("Please answer the question.");
    await h.f.run(second, "succeeded", HELD_RESULT); await h.f.sweep();
    const heldNotes = await h.f.notes();
    expect(heldNotes).toHaveLength(2);
    await answer(h); await continuation(h, "failed"); await h.f.sweep(); await h.f.sweep();
    const current = await h.f.current();
    expect(current.filter(n => /follow-up run failed/.test(n.body)), "ONE current note per (card, follow-up)").toHaveLength(1);
    expect(current).toHaveLength(1);
    for (const note of heldNotes) await expectKept(note, current[0]!.id);
    await h.f.sweep();
    expect(await h.f.notes(), "no further note").toHaveLength(3);
  });

  // F4 (12): the card answer and the failed follow-up won the race with the first sweep.
  it("F4 card answered and its follow-up failed before the first sweep: a true failure note, never only the generic held note", async () => {
    const h = await held({ sweep: false }); await answer(h); await continuation(h, "failed");
    await h.f.sweep(); await h.f.sweep();
    const current = await h.f.current();
    expect(current).toHaveLength(1);
    expect(current[0]!.body).toMatch(/card.*was answered.*follow-up run failed/i);
  });

  it("F4 counterexample (R3): a card answered BEFORE the held message is history, not this hold's follow-up: no failure note", async () => {
    const f = await fixture();
    const first = await f.message("Write me a summary.");
    const seed = await f.run(first, "succeeded");
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      status: "pending", sourceRunId: seed, createdByAgentId: f.agentId, addresseeUserId: f.userId, title: "Old question",
      payload: QUESTION as never, createdAt: f.at() }).returning();
    await issueThreadInteractionService(db).answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_review" }, card!.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: f.userId });
    await db.update(issueThreadInteractions).set({ resolvedAt: f.at() }).where(eq(issueThreadInteractions.id, card!.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed", errorCode: "adapter_failed",
      runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId, interactionId: card!.id, wakeCommentId: first },
      createdAt: f.at(), finishedAt: f.at() });
    const m = await f.message("What was the word?");
    await f.run(m, "succeeded", HELD_RESULT);
    await f.sweep(); await f.sweep();
    const current = await f.current();
    expect(current).toHaveLength(1);
    expect(current[0]!.body).not.toMatch(/was answered/);
  });

  // F5 (12): "ended" read the run status, not Paperclip's durable continuation state.
  it("F5 a failed follow-up whose same-run resume is scheduled (retryable_failure, nextAttemptAt ahead) is not ended: no failure note until it is terminal", async () => {
    const h = await held(); await answer(h);
    const r = await continuation(h, "failed");
    await db.insert(nativeRunFinalizations).values({ companyId: h.f.companyId, issueId: h.f.issueId, runId: r.id, phase: "retryable_failure",
      nextAttemptAt: new Date(Date.now() + 60_000) });
    await h.f.sweep();
    expect(await h.f.notes(), "still trying: no failure note").toHaveLength(1);
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null }).where(eq(nativeRunFinalizations.runId, r.id));
    await h.f.sweep();
    const current = await h.f.current();
    expect(current).toHaveLength(1);
    expect(current[0]!.body).toMatch(/follow-up run failed/);
  });
});
