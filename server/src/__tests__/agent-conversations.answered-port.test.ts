// F-B (RFL 23:43Z / 23:59Z; rf-5 23:57Z): the chat's saved "answered" comes from the ONE function
// (answeredPersonMessageSql). Every row drives REAL producers and reads the person-visible outcome from the REAL GET:
//   - the person's message: POST /api/issues/:id/comments (the board route the chat composer uses);
//   - the run: the route's own wake -> heartbeatService -> a real process-adapter turn -> run-completion ->
//     settleConversationTurn (nothing here calls settle by hand, except where a row says so);
//   - the agent's reply: issueService.addComment as the agent with its run id (the agent comment route's producer);
//   - the agent's card: issueThreadInteractionService.create with sourceRunId (the agent interaction route's producer);
//   - the person's card answer: POST /api/issues/:id/interactions/:id/respond;
//   - the Status row: GET /api/issues/:id `status` (IssueProperties' Status row renders it through StatusIcon:
//     in_review -> "In Review", in_progress -> "In Progress");
//   - the activity line: GET /api/issues/:id/activity (issue.updated, details.status: "changed status to in review");
//   - the notice: the REAL sweep (settleUnansweredPersonMessages), then GET /api/issues/:id/comments.
// PLANTED (named in each row): a report_progress tool receipt on the run (its only producer is the native runner's
// tool path, which a process-adapter turn does not have), and a card's system expiry.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { prepareConversationTurn, settleConversationTurnForRun } from "../services/agent-conversations.js";
import { answeredPersonMessageSql } from "../services/person-message-answer.js";
import { settleUnansweredPersonMessages, UNANSWERED_MESSAGE_REASON_PREFIX } from "../services/recovery/unanswered-person-message.js";

type Turn = { reply?: string; progress?: string; card?: boolean; exit?: number; hold?: () => Promise<void> };

(support.supported ? describe : describe.skip)("F-B: the chat's answered state follows the one function", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-answered-port-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "local-board", name: "Local Board", email: "local@paperclip.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    // PLANTED report_progress receipts: a run's planted receipt is merged into its result on every write of the
    // run row, so the REAL completion (which replaces a process run's result) still settles with it in place.
    await db.execute(sql`create table planted_progress_receipts (run_id uuid primary key, receipts jsonb not null)`);
    await db.execute(sql`create function plant_progress_receipt() returns trigger language plpgsql as $$
      declare planted jsonb;
      begin
        select receipts into planted from planted_progress_receipts where run_id = new.id;
        if planted is not null then
          new.result_json = coalesce(new.result_json, '{}'::jsonb) || jsonb_build_object('semanticToolReceipts', planted);
        end if;
        return new;
      end $$`);
    await db.execute(sql`create trigger plant_progress_receipt before update on heartbeat_runs
      for each row execute function plant_progress_receipt()`);
  }, 90_000);
  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  let prefix = 0;
  async function chat() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Answered port", issuePrefix: `FB${(prefix += 1)}X${randomUUID().slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false });
    const script: Turn[] = [];
    const turns: Array<{ runId: string; context: Record<string, unknown> }> = [];
    let issueId = "";
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.post("/respond", async (req, res) => {
      try {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, req.body.runId));
        turns.push({ runId: run!.id, context: (run!.contextSnapshot ?? {}) as Record<string, unknown> });
        const turn = script.shift() ?? {};
        await turn.hold?.();
        if (turn.card) {
          const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
          await issueThreadInteractionService(db).create(issue!, { kind: "ask_user_questions", continuationPolicy: "wake_assignee",
            idempotencyKey: `card:${run!.id}`, sourceRunId: run!.id,
            payload: { version: 1, questions: [{ id: "q1", prompt: "Which color?", selectionMode: "single",
              options: [{ id: "blue", label: "Blue" }, { id: "red", label: "Red" }] }] } } as never, { agentId });
        }
        if (turn.progress) {
          const comment = await issueService(db).addComment(issueId, turn.progress, { agentId, runId: run!.id });
          // PLANTED: the report_progress receipt (the native runner's tool path writes it on the run's result).
          await db.execute(sql`insert into planted_progress_receipts (run_id, receipts) values (${run!.id}::uuid, ${JSON.stringify({
            [`progress-${comment.id}`]: { operationId: "report_progress", result: { commentId: comment.id } } })}::jsonb)`);
        }
        if (turn.reply) await issueService(db).addComment(issueId, turn.reply, { agentId, runId: run!.id });
        res.json({ exit: turn.exit ?? 0 });
      } catch (error) {
        res.status(500).json({ error: String((error as Error)?.stack ?? error) });
      }
    });
    const listener: Server = agentApp.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const port = (listener.address() as { port: number }).port;
    const cwd = await mkdtemp(join(tmpdir(), "answered-port-"));
    cleanups.push(async () => { await new Promise(resolve => listener.close(resolve)); await rm(cwd, { recursive: true, force: true }); });
    const agentScript = `fetch("http://127.0.0.1:${port}/respond", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async r=>{if(!r.ok){console.error(r.status,await r.text());process.exitCode=1;return}const j=await r.json();process.exitCode=j.exit})`;
    await db.insert(agents).values({ id: agentId, companyId, name: "Answered port runtime", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", agentScript], cwd },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    const issue = await issueService(db).create(companyId, { title: "Answered port chat", conversationAgentId: agentId,
      conversationUserId: "local-board", assigneeAgentId: agentId, conversationState: "waiting", status: "in_review" });
    issueId = issue.id;
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    app.use("/api", activityRoutes(db));
    app.use(errorHandler);

    /** The person's Send: the real board route. */
    const send = async (body: string) => (await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() }).expect(201)).body as { id: string };
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    /** Wait until the agent has no live run and the chat's execution lock is free. */
    const idle = async (label: string, minTurns = 1) => {
      // Quiet = no live run, the execution lock is free, and the chat row has stopped changing (the completion's
      // settle writes it after the run row turns terminal).
      let quietSince = 0, stamp = "";
      for (let i = 0; i < 600; i += 1) {
        const live = (await runs()).filter(run => ["queued", "running", "scheduled_retry"].includes(run.status));
        const [current] = await db.select().from(issues).where(eq(issues.id, issueId));
        const now = `${current!.status}/${current!.conversationState}/${current!.updatedAt.toISOString()}/${turns.length}`;
        if (turns.length >= minTurns && live.length === 0 && !current!.executionRunId && now === stamp) {
          if (Date.now() - quietSince >= 1_500) return;
        } else { quietSince = Date.now(); stamp = now; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`${label}: ${JSON.stringify({ turns: turns.length, runs: (await runs()).map(run => ({ id: run.id, status: run.status,
        error: run.error, errorCode: run.errorCode })) })}`);
    };
    /** The person's screen, from the real GETs. */
    const screen = async () => {
      const got = (await request(app).get(`/api/issues/${issueId}`).expect(200)).body as { status: string; conversationState?: string };
      const comments = (await request(app).get(`/api/issues/${issueId}/comments`).expect(200)).body as Array<{
        id: string; body: string; authorType?: string | null; metadata?: Record<string, unknown> | null }>;
      const notices = comments.filter(comment => String(comment.metadata?.authorizationReason ?? "").startsWith(UNANSWERED_MESSAGE_REASON_PREFIX));
      return { status: got.status, statusRow: got.status === "in_review" ? "In Review" : got.status === "in_progress" ? "In Progress" : got.status,
        notices: notices.map(notice => notice.body), agentReplies: comments.filter(comment => comment.authorType === "agent").map(comment => comment.body) };
    };
    /** The REAL sweep, 20 minutes on (past its settle, start and repair bounds). */
    const sweep = () => settleUnansweredPersonMessages(db, { companyId, issueId, now: new Date(Date.now() + 20 * 60_000) });
    /** The one function's verdict per person message, as its callers build it. */
    const answered = async (id: string) => (await db.select({ answered: sql<boolean>`${answeredPersonMessageSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}` })
      .from(issueComments).where(eq(issueComments.id, id)))[0]!.answered;
    const stored = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    /** PARITY: the Status row says "In Review" exactly when the sweep owes this chat's messages nothing. */
    const parity = async (label: string, messageIds: string[]) => {
      const verdicts = await Promise.all(messageIds.map(answered));
      const swept = await sweep();
      const seen = await screen();
      const allAnswered = verdicts.every(Boolean);
      expect.soft({ label, statusRow: seen.statusRow, sweepNotices: seen.notices.length },
        `${label}: the Status row and the sweep agree`).toEqual({ label, statusRow: allAnswered ? "In Review" : "In Progress",
        sweepNotices: allAnswered ? 0 : 1 });
      return { verdicts, swept, seen };
    };
    return { companyId, agentId, issueId, app, script, turns, send, idle, screen, sweep, answered, stored, parity, runs };
  }

  it("control: a final reply from the run that carries M -> In Review, no notice", async () => {
    const c = await chat();
    c.script.push({ reply: "Here is the answer." });
    const m = await c.send("Please answer.");
    await c.idle("final reply");
    const { verdicts, seen } = await c.parity("final reply", [m.id]);
    expect(verdicts).toEqual([true]);
    expect(seen).toMatchObject({ statusRow: "In Review", notices: [], agentReplies: ["Here is the answer."] });
    const activity = (await request(c.app).get(`/api/issues/${c.issueId}/activity`).expect(200)).body as Array<{ action: string; details?: Record<string, unknown> }>;
    expect(activity.filter(row => row.action === "issue.updated" && row.details?.status === "in_review")).toHaveLength(1);
  }, 60_000);

  it("case 1, progress-only: the run only reported progress -> In Progress beside the one 'finished without a reply' notice (never In Review)", async () => {
    const c = await chat();
    c.script.push({ progress: "Still working on it." });
    const m = await c.send("Please answer.");
    await c.idle("progress only");
    const { verdicts, seen } = await c.parity("progress only", [m.id]);
    expect(verdicts, "the one function: a progress comment is not an answer").toEqual([false]);
    expect(seen.statusRow).toBe("In Progress");
    expect(seen.notices).toHaveLength(1);
    const activity = (await request(c.app).get(`/api/issues/${c.issueId}/activity`).expect(200)).body as Array<{ action: string; details?: Record<string, unknown> }>;
    expect(activity.filter(row => row.action === "issue.updated" && row.details?.status === "in_review"),
      "no 'changed status to in review' activity line for an unanswered message").toHaveLength(0);
  }, 60_000);

  it("case 2, a pending card from a run that then FAILED: the person has a card to answer -> In Review, no notice", async () => {
    const c = await chat();
    c.script.push({ card: true, exit: 1 });
    const m = await c.send("Pick a color for me.");
    await c.idle("card then failure");
    const failed = (await c.runs()).find(run => run.id === c.turns[0]!.runId)!;
    expect(failed.status).toBe("failed");
    const { verdicts, seen } = await c.parity("pending card from a failed run", [m.id]);
    expect(verdicts, "the one function: an answerable card answers M whatever the run's later status").toEqual([true]);
    expect(seen).toMatchObject({ statusRow: "In Review", notices: [] });
  }, 60_000);

  it("case 3, card lifecycle: a pending card parks the chat; the person's answer keeps M answered; an EXPIRED card (planted) owes M again and a later reply does not hide it", async () => {
    const c = await chat();
    c.script.push({ card: true });
    const m = await c.send("Pick a color for me.");
    await c.idle("card");
    expect((await c.parity("pending card", [m.id])).seen).toMatchObject({ statusRow: "In Review", notices: [] });
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, c.issueId));
    // PLANTED: the system expired the card unanswered (status + outcome, as the expiry writes them).
    await db.update(issueThreadInteractions).set({ status: "expired", result: { version: 1, outcome: "expired" }, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(issueThreadInteractions.id, card!.id));
    expect(await c.answered(m.id), "the one function: an expired card no longer answers M").toBe(false);
    // The person writes again; the run answers only the new message.
    c.script.push({ reply: "Noted." });
    const m2 = await c.send("Never mind the color.");
    await c.idle("after expiry", 2);
    const { verdicts, seen } = await c.parity("expired card, then a reply to a later message", [m.id, m2.id]);
    if (verdicts[0]) expect(seen.statusRow, "the real carry gave the later run M too: it is answered").toBe("In Review");
    else expect(seen, "M is owed: the Status row stays In Progress beside M's notice").toMatchObject({ statusRow: "In Progress" });
  }, 90_000);

  it("case 4, a reply to a LATER message: M1's run finished with no reply, M2's run answered M2 -> In Progress while M1 is owed", async () => {
    const c = await chat();
    c.script.push({});
    const m1 = await c.send("First question.");
    await c.idle("first has no reply");
    expect((await c.screen()).statusRow, "a run with no reply parks nothing").toBe("In Progress");
    c.script.push({ reply: "Answer to the second question." });
    const m2 = await c.send("Second question.");
    await c.idle("second answers", 2);
    const second = c.turns.find(turn => turn.context.wakeCommentId === m2.id);
    expect(second, "the real wake names M2").toBeDefined();
    const { verdicts, seen } = await c.parity("reply to a later message", [m1.id, m2.id]);
    expect(verdicts[1], "M2 is answered by its own run's reply").toBe(true);
    // The REAL producer decides whether M2's run also carried M1 (wakeCommentIds); the Status row follows either way.
    expect((second!.context.wakeCommentIds as string[] | undefined) ?? [m2.id], "the real wake carried only M2").toEqual([m2.id]);
    expect(verdicts[0], "a reply to the later M2 never answers M1").toBe(false);
    expect(seen.statusRow, "no 'In Review' beside M1's notice").toBe("In Progress");
    expect(seen.notices).toHaveLength(1);
  }, 90_000);

  it("case 5, batched [M1, M2] (planted primary wake; the real batch producer's row is agent-conversations.test.ts 'after a person's Stop ... one turn with the waiting messages'): both in the run's own input, one reply -> In Review, no notice", async () => {
    const c = await chat();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    c.script.push({ hold: () => gate, reply: "Answer to the opener." }, { hold: () => second, reply: "Answer to both." });
    let sent!: () => void;
    const second = new Promise<void>(resolve => { sent = resolve; });
    const m0 = await c.send("Opener.");
    for (let i = 0; i < 200 && c.turns.length < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 50));
    const m1 = await c.send("Batch one.");
    release();
    for (let i = 0; i < 400 && c.turns.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 50));
    const m2 = await c.send("Batch two.");
    // PLANTED: M1's running turn is given the batch shape the queue writes when it hands two waiting messages to one
    // turn (primary wake = the EARLIER message, wakeCommentIds = both). Its reply and its settle are the real ones.
    const batchRun = c.turns[1]!;
    expect(batchRun.context.wakeCommentId).toBe(m1.id);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...batchRun.context, wakeCommentIds: [m1.id, m2.id] } }).where(eq(heartbeatRuns.id, batchRun.runId));
    // ... and M2's own wake is withdrawn, as a batch leaves none behind.
    await db.execute(sql`update agent_wakeup_requests set status = 'cancelled', finished_at = now() where company_id = ${c.companyId}::uuid
      and status in ('queued', 'deferred_issue_execution', 'claimed') and payload->>'commentId' = ${m2.id}`);
    await db.execute(sql`update heartbeat_runs set status = 'cancelled', finished_at = now() where company_id = ${c.companyId}::uuid
      and status = 'queued' and context_snapshot->>'wakeCommentId' = ${m2.id}`);
    sent();
    await c.idle("batched", 2);
    const { verdicts, seen } = await c.parity("batched", [m0.id, m1.id, m2.id]);
    expect(verdicts, "the one function: the batch run's own input names M1 and M2").toEqual([true, true, true]);
    expect(seen, "upstream's positional test read M2 as 'a later message' and kept the chat In Progress").toMatchObject({ statusRow: "In Review", notices: [] });
    expect(c.turns, "no further turn ran for M2").toHaveLength(2);
  }, 90_000);

  it("handled (a card answer's reply boundary): a progress-only message is NOT swept into the answer to an earlier card", async () => {
    const c = await chat();
    c.script.push({ card: true }, { progress: "Looking into the second thing." });
    const m0 = await c.send("Pick a color for me.");
    await c.idle("card");
    const m1 = await c.send("Also: what is the capital of France?");
    await c.idle("progress only", 2);
    expect(await c.answered(m1.id), "the one function: M1 only got a progress comment").toBe(false);
    // The person answers the earlier card: the real respond route, which wakes the answer-resume run.
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, c.issueId));
    c.script.push({ reply: "You chose Blue." });
    await request(c.app).post(`/api/issues/${c.issueId}/interactions/${card!.id}/respond`)
      .send({ answers: [{ questionId: "q1", optionIds: ["blue"] }] }).expect(res => { if (res.status >= 300) throw new Error(JSON.stringify(res.body)); });
    await c.idle("answer resume", 3);
    const resume = c.turns.find(turn => turn.context.interactionId === card!.id);
    expect(resume, `the real respond route woke a run that names the card: ${JSON.stringify(c.turns.map(turn => turn.context))}`).toBeDefined();
    // prepareConversationTurn's reply boundary (the REAL producer wrote it on the run): it must not name M1.
    expect(resume!.context.conversationReplyBoundaryCommentId ?? m0.id, "the boundary stops before the unanswered M1").toBe(m0.id);
    expect(await c.answered(m1.id), "so the card answer's reply does not count as M1's answer").toBe(false);
    const { seen } = await c.parity("card answer beside an owed message", [m0.id, m1.id]);
    expect(seen.statusRow).toBe("In Progress");
  }, 120_000);
});
