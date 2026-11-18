// ANSWERED, the one rule (RFL binding scope 2026-11-18 14:23Z; challenge-r2 5.1): a reply counts for message M only
// if it comes after M from a run that SUCCEEDED and whose OWN input names M. Real PostgreSQL; every row goes through
// the continuation carry's real path (readContinuationCommentInput -> pendingContinuationCommentInput) and reads the
// one shared predicate (answeredPersonMessageSql), which the unanswered-message notice calls too.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { answeredPersonMessageSql, ISSUE_IMPORTED_ACTION } from "./person-message-answer.js";
import { settleUnansweredPersonMessage } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("ANSWERED rows: the one rule, through the continuation carry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("answered-rows-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const t0 = Date.now() - 2 * 3600_000;
    const at = (ms: number) => new Date(t0 + ms);
    const [company] = await db.insert(companies).values({ name: "Answered rows", issuePrefix: `A${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Coder", adapterType: "paperclip_runner", status: "active",
      createdAt: at(-60_000), updatedAt: at(-60_000) }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "A task", status: "in_progress", assigneeAgentId: agent!.id,
      createdByUserId: "board", createdAt: at(0), updatedAt: at(0) }).returning();
    const companyId = company!.id, issueId = issue!.id, agentId = agent!.id;
    const message = async (ms: number, values: Partial<typeof issueComments.$inferInsert> = {}) => (await db.insert(issueComments).values({
      companyId, issueId, authorType: "user", authorUserId: "board", body: "Please do X.", createdAt: at(ms), ...values }).returning())[0]!;
    /** A run whose OWN input names exactly these messages. */
    const run = async (status: string, own: string[], ms: number, resultJson?: Record<string, unknown>) => (await db.insert(heartbeatRuns).values({
      companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status, responsibleUserId: "board", resultJson: resultJson ?? null,
      contextSnapshot: { issueId, wakeReason: "issue_commented", ...(own.length ? { wakeCommentId: own.at(-1), wakeCommentIds: own } : {}) },
      createdAt: at(ms), startedAt: at(ms + 1_000),
      finishedAt: ["queued", "running", "scheduled_retry"].includes(status) ? null : at(ms + 50_000) }).returning())[0]!;
    const reply = async (runId: string, ms: number, body = "Done X.") => (await db.insert(issueComments).values({ companyId, issueId,
      authorType: "agent", authorAgentId: agentId, createdByRunId: runId, body, createdAt: at(ms) }).returning())[0]!;
    /** The one predicate, as its two production callers build it. */
    const answered = async (id: string) => (await db.select({ answered: sql<boolean>`${answeredPersonMessageSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}` })
      .from(issueComments).where(eq(issueComments.id, id)))[0]!.answered;
    /** The carry's real path: what a successor of this run is given as still-pending person input. */
    const carried = async (runId: string) => (await readContinuationCommentInput(db, { companyId, issueId, runId })).wakeCommentIds ?? [];
    /** The other caller: the unanswered-message notice's decision for the task's last person message. */
    const notice = async () => (await settleUnansweredPersonMessage(db, { companyId, issueId, now: at(40 * 60_000) })).kind;
    return { companyId, issueId, agentId, at, message, run, reply, answered, carried, notice };
  }

  it.each(["failed", "cancelled", "timed_out", "interrupted", "running"])(
    "(a) M carried by a %s run that posted a reply -> M is NOT answered: it is carried again and the notice still owes it", async status => {
    const f = await fixture();
    const m = await f.message(1_000);
    const r = await f.run(status, [m.id], 2_000);
    await f.reply(r.id, 30_000);
    expect.soft(await f.answered(m.id), `a ${status} run's reply is not an answer`).toBe(false);
    expect.soft(await f.carried(r.id), "the continuation carries M again").toEqual([m.id]);
    if (status !== "running") expect.soft(await f.notice(), "the notice does not read it as answered").not.toBe("answered");
    // Control: the SAME run and reply, once the run SUCCEEDED, is the answer (the rule reads the run's outcome).
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: f.at(52_000) }).where(eq(heartbeatRuns.id, r.id));
    expect.soft(await f.answered(m.id), "control: succeeded -> answered").toBe(true);
    expect(await f.carried(r.id), "control: succeeded -> not carried").toEqual([]);
  });

  it("(b) a reply from a SUCCEEDED run whose own input is a LATER message M2 -> M is NOT answered; M2 is", async () => {
    const f = await fixture();
    const m = await f.message(1_000);
    const first = await f.run("failed", [m.id], 2_000);
    const m2 = await f.message(60_000, { body: "And Y?" });
    const second = await f.run("succeeded", [m2.id], 61_000);
    await f.reply(second.id, 90_000, "Y is done.");
    expect.soft(await f.answered(m.id), "a reply to the later M2 never answers M").toBe(false);
    expect.soft(await f.carried(first.id), "M is still carried from its own run").toEqual([m.id]);
    expect.soft(await f.answered(m2.id), "M2 is answered by its own run's reply").toBe(true);
    expect(await f.carried(second.id), "M2 is not carried again").toEqual([]);
  });

  it("(c) a progress comment from a succeeded run with no final -> NOT answered; status alone is never an answer", async () => {
    const f = await fixture();
    const m = await f.message(1_000);
    const r = await f.run("succeeded", [m.id], 2_000);
    expect.soft(await f.answered(m.id), "a succeeded run with no reply answers nothing").toBe(false);
    const progress = await f.reply(r.id, 20_000, "Working on X: step 1 of 3.");
    // The run's own report_progress receipt, as the runner tool authority records it (the server's own rule for
    // "not the final answer": heartbeat-run-summary.ts findHeartbeatRunCompletionComment).
    await db.update(heartbeatRuns).set({ resultJson: { semanticToolReceipts: { "progress-1": { operationId: "report_progress",
      result: { commentId: progress.id } } } } }).where(eq(heartbeatRuns.id, r.id));
    expect.soft(await f.answered(m.id), "a progress comment is not an answer").toBe(false);
    expect.soft(await f.carried(r.id), "M is carried again").toEqual([m.id]);
    expect.soft(await f.notice()).not.toBe("answered");
    // Control: the same run's final reply (no progress receipt names it) answers M.
    await f.reply(r.id, 40_000, "X is done.");
    expect.soft(await f.answered(m.id), "control: the final answers").toBe(true);
    expect(await f.carried(r.id)).toEqual([]);
  });

  it("(d) a reply dated before M, or at M's own instant, is NOT an answer to M", async () => {
    const f = await fixture();
    const m = await f.message(60_000);
    const r = await f.run("succeeded", [m.id], 2_000);
    await f.reply(r.id, 30_000, "Written before M.");
    await f.reply(r.id, 60_000, "Written at M's instant.");
    expect.soft(await f.answered(m.id)).toBe(false);
    expect.soft(await f.carried(r.id), "M is carried again").toEqual([m.id]);
    // Control: one millisecond after M, the same run's reply answers it.
    await f.reply(r.id, 60_001, "Written after M.");
    expect(await f.answered(m.id), "control: a reply after M answers").toBe(true);
  });

  it("(e) a succeeded run whose own input names M posted a final after M -> answered once: never carried again", async () => {
    const f = await fixture();
    const m = await f.message(1_000);
    const r = await f.run("succeeded", [m.id], 2_000);
    await f.reply(r.id, 30_000);
    expect.soft(await f.answered(m.id)).toBe(true);
    expect.soft(await f.carried(r.id), "not carried from the answering run").toEqual([]);
    expect.soft(await f.notice(), "the notice reads the same answer").toBe("answered");
    // Nor from any later run that names M again (a successor seeded the old way, a failed re-carry): one answer, once.
    const again = await f.run("failed", [m.id], 120_000);
    expect.soft(await f.carried(again.id), "not carried again from a later run that names M").toEqual([]);
    // A later failed run's reply, or a later message, does not un-answer it.
    await f.reply(again.id, 150_000, "Partial.");
    expect(await f.answered(m.id)).toBe(true);
  });

  it("(f) imported history is unchanged: an imported person message is history with no reply; an unmarked one with no arrival record is not", async () => {
    const f = await fixture();
    const marked = await f.message(1_000, { origin: "import" });
    const plain = await f.message(2_000);
    const r = await f.run("failed", [marked.id, plain.id], 3_000);
    expect.soft(await f.answered(marked.id), "origin='import' is history").toBe(true);
    expect.soft(await f.answered(plain.id), "no provenance, no arrival record: not history").toBe(false);
    expect.soft(await f.carried(r.id), "only the live message is carried").toEqual([plain.id]);
    // The legacy arrival record: person comments older than the task's import arrival are history; newer ones are not.
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "import", action: ISSUE_IMPORTED_ACTION,
      entityType: "issue", entityId: f.issueId, createdAt: f.at(10_000) });
    const live = await f.message(20_000, { body: "After the import." });
    const later = await f.run("failed", [plain.id, live.id], 21_000);
    expect.soft(await f.answered(plain.id), "older than the arrival record: history").toBe(true);
    expect.soft(await f.answered(live.id), "newer than the arrival record: live").toBe(false);
    expect(await f.carried(later.id)).toEqual([live.id]);
  });
});
