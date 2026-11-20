import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { answeredPersonMessageIds } from "../services/person-message-answer.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("RFL by-purpose legacy arms", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("amma-legacy-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture(old = false) {
    const epoch = Date.now() - (old ? 3 * 86400_000 : 900_000), at = (m: number) => new Date(epoch + m * 60_000);
    const [company] = await db.insert(companies).values({ name: "Paul daily task history", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Daily agent", status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Read the README", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [m] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "paul", body: "Please read the README", createdAt: at(1) }).returning();
    const run = async (ids = [m.id], minute = 2) => (await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id, status: "succeeded", createdAt: at(minute), startedAt: at(minute), finishedAt: at(minute + 1), contextSnapshot: { issueId: issue.id, wakeCommentIds: ids } }).returning())[0]!;
    const answered = async () => [...await answeredPersonMessageIds(db, { companyId: company.id, issueId: issue.id, commentIds: [m.id] })];
    return { company, agent, issue, m, at, run, answered };
  }
  it("later-person-reached: replying to N does not answer carried M", async () => {
    const f = await fixture(); await f.run();
    const [n] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", body: "Next question", createdAt: f.at(4) }).returning();
    const r = await f.run([n.id], 5);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "agent", authorAgentId: f.agent.id, createdByRunId: r.id, body: "Answer only to N", createdAt: f.at(7) });
    expect(await f.answered()).toEqual([]);
  });
  it.each(["pending-addressed", "person-answered", "system-created", "before-carry", "other-message"])("interaction %s", async variant => {
    const f = await fixture(); const r = await f.run();
    await db.insert(issueThreadInteractions).values({ companyId: f.company.id, issueId: f.issue.id, kind: "question", status: variant === "person-answered" ? "answered" : "pending", sourceRunId: r.id,
      createdByAgentId: variant === "system-created" ? null : f.agent.id, originCommentIds: variant === "other-message" ? [] : [f.m.id],
      resolvedByUserId: variant === "person-answered" ? "paul" : null, addresseeUserId: "paul", payload: { question: "Which README?" } as never,
      createdAt: f.at(variant === "before-carry" ? 1.5 : 4) });
    expect(await f.answered()).toEqual(variant === "pending-addressed" ? [f.m.id] : []);
    const outcome = await settleUnansweredPersonMessage(db, { companyId: f.company.id, issueId: f.issue.id });
    if (variant === "pending-addressed") expect(outcome.kind).toBe("answered");
    else expect(outcome.kind).not.toBe("answered");
  });
  it.each([false, true])("imported message requires posted reply: %s", async posted => {
    const f = await fixture(true);
    await db.update(issueComments).set({ origin: "import" }).where(eq(issueComments.id, f.m.id));
    if (posted) await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "agent", authorAgentId: f.agent.id, origin: "import", body: "The imported README reply", createdAt: f.at(4) });
    expect(await f.answered()).toEqual(posted ? [f.m.id] : []);
  });
  it("bare old TASK: 34 owed comments on 25 issues get zero notes and zero runs", async () => {
    let notes = 0, runs = 0;
    for (let n = 0; n < 25; n++) {
      const f = await fixture(true);
      if (n < 9) await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "user", authorUserId: "paul", body: "Another old task message", createdAt: f.at(2) });
      await settleUnansweredPersonMessage(db, { companyId: f.company.id, issueId: f.issue.id });
      notes += (await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).filter(c => c.authorType === "system").length;
      runs += (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).length;
    }
    console.log("AMMA-BARE-OLD-TASKS", JSON.stringify({ comments: 34, issues: 25, notes, runs }));
    expect(notes).toBe(0); expect(runs).toBe(0);
  });
});
