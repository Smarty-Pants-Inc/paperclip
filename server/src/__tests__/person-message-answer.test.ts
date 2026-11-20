import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { answeredPersonMessageIds } from "../services/person-message-answer.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const supported = await getEmbeddedPostgresTestSupport();
(supported.supported ? describe : describe.skip)("RULE-ANSWERED-MEANS-ANSWERED-1119 posted AFTER reading", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("amma-posted-after-read-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  it.each([
    { label: "unposted commentary", replyMinute: null, status: "succeeded", progress: false, answered: false },
    { label: "posted before read", replyMinute: 2, status: "succeeded", progress: false, answered: false },
    { label: "posted after read", replyMinute: 4, status: "succeeded", progress: false, answered: true },
    { label: "unrelated own final after read without a matching text segment", replyMinute: 4, status: "succeeded", progress: false, answered: false, streamText: false },
    { label: "P1 progress then FAIL", replyMinute: 4, status: "failed", progress: true, answered: false },
    { label: "P2 progress then SUCCEED", replyMinute: 4, status: "succeeded", progress: true, answered: false },
    { label: "failed-run reply", replyMinute: 4, status: "failed", progress: false, answered: false },
    { label: "timed_out reply", replyMinute: 4, status: "timed_out", progress: false, answered: false },
    { label: "cancelled reply", replyMinute: 4, status: "cancelled", progress: false, answered: false },
  ])("$label", async row => {
    const epoch = Date.now() - 10 * 60_000, at = (minute: number) => new Date(epoch + minute * 60_000);
    const [company] = await db.insert(companies).values({ name: "Paul's saved daily conversation", issuePrefix: "AMMA" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Daily agent", role: "engineer", status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Read my README", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [message] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "paul", body: "Please answer my saved README question", createdAt: at(1) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: row.status,
      runtimeMode: "native", nativeIssueId: issue.id, createdAt: at(0), startedAt: at(0), finishedAt: at(5),
      contextSnapshot: { issueId: issue.id, steeredCommentIds: [message.id], answeredSteeredCommentIds: "streamText" in row && !row.streamText ? [] : [message.id],
        steeredDeliveredAts: { [message.id]: at(3).toISOString() } } }).returning();
    if (row.replyMinute !== null) {
      const [reply] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id,
        createdByRunId: run.id, body: row.progress ? "I'm checking; I'll get back to you." : "Here is the README answer.", createdAt: at(row.replyMinute) }).returning();
      if (row.progress) await db.execute(sql`update heartbeat_runs set result_json = jsonb_build_object('semanticToolReceipts', jsonb_build_object('p', jsonb_build_object('operationId', 'report_progress', 'result', jsonb_build_object('commentId', ${reply.id}::text)))) where id = ${run.id}::uuid`);
    }
    const answered = [...await answeredPersonMessageIds(db, { companyId: company.id, issueId: issue.id, commentIds: [message.id] })];
    console.log("AMMA-POSTED-AFTER-READ", JSON.stringify({ row: row.label, messageId: message.id, runId: run.id, answered }));
    expect(answered).toEqual(row.answered ? [message.id] : []);
  });
});
