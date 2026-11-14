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
import { issueService } from "../issues.js";
import { currentNoticeSql } from "../issue-comment-current.js";
import { isCurrentNotice, issueCommentMetadataSchema } from "@paperclipai/shared";
import { writeFileSync } from "node:fs";

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
describe.skipIf(!support.supported)("RFL M1.5 judge extra checks (independent)", () => {
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


  // ---------------- M1.5 judge-owned extra checks ----------------
  type Snap = { id: string; body: string; presentation: unknown; metadata: unknown; deletedAt: Date | null };
  const receipts: Record<string, unknown> = {};
  const rowsOf = async (f: Awaited<ReturnType<typeof fixture>>): Promise<Snap[]> => (await db.select().from(issueComments)
    .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"))))
    .map(n => ({ id: n.id, body: n.body, presentation: n.presentation, metadata: n.metadata, deletedAt: n.deletedAt }));
  const strip = (m: unknown) => { const { supersededBy: _a, supersededByInteractionId: _b, ...rest } = (m ?? {}) as Record<string, unknown>; return rest; };
  // The binding rule: a kept note changes ONLY by gaining one of the two markers.
  async function audit(label: string, f: Awaited<ReturnType<typeof fixture>>, before: Snap[]) {
    const after = await rowsOf(f);
    const out: unknown[] = [];
    for (const b of before) {
      const a = after.find(n => n.id === b.id);
      const sameBody = a?.body === b.body, samePresentation = JSON.stringify(a?.presentation) === JSON.stringify(b.presentation);
      const onlyMarkers = JSON.stringify(strip(a?.metadata)) === JSON.stringify(strip(b.metadata));
      out.push({ id: b.id, exists: Boolean(a), deleted: Boolean(a?.deletedAt), sameBody, samePresentation, metadataChangedOnlyByMarkers: onlyMarkers,
        ...(onlyMarkers ? {} : { metadataBefore: b.metadata, metadataAfter: a?.metadata }) });
      expect.soft(a, label + ": row exists").toBeDefined();
      expect.soft(a?.deletedAt ?? null, label + ": never deleted").toBeNull();
      expect.soft(sameBody, label + ": body unchanged").toBe(true);
      expect.soft(samePresentation, label + ": title/presentation unchanged").toBe(true);
      expect.soft(onlyMarkers, label + ": metadata changed ONLY by the two markers").toBe(true);
    }
    receipts[label] = out;
    return after;
  }
  const flush = () => { if (process.env.JUDGE_M15_RECEIPT) writeFileSync(process.env.JUDGE_M15_RECEIPT, JSON.stringify(receipts, null, 2) + "\n"); };

  it("X1a plain B' note answered: the kept note changes only by the marker", async () => {
    const f = await fixture(); const m = await f.message(); const failed = await f.run({ commentId: m, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" });
    await f.sweep(); const before = await rowsOf(f); expect(before).toHaveLength(1);
    const ok = await f.run({ commentId: m, status: "succeeded", retryOfRunId: failed }); await f.reply(ok); await f.sweep();
    const after = await audit("X1a-plain-answered", f, before); flush();
    expect(isCurrentNotice(after[0]!.metadata)).toBe(false);
  });

  it("X1b D8 held note superseded by a card-continuation reply: the kept note changes only by the marker", async () => {
    const h = await heldFixture(); const before = await rowsOf(h.f); await answer(h);
    const r = await continuation(h, "succeeded"); await h.f.reply(r.id); await h.f.sweep();
    await audit("X1b-d8-reply", h.f, before); flush();
  });

  it("X1c D8 held note superseded by the follow-up FAILURE note, then that note by a late reply: kept notes change only by the marker", async () => {
    const h = await heldFixture(); const before = await rowsOf(h.f); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const mid = await audit("X1c-d8-failure-note", h.f, before); expect(mid).toHaveLength(2);
    const r = await continuation(h, "succeeded"); await h.f.reply(r.id); await h.f.sweep();
    await audit("X1c-d8-late-reply", h.f, mid); flush();
  });

  it("X2 real writer rows -> real issueService.listComments/getComment return BOTH markers; every stored metadata passes the API schema", async () => {
    const h = await heldFixture(); await answer(h); await continuation(h, "failed"); await h.f.sweep();
    const stored0 = await rowsOf(h.f); expect(stored0).toHaveLength(2);
    const currentNote = stored0.find(n => isCurrentNotice(n.metadata))!; const superseded = stored0.find(n => !isCurrentNotice(n.metadata))!;
    // a card marker, written with the same JSONB merge shape the line uses for supersededBy (the line has no writer for it)
    const g = await fixture(); const gm = await g.message(); await g.run({ commentId: gm, status: "failed", errorCode: "adapter_failed", error: "native_session_lease_lost" }); await g.sweep();
    const [cardNote] = await rowsOf(g); const c = await card(g, {});
    await db.execute(sql`update ${issueComments} set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('supersededByInteractionId', ${c.id}::text) where id = ${cardNote!.id}`);
    const svc = issueService(db);
    const listed = await svc.listComments(h.f.issueId, { order: "asc" }); const listedG = await svc.listComments(g.issueId, { order: "asc" });
    const out: Record<string, unknown> = {};
    for (const n of await rowsOf(h.f)) {
      const l = listed.find(x => x.id === n.id)!; const e = await svc.getComment(n.id);
      out[n.id] = { stored: (n.metadata as Record<string, unknown>)?.supersededBy ?? null, listed: (l.metadata as Record<string, unknown> | null)?.supersededBy ?? null,
        exact: (e?.metadata as Record<string, unknown> | null)?.supersededBy ?? null, listedMetadataNull: l.metadata === null,
        schemaOk: issueCommentMetadataSchema.safeParse(n.metadata).success };
      expect.soft(issueCommentMetadataSchema.safeParse(n.metadata).success, "stored metadata passes the API schema").toBe(true);
      expect.soft(l.metadata, "listComments keeps metadata").not.toBeNull(); expect.soft(e?.metadata, "getComment keeps metadata").not.toBeNull();
      expect.soft((l.metadata as Record<string, unknown> | null)?.supersededBy).toBe((n.metadata as Record<string, unknown>)?.supersededBy);
      expect.soft((e?.metadata as Record<string, unknown> | null)?.supersededBy).toBe((n.metadata as Record<string, unknown>)?.supersededBy);
    }
    expect((listed.find(x => x.id === superseded.id)!.metadata as Record<string, unknown>).supersededBy).toBe(currentNote.id);
    const lg = listedG.find(x => x.id === cardNote!.id)!; const eg = await svc.getComment(cardNote!.id);
    expect((lg.metadata as Record<string, unknown> | null)?.supersededByInteractionId).toBe(c.id);
    expect((eg?.metadata as Record<string, unknown> | null)?.supersededByInteractionId).toBe(c.id);
    out.cardMarker = { listed: (lg.metadata as Record<string, unknown> | null)?.supersededByInteractionId ?? null, exact: (eg?.metadata as Record<string, unknown> | null)?.supersededByInteractionId ?? null, cardId: c.id };
    // a card-marked note is history for B': the next sweep posts no second note for that message
    await g.sweep(); await g.sweep();
    out.cardMarkedThenSwept = (await rowsOf(g)).map(n => ({ id: n.id, current: isCurrentNotice(n.metadata), body: n.body }));
    receipts["X2-api-read"] = out; flush();
  });

  it("X3 the SQL reader rule (currentNoticeSql) equals the shared JS rule (isCurrentNotice) on every marker shape", async () => {
    const f = await fixture(); const G = randomUUID();
    const values: unknown[] = [undefined, null, "", " ", G, 0, 1, true, false, {}, [], [G]];
    const ids: string[] = [];
    for (const key of ["supersededBy", "supersededByInteractionId"]) for (const v of values) {
      const [row] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: "parity",
        metadata: { version: 1, sections: [], ...(v === undefined ? {} : { [key]: v }) } as never }).returning();
      ids.push(row!.id);
    }
    const sqlCurrent = new Set((await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system"), currentNoticeSql(issueComments.metadata)))).map(r => r.id));
    const all = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system")));
    const mismatches = all.filter(r => sqlCurrent.has(r.id) !== isCurrentNotice(r.metadata)).map(r => r.metadata);
    receipts["X3-parity"] = { rows: all.length, mismatches }; flush();
    expect(all).toHaveLength(ids.length); expect(mismatches).toEqual([]);
  });
});
