import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueQuestionResponseDeliveries,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  completionContracts,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import { noticeHeldUnfinishedPredecessor } from "../native-runtime/native-session-executor.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition } from "./unanswered-person-message.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";

// C9 (Smarty fork): a person's message that nothing answers gets exactly ONE
// visible notice from the stranded sweep, in plain words, with the code in the
// metadata. Each case is a REAL shape: a refusal string from .local/SILENT-F.md
// or a production record shape named in the test title, on an agent with
// managed instructions. "Visible" is the v2 chat filter (TaskChatThread.tsx:930):
// a system comment is hidden only when recoveryResponsibility is "system".
const HELD = "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.";
const NOT_ANSWERED = "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_RUN = "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
const NO_REPLY = "This run finished without a reply to your message. Sending it again is safe.";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL D8 judge (independent)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("unanswered-person-message-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(input: { status?: string; chat?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `user-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Unanswered fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", adapterType: "paperclip_runner", status: "active",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    const chat = input.chat ?? true;
    await db.insert(issues).values({ id: issueId, companyId, title: chat ? "Chat with Managed Pi" : "A task", assigneeAgentId: agentId,
      status: input.status ?? (chat ? "in_progress" : "blocked"),
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: input.status === "in_review" ? "waiting" : "active" } : {}) });
    let clock = Date.now() - 900_000;
    const at = (stepMs = 1_000) => new Date(clock += stepMs);
    const message = async (body = "Please continue.", stepMs?: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, body, authorType: "user", authorUserId: userId,
        createdAt: at(stepMs) }).returning();
      return row!.id;
    };
    const run = async (r: { commentId?: string | null; status: string; error?: string | null; errorCode?: string | null;
      retryOfRunId?: string; wakeReason?: string; finishedAgoMs?: number }) => {
      const contextSnapshot: Record<string, unknown> = { issueId, wakeReason: r.wakeReason ?? "issue_commented" };
      if (r.commentId) contextSnapshot.wakeCommentId = r.commentId;
      const created = at();
      const finishedAt = r.finishedAgoMs === undefined ? created : new Date(Date.now() - r.finishedAgoMs);
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: r.status, runtimeMode: "native",
        nativeIssueId: issueId, contextSnapshot, error: r.error ?? null, errorCode: r.errorCode ?? null,
        retryOfRunId: r.retryOfRunId ?? null, createdAt: created,
        finishedAt: ["running", "queued", "scheduled_retry"].includes(r.status) ? null : finishedAt }).returning();
      return row!.id;
    };
    const reply = async (runId: string) => {
      await db.insert(issueComments).values({ companyId, issueId, body: "Here is my answer.", authorType: "agent", authorAgentId: agentId,
        createdByRunId: runId, createdAt: at() });
    };
    const boardHold = async (cause: string, runId: string, kind = "active_run_watchdog") => {
      const [row] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind, status: "active",
        ownerType: "board", cause, fingerprint: `${kind}:${runId}`, evidence: { runId },
        nextAction: "Saved work recovered. Retry or send a message to continue." }).returning();
      return row!.id;
    };
    // The fixture runs on a clock in the past (so the settle grace has
    // elapsed); a notice the sweep writes now is re-stamped onto that clock so
    // later messages and answers come after it, as they do in production.
    const sweep = async () => {
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId });
      const fresh = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
        eq(issueComments.authorType, "system"), gt(issueComments.createdAt, new Date(clock))));
      for (const row of fresh) await db.update(issueComments).set({ createdAt: at() }).where(eq(issueComments.id, row.id));
    };
    // What the v2 chat panel shows: system comments not classified "system".
    const visible = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(comment => (comment.metadata as Record<string, unknown> | null)?.recoveryResponsibility !== "system");
    return { companyId, agentId, issueId, userId, message, run, reply, boardHold, sweep, visible, at };
  }

  const codeOf = (comment: { metadata: unknown }) => {
    const sections = ((comment.metadata as Record<string, unknown>)?.sections ?? []) as Array<{ rows: Array<{ label?: string; value?: string }> }>;
    return sections.flatMap(section => section.rows).find(row => row.label === "Failure code")?.value;
  };

  // ---------------- RFL D8 independent judge cases ----------------
  const HELD_RESULT = (extra: Record<string, unknown> = {}) => ({
    nativeResult: { summary: "SWAP-3c85065bf96c460282" },
    presentationDecision: { chosenSource: "none", commentAction: "none", reasonCodes: ["yielded_control_plane_wait"], activityDisposition: "collapse" },
    finalizationReasonCode: "board_response_wait_superseded", ...extra });
  const QUESTION = (title: string) => ({ version: 1, questions: [{ id: "format", prompt: title, selectionMode: "single",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] });
  async function card(f: Awaited<ReturnType<typeof fixture>>, v: { title?: string | null; summary?: string | null; kind?: string;
    sourceRunId?: string | null; dismissed?: boolean; continuationPolicy?: string; addresseeUserId?: string; payload?: unknown; createdAt?: Date }) {
    const [row] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: v.kind ?? "ask_user_questions", status: "pending", sourceRunId: v.sourceRunId ?? null, createdByAgentId: f.agentId,
      addresseeUserId: v.addresseeUserId ?? f.userId, title: v.title === undefined ? "Bullets or a paragraph?" : v.title, summary: v.summary ?? null,
      ...(v.continuationPolicy ? { continuationPolicy: v.continuationPolicy } : {}),
      ...(v.dismissed ? { dismissedAt: f.at(), dismissedByUserId: f.userId } : {}),
      payload: (v.payload ?? QUESTION(v.title ?? "q")) as never, createdAt: v.createdAt ?? f.at() }).returning();
    return row!;
  }
  async function heldRun(f: Awaited<ReturnType<typeof fixture>>, messageId: string, result = HELD_RESULT()) {
    const id = await f.run({ commentId: messageId, status: "succeeded" });
    await db.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, id));
    return id;
  }
  const allKeyed = async (f: Awaited<ReturnType<typeof fixture>>, messageId: string) => db.select().from(issueComments).where(and(
    eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"),
    sql`${issueComments.metadata}->>'authorizationReason' = ${`unanswered_message:${messageId}`}`));
  const FALSE_RE = /without a reply|wasn't answered|sending it again is safe|no run started/i;

  it("J1 held reply + one prior pending card -> exactly ONE note, names the card, stays one over 3 sweeps", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    const c = await card(f, { sourceRunId: seed });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep(); await f.sweep(); await f.sweep();
    const notes = await f.visible();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(`card "${c.title}"`);
    expect(notes[0]!.body).not.toMatch(FALSE_RE);
    expect(await allKeyed(f, m)).toHaveLength(1);
    console.log("J1 NOTE:", JSON.stringify({ body: notes[0]!.body, presentation: notes[0]!.presentation, metadata: notes[0]!.metadata }));
  });

  it("J2 two processes (two pools) racing the sweep -> still exactly one note row for the message", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    const a = createDb(database.connectionString), b = createDb(database.connectionString);
    try {
      await Promise.all([
        heartbeatService(a).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId }),
        heartbeatService(b).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId }),
        settleUnansweredPersonMessage(a, { companyId: f.companyId, issueId: f.issueId }),
        settleUnansweredPersonMessage(b, { companyId: f.companyId, issueId: f.issueId }),
      ]);
    } finally { await a.$client.end(); await b.$client.end(); }
    expect(await allKeyed(f, m)).toHaveLength(1);
    expect(await f.visible()).toHaveLength(1);
  });

  it("J3 a normally published answer (commentAction create + agent reply) -> no note", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed });
    const m = await f.message("What was the word?");
    const r = await f.run({ commentId: m, status: "succeeded" });
    await db.update(heartbeatRuns).set({ resultJson: { nativeResult: { summary: "SWAP" },
      presentationDecision: { chosenSource: "final_agent_message", commentAction: "create", reasonCodes: ["server_finished_conversation_terminal_message"] } } })
      .where(eq(heartbeatRuns.id, r));
    await f.reply(r);
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });

  it("J4 two prior pending cards: an ACTIVE confirmation (upstream's holder) and a newer person-DISMISSED question -> the note must name the active one", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    const active = await card(f, { sourceRunId: seed, kind: "request_confirmation", title: "Deploy to production?",
      payload: { version: 1, prompt: "Deploy to production?" } });
    const dismissed = await card(f, { sourceRunId: seed, title: "Bullets or a paragraph?", dismissed: true });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    const notes = await f.visible();
    expect(notes).toHaveLength(1);
    console.log("J4 NOTE:", notes[0]!.body);
    expect(notes[0]!.body).not.toContain(dismissed.title!);
    expect(notes[0]!.body).toContain(active.title!);
  });

  it("J5 held for a reason OTHER than a card (yielded wait, reason governed/approval; only a person-dismissed old card exists) -> no card-blaming note", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    const old = await card(f, { sourceRunId: seed, title: "Old dismissed question", dismissed: true });
    const m = await f.message("What was the word?");
    await heldRun(f, m, HELD_RESULT({ finalizationReasonCode: "native_plan_accepted_waiting_for_continuation" }));
    await f.sweep();
    const notes = await f.visible();
    console.log("J5 NOTE:", notes.map(n => n.body));
    expect(notes.map(n => n.body).join("\n")).not.toContain(old.title!);
  });

  it("J6 held reply, NO card at all (e.g. the person edited the message / an approval is pending) -> must not post the FALSE no-reply note", async () => {
    const f = await fixture({ status: "in_review" });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    const notes = await f.visible();
    console.log("J6 NOTE:", notes.map(n => n.body));
    expect(notes.map(n => n.body).join("\n")).not.toMatch(FALSE_RE);
  });

  it("J7 held reply + the pending card has NO title and NO summary (both optional upstream) -> must not post the FALSE no-reply note", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed, title: null, summary: null });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    const notes = await f.visible();
    console.log("J7 NOTE:", notes.map(n => n.body));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).not.toMatch(FALSE_RE);
  });

  it("J8 REAL continuation context: card answered -> delivery wakes a new run with upstream's own contextSnapshot; its visible reply must supersede the note (or the note must not still say 'Answer the card')", async () => {
    const f = await fixture({ status: "in_review" });
    const first = await f.message("Write me a summary.");
    const seed = await f.run({ commentId: first, status: "succeeded" });
    const c = await card(f, { sourceRunId: seed, payload: QUESTION("Bullets or a paragraph?") });
    const m = await f.message("What was the word?");
    const held = await heldRun(f, m);
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    const answered = await issueThreadInteractionService(db).answerQuestions(
      { id: f.issueId, companyId: f.companyId, status: "in_review" }, c.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: f.userId });
    expect(answered.status).toBe("answered");
    let wake: { runId: string; ctx: unknown } | null = null;
    const delivery = questionResponseDeliveryService(db, { heartbeat: {
      wakeup: async (agentId: string, options: { contextSnapshot?: Record<string, unknown> }) => {
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "running",
          runtimeMode: "native", nativeIssueId: f.issueId, contextSnapshot: options?.contextSnapshot, createdAt: f.at() }).returning();
        wake = { runId: run!.id, ctx: options?.contextSnapshot };
        return { id: run!.id, driverKind: "native" } as never;
      },
      cancelRun: async () => null,
    } as never });
    await delivery.deliver(c.id);
    expect(wake).not.toBeNull();
    console.log("J8 real continuation contextSnapshot:", JSON.stringify(wake!.ctx), "held message:", m, "first message:", first);
    expect(wake!.runId).not.toBe(held);
    // The continuation finishes with upstream's own context (NOT rewritten) and publishes a visible reply.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at() }).where(eq(heartbeatRuns.id, wake!.runId));
    await f.reply(wake!.runId);
    await f.sweep();
    const notes = await f.visible();
    console.log("J8 notes after the continuation's visible reply:", notes.map(n => n.body));
    expect(notes.filter(n => /Answer the card/.test(n.body))).toHaveLength(0);
  });

  it("J9 the card was already answered before the sweep and NO continuation has replied -> the note must not tell the person to answer a card they already answered", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    const c = await card(f, { sourceRunId: seed, payload: QUESTION("Bullets or a paragraph?") });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await issueThreadInteractionService(db).answerQuestions(
      { id: f.issueId, companyId: f.companyId, status: "in_review" }, c.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: f.userId });
    await f.sweep();
    const notes = await f.visible();
    console.log("J9 NOTE:", notes.map(n => n.body));
    expect(notes.map(n => n.body).join("\n")).not.toMatch(/Answer the card/);
  });

  it("J10 card with continuationPolicy 'none' (answering wakes nobody) -> the note must not promise the agent will continue", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed, continuationPolicy: "none" });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    const notes = await f.visible();
    console.log("J10 NOTE:", notes.map(n => n.body));
    expect(notes.map(n => n.body).join("\n")).not.toMatch(/will continue from there/);
  });

  it("J11 the only pending card is addressed to ANOTHER user -> the note must not say it 'was waiting for you'", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed, addresseeUserId: "user-someone-else", kind: "request_confirmation",
      title: "CFO: approve the budget?", payload: { version: 1, prompt: "Approve?" } });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    const notes = await f.visible();
    console.log("J11 NOTE:", notes.map(n => n.body));
    expect(notes.map(n => n.body).join("\n")).not.toMatch(/waiting for you/);
  });

  it("J12 a FAILED run and a succeeded run with an EMPTY summary, each with a prior pending card -> never the held-reply note", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    await card(f, { sourceRunId: seed });
    const m = await f.message("What was the word?");
    await heldRun(f, m, HELD_RESULT({ nativeResult: { summary: "   " } }));
    await f.sweep();
    const notes = await f.visible();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).not.toMatch(/answered while the card/);
    const g = await fixture({ status: "in_review" });
    const gs = await g.run({ status: "succeeded" });
    await card(g, { sourceRunId: gs });
    const gm = await g.message("x");
    const gr = await g.run({ commentId: gm, status: "failed", errorCode: "adapter_failed" });
    await db.update(heartbeatRuns).set({ resultJson: HELD_RESULT() }).where(eq(heartbeatRuns.id, gr));
    await g.sweep();
    const gn = await g.visible();
    expect(gn).toHaveLength(1);
    expect(gn[0]!.body).not.toMatch(/answered while the card/);
  });

  it("J13 the run's OWN pending card (this turn asked it) -> answered, no note at all", async () => {
    const f = await fixture({ status: "in_review" });
    const m = await f.message("What was the word?");
    const r = await heldRun(f, m);
    await card(f, { sourceRunId: r });
    await f.sweep();
    expect(await f.visible()).toHaveLength(0);
  });
  it("J14 upstream's OWN hold predicate on the RED's shape: is the RED's card (ordinary question, then the person's message) an ACTIVE interaction for the held run?", async () => {
    const f = await fixture({ status: "in_review" });
    const seed = await f.run({ status: "succeeded" });
    const c = await card(f, { sourceRunId: seed, payload: QUESTION("Bullets or a paragraph?") });
    const activeBefore = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, f.issueId), eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition({ runId: seed })));
    const m = await f.message("What was the word?");
    const held = await heldRun(f, m);
    // native-board-response-wait.ts:282-293 (the interaction that makes the wait "superseded")
    const activeTask = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, f.issueId), eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition({ runId: held })));
    // native-governance.ts:40-52 (the governance gate, conversation mode)
    const activeConversation = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, f.issueId), eq(issueThreadInteractions.status, "pending"),
      activeIssueInteractionCondition({ runId: held, conversationMode: true })));
    // The same with a confirmation card (never "historical").
    const g = await fixture({ status: "in_review" });
    const gs = await g.run({ status: "succeeded" });
    await card(g, { sourceRunId: gs, kind: "request_confirmation", title: "Deploy?", payload: { version: 1, prompt: "Deploy?" } });
    const gh = await heldRun(g, await g.message("What was the word?"));
    const confActive = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.issueId, g.issueId), eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition({ runId: gh })));
    console.log("J14 RESULT:", JSON.stringify({ cardId: c.id, questionCardActiveBeforePersonMessage: activeBefore.length,
      questionCardActiveAfterPersonMessage_taskMode: activeTask.length, questionCardActiveAfterPersonMessage_conversationMode: activeConversation.length,
      confirmationCardActiveAfterPersonMessage_taskMode: confActive.length }));
    await f.sweep();
    const notes = await f.visible();
    console.log("J14 NOTE on the fix for the question card:", notes.map(n => n.body));
    // If upstream does not count this card as active, it did not cause the hold: the note must not say it did.
    if (activeTask.length === 0) expect(notes.map(n => n.body).join("\n")).not.toMatch(/so Paperclip kept that reply/);
  });
  it("J15 after the note: the person answers the card and the continuation run FAILS -> the person must not be left with only 'Answer the card ... will continue'", async () => {
    const f = await fixture({ status: "in_review" });
    const first = await f.message("Write me a summary.");
    const seed = await f.run({ commentId: first, status: "succeeded" });
    const c = await card(f, { sourceRunId: seed, payload: QUESTION("Bullets or a paragraph?") });
    const m = await f.message("What was the word?");
    await heldRun(f, m);
    await f.sweep();
    expect(await f.visible()).toHaveLength(1);
    await issueThreadInteractionService(db).answerQuestions(
      { id: f.issueId, companyId: f.companyId, status: "in_review" }, c.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: f.userId });
    // Upstream's continuation context (J8 printed it): the card's source comment, not the held message.
    const [cont] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      errorCode: "adapter_failed", error: "provider_process_exited: boom", runtimeMode: "native", nativeIssueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId: c.id, interactionKind: "ask_user_questions",
        interactionStatus: "answered", mutation: "interaction", sourceCommentId: first, wakeCommentId: first, wakeCommentIds: [first],
        wakeReason: "issue_commented", source: "issue.interaction.respond" }, createdAt: f.at(), finishedAt: f.at() }).returning();
    await f.sweep(); await f.sweep();
    const notes = await f.visible();
    console.log("J15 visible notes after the failed continuation:", JSON.stringify(notes.map(n => ({ title: (n.presentation as Record<string, unknown> | null)?.title, body: n.body }))), "continuation", cont!.id);
    expect(notes.some(n => !/Answer the card/.test(n.body))).toBe(true);
  });
});
