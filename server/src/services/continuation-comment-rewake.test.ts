// The re-wake loop (gate TES-144, org 19:48Z): 9edb70e2 made every continuation carry the parent's wake comments,
// so each assigned-work sweep turn re-presented a person comment the agent had ALREADY answered; the agent answered
// again, the task stayed in_progress, and the sweep woke it again. RFL's bar (20:03Z): a continuation carries exactly
// the person's comments that have NO published agent response after them; r6's purpose (an unanswered comment of a
// parent that failed, or whose response was never published) must still be carried. Real PostgreSQL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { assignedWorkSweep } from "./recovery/assigned-work-sweep.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuation comment carry: never re-present an answered comment", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("continuation-rewake-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(parent: { status: "succeeded" | "failed"; carried?: "message" | "message_and_mid_run" }) {
    const t0 = Date.now() - 2 * 3600_000;
    const at = (ms: number) => new Date(t0 + ms);
    const [company] = await db.insert(companies).values({ name: "Rewake", issuePrefix: `R${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Coder", adapterType: "paperclip_runner", status: "active",
      createdAt: at(-60_000), updatedAt: at(-60_000) }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "A task", status: "in_progress", assigneeAgentId: agent!.id,
      createdByUserId: "board", createdAt: at(0), updatedAt: at(0) }).returning();
    const [message] = await db.insert(issueComments).values({ companyId: company!.id, issueId: issue!.id, authorType: "user", authorUserId: "board",
      body: "Please do X.", createdAt: at(1_000) }).returning();
    const [midRun] = parent.carried === "message_and_mid_run" ? await db.insert(issueComments).values({ companyId: company!.id, issueId: issue!.id,
      authorType: "user", authorUserId: "board", body: "Also Y, please.", createdAt: at(40_000) }).returning() : [];
    const wakeCommentIds = [message!.id, ...(midRun ? [midRun.id] : [])];
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, nativeIssueId: issue!.id, runtimeMode: "native",
      status: parent.status, responsibleUserId: "board",
      contextSnapshot: { issueId: issue!.id, wakeReason: "issue_commented", wakeCommentId: wakeCommentIds.at(-1), wakeCommentIds },
      createdAt: at(2_000), startedAt: at(3_000), finishedAt: at(60_000) }).returning();
    const reply = (ms: number) => db.insert(issueComments).values({ companyId: company!.id, issueId: issue!.id, authorType: "agent",
      authorAgentId: agent!.id, createdByRunId: run!.id, body: "Done X.", createdAt: at(ms) }).returning();
    return { companyId: company!.id, issueId: issue!.id, agentId: agent!.id, run: run!, message: message!, midRun, at, reply };
  }

  it("(a) the org's loop: the parent SUCCEEDED and published its answer -> the carry set is EMPTY, and the sweep's wake re-presents nothing", async () => {
    const f = await fixture({ status: "succeeded" });
    await f.reply(30_000);
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }), "an answered comment is not carried").toEqual({});
    // A run already seeded the old way re-delivers nothing either (first-turn-queued-input reads the same function).
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { commentContinuation: true,
      wakeCommentIds: [f.message.id], wakeCommentId: f.message.id, commentId: f.message.id } })).toEqual({});
    // The real assigned-work sweep over a simulated hour: its wake carries no comment, as on M1.2.
    let clock = f.at(90_000).getTime();
    const wakes: Array<Record<string, unknown>> = [];
    const sweep = assignedWorkSweep(db, { now: () => new Date(clock), enqueueWakeup: async (agentId, opts) => {
      wakes.push(opts.contextSnapshot);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId,
        contextSnapshot: opts.contextSnapshot, createdAt: new Date(clock), startedAt: new Date(clock + 1_000), finishedAt: new Date(clock + 30_000) });
      return { id: randomUUID() };
    } });
    for (const end = clock + 60 * 60_000; clock <= end; clock += 30_000) await sweep.checkIssue({ companyId: f.companyId, issueId: f.issueId });
    expect(wakes, "one sweep turn in the hour, then rest (M1.2)").toHaveLength(1);
    expect(wakes.every(context => context.wakeCommentIds === undefined && context.wakeCommentId === undefined
      && context.commentId === undefined && context.commentContinuation === undefined), "no answered comment re-presented").toBe(true);
  }, 60_000);

  it("(b) a comment that arrived MID-RUN under a SUCCEEDED parent, after its reply, is still carried; the answered one is not", async () => {
    const f = await fixture({ status: "succeeded", carried: "message_and_mid_run" });
    await f.reply(30_000);
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }))
      .toMatchObject({ commentContinuation: true, wakeCommentIds: [f.midRun!.id], wakeCommentId: f.midRun!.id, commentId: f.midRun!.id });
  });

  it("(c) a FAILED parent's unanswered comment is still carried (r6's purpose)", async () => {
    const f = await fixture({ status: "failed" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }))
      .toMatchObject({ commentContinuation: true, wakeCommentIds: [f.message.id], wakeCommentId: f.message.id });
  });

  it("(d) a SUCCEEDED parent whose response was never published (publication failed or pending retry, or a yield with no visible reply) still carries the comment", async () => {
    const f = await fixture({ status: "succeeded" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id }))
      .toMatchObject({ commentContinuation: true, wakeCommentIds: [f.message.id], wakeCommentId: f.message.id });
  });
});
