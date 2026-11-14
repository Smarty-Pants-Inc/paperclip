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
describe.skipIf(!support.supported)("RFL D8 line piece 2 attacks (independent)", () => {
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

  // Judge-owned checks. Keep the staged 15-case judge file unchanged.
  async function heldFixture(chat = true, noCard = false) {
    const f = await fixture({ status: "in_review", chat });
    const first = await f.message("Write me a summary.");
    const seed = await f.run({ commentId: first, status: "succeeded" });
    const c = noCard ? null : await card(f, { sourceRunId: seed, payload: QUESTION("Bullets or a paragraph?") });
    const m = await f.message("What was the word?");
    const held = await heldRun(f, m);
    await f.sweep();
    const [initial] = await f.visible();
    expect(initial).toBeDefined();
    return { f, first, c, m, held, initial: initial! };
  }
  async function answer(h: Awaited<ReturnType<typeof heldFixture>>) {
    await issueThreadInteractionService(db).answerQuestions(
      { id: h.f.issueId, companyId: h.f.companyId, status: "in_review" }, h.c!.id,
      { answers: [{ questionId: "format", optionIds: ["a"] }] }, { userId: h.f.userId });
    // Keep card resolution on the same historical clock as messages, notes and runs.
    await db.update(issueThreadInteractions).set({ resolvedAt: h.f.at() }).where(eq(issueThreadInteractions.id, h.c!.id));
  }
  async function continuation(h: Awaited<ReturnType<typeof heldFixture>>, status: string, errorCode = "adapter_failed", carryLatest = false) {
    const { f, first, c, m } = h;
    const [r] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status, errorCode: status === "failed" ? errorCode : null, runtimeMode: "native", nativeIssueId: f.issueId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, interactionId: c!.id, interactionKind: "ask_user_questions",
        interactionStatus: "answered", mutation: "interaction", sourceCommentId: first,
        wakeCommentId: carryLatest ? m : first, wakeCommentIds: [carryLatest ? m : first],
        wakeReason: "issue_commented", source: "issue.interaction.respond" },
      createdAt: f.at(), finishedAt: ["queued", "running", "scheduled_retry"].includes(status) ? null : f.at(),
    }).returning();
    return r!;
  }
  const current = (notes: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["visible"]>>) =>
    notes.filter(n => !(n.metadata as unknown as Record<string, unknown> | null)?.supersededBy);
  const report = (id: string, notes: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["visible"]>>) =>
    console.log(id, JSON.stringify(notes.map(n => ({ id: n.id, body: n.body, presentation: n.presentation,
      metadata: n.metadata, deletedAt: n.deletedAt }))));
  async function latestReply(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
    const [r] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.createdByRunId, runId), eq(issueComments.authorType, "agent")));
    return r!;
  }

  it("A1 a card continuation reply must preserve the held note body/title and set top-level supersededBy", async () => {
    const h = await heldFixture(); await answer(h);
    const r = await continuation(h, "succeeded"); await h.f.reply(r.id); await h.f.sweep();
    const notes = await h.f.visible(); report("A1", notes);
    const kept = notes.find(n => n.id === h.initial.id)!;
    expect.soft(kept.body).toBe(h.initial.body);
    expect.soft(kept.presentation).toEqual(h.initial.presentation);
    expect.soft(kept.deletedAt).toBeNull();
    expect.soft((kept.metadata as unknown as Record<string, unknown>).supersededBy).toBe((await latestReply(h.f, r.id)).id);
  });

  it("A2 a generic held source reply must preserve the held note body/title and set supersededBy", async () => {
    const h = await heldFixture(true, true); await h.f.reply(h.held); await h.f.sweep();
    const notes = await h.f.visible(); report("A2", notes);
    const kept = notes.find(n => n.id === h.initial.id)!;
    expect.soft(kept.body).toBe(h.initial.body);
    expect.soft(kept.presentation).toEqual(h.initial.presentation);
    expect.soft((kept.metadata as unknown as Record<string, unknown>).supersededBy).toBe((await latestReply(h.f, h.held)).id);
  });

  it("A3 no-run grace followed by a late successful card continuation supersedes the no-run note without deletion", async () => {
    const h = await heldFixture(); await answer(h);
    await h.f.sweep();
    const before = await h.f.visible(); expect(before).toHaveLength(2);
    const noRun = current(before)[0]!;
    expect(noRun.body).toMatch(/no follow-up run started/);
    const r = await continuation(h, "succeeded"); await h.f.reply(r.id); await h.f.sweep();
    const notes = await h.f.visible(); report("A3", notes);
    const kept = notes.find(n => n.id === noRun.id)!;
    expect.soft(kept?.body).toBe(noRun.body);
    expect.soft(kept?.deletedAt).toBeNull();
    expect.soft((kept?.metadata as unknown as Record<string, unknown> | undefined)?.supersededBy).toBe((await latestReply(h.f, r.id)).id);
    expect.soft(current(notes).filter(n => /no follow-up run started/.test(n.body))).toHaveLength(0);
  });

  it("A4 a failure then a successful retry with upstream card context supersedes the failure note", async () => {
    const h = await heldFixture(); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const before = await h.f.visible(); expect(before).toHaveLength(2); const failed = current(before)[0]!;
    const r = await continuation(h, "succeeded"); await h.f.reply(r.id); await h.f.sweep();
    const notes = await h.f.visible(); report("A4", notes);
    const kept = notes.find(n => n.id === failed.id)!;
    expect.soft(kept?.body).toBe(failed.body);
    expect.soft((kept?.metadata as unknown as Record<string, unknown> | undefined)?.supersededBy).toBe((await latestReply(h.f, r.id)).id);
    expect.soft(current(notes).filter(n => /follow-up run failed/.test(n.body))).toHaveLength(0);
  });

  it("A5 two held messages for ONE card/follow-up must produce ONE current failure note", async () => {
    const h = await heldFixture();
    const secondMessage = await h.f.message("Please answer the question."); await heldRun(h.f, secondMessage); await h.f.sweep();
    expect(await h.f.visible()).toHaveLength(2);
    await answer(h); await continuation(h, "failed"); await h.f.sweep(); await h.f.sweep();
    const notes = await h.f.visible(); report("A5", notes);
    expect(current(notes).filter(n => /follow-up run failed/.test(n.body))).toHaveLength(1);
  });

  it("A6 second failed follow-up and concurrent two-pool reconciliation keep ONE current note", async () => {
    const h = await heldFixture(); await answer(h); await continuation(h, "failed");
    const a = createDb(database.connectionString), b = createDb(database.connectionString);
    try { await Promise.all([settleUnansweredPersonMessage(a, { companyId: h.f.companyId, issueId: h.f.issueId }),
      settleUnansweredPersonMessage(b, { companyId: h.f.companyId, issueId: h.f.issueId })]); }
    finally { await a.$client.end(); await b.$client.end(); }
    await continuation(h, "failed"); await h.f.sweep(); await h.f.sweep();
    const notes = await h.f.visible(); report("A6", notes);
    expect(notes).toHaveLength(2); expect(current(notes)).toHaveLength(1);
    expect(notes.find(n => n.id === h.initial.id)!.body).toBe(h.initial.body);
  });

  it.each(["queued", "running", "scheduled_retry"])("A7 a %s card continuation after grace must not get a premature failure note", async status => {
    const h = await heldFixture(); await answer(h);
    await continuation(h, status); await h.f.sweep();
    expect(await h.f.visible()).toHaveLength(1);
    expect((await h.f.visible())[0]!.body).toBe(h.initial.body);
  });

  it("A8 failure notice must not soft-delete when a later reply carries the held message", async () => {
    const h = await heldFixture(); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const failed = current(await h.f.visible())[0]!;
    const retryMessage = await h.f.message("Please try again.");
    const retryId = await h.f.run({ commentId: retryMessage, status: "succeeded" });
    const r = { id: retryId }; await h.f.reply(r.id); await h.f.sweep();
    const [kept] = await db.select().from(issueComments).where(eq(issueComments.id, failed.id));
    console.log("A8", JSON.stringify({ body: kept!.body, deletedAt: kept!.deletedAt, metadata: kept!.metadata }));
    expect.soft(kept!.deletedAt).toBeNull(); expect.soft(kept!.body).toBe(failed.body);
    expect.soft((kept!.metadata as unknown as Record<string, unknown>).supersededBy).toBe((await latestReply(h.f, r.id)).id);
  });

  it("A9 card answered and follow-up failed before the first sweep still gets a true failure note", async () => {
    const f = await fixture({ status: "in_review" });
    const first = await f.message("Write me a summary."); const seed = await f.run({ commentId: first, status: "succeeded" });
    const c = await card(f, { sourceRunId: seed }); const m = await f.message("What was the word?"); const held = await heldRun(f, m);
    const h = { f, first, c, m, held, initial: undefined as never };
    await answer(h); await continuation(h, "failed"); await f.sweep(); await f.sweep();
    const notes = await f.visible(); report("A9", notes);
    expect(current(notes).some(n => /card.*was answered.*follow-up run failed/i.test(n.body))).toBe(true);
  });

  it("A10 original held source answer is published: the held note must not point to a deleted no-run note", async () => {
    const h = await heldFixture(); await answer(h);
    await h.f.reply(h.held); await h.f.sweep();
    const notes = await h.f.visible(); report("A10", notes);
    expect.soft(notes.every(n => n.deletedAt === null)).toBe(true);
    const [kept] = await db.select().from(issueComments).where(eq(issueComments.id, h.initial.id));
    expect.soft(kept!.body).toBe(h.initial.body);
    // Either the reply or a new truthful correction is an acceptable target, but never a deleted note.
    const targetId = (kept!.metadata as unknown as Record<string, unknown>).supersededBy as string;
    const [target] = await db.select().from(issueComments).where(eq(issueComments.id, targetId));
    console.log("A10 supersession target", JSON.stringify({ id: target?.id, body: target?.body, deletedAt: target?.deletedAt }));
    expect.soft(target).toBeDefined();
    expect.soft(target?.deletedAt).toBeNull();
  });

  it("A12 no-run grace is respected on both sides of the exact deadline", async () => {
    const h = await heldFixture(); await answer(h);
    const [c] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, h.c!.id));
    const t = c!.resolvedAt!.getTime();
    await settleUnansweredPersonMessage(db, { companyId: h.f.companyId, issueId: h.f.issueId, now: new Date(t + 119_999) });
    expect(await h.f.visible()).toHaveLength(1);
    await settleUnansweredPersonMessage(db, { companyId: h.f.companyId, issueId: h.f.issueId, now: new Date(t + 120_000) });
    const notes = await h.f.visible(); expect(notes).toHaveLength(2);
    expect(current(notes)[0]!.body).toMatch(/no follow-up run started/);
  });

  it("A11 workspace failure uses the required card-aware, chat-aware note rather than overriding the D8 seed", async () => {
    const h = await heldFixture(); await answer(h); await continuation(h, "failed", "remote_workspace_prepare_timeout"); await h.f.sweep();
    const notes = await h.f.visible(); report("A11", notes);
    const note = current(notes)[0]!;
    expect.soft(note.body).toMatch(/card.*was answered.*follow-up run failed/i);
    expect.soft(JSON.stringify(note.metadata)).toContain("start a new chat with Managed Pi");
  });
});
