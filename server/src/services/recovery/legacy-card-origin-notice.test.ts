import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";

// tA-min rf-5 item (c): the C3-2 'direct' shape without the C3-2 carry. A person's
// message M is the origin of a card (sourceCommentId = M). A LEGACY card recorded
// no source run (sourceRunId null). The person answers the card and types a new
// message; the successor carries the card answer + the new typed message (not M,
// the asking origin) and posts its final answer. Persisted PostgreSQL rows and
// the real unanswered sweep; the successor's context is written literally, so
// the first two rows run unchanged at bf2cb905 (green there) and on tA-min.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("legacy card origin (card sourceRunId null): the sweep and the asking message", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("legacy-card-origin-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["legacy card, sourceRunId null", "control: card names its source run", "negative: legacy card with no recorded origin keeps the ONE notice"])("the card's asking origin gets no notice once card + typed input are answered (%s)", async (shape) => {
    const [company] = await db.insert(companies).values({ name: "Legacy card", issuePrefix: `L${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const t0 = Date.now() - 60 * 60_000;
    const [origin] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "board",
      body: "Recall COBALT", createdAt: new Date(t0) }).returning();
    const [asking] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id,
      runtimeMode: "native", status: "failed", responsibleUserId: "board", createdAt: new Date(t0 + 100), startedAt: new Date(t0 + 100),
      finishedAt: new Date(t0 + 900), contextSnapshot: { issueId: issue.id, wakeCommentId: origin.id } }).returning();
    const [card] = await db.insert(issueThreadInteractions).values({ companyId: company.id, issueId: issue.id,
      kind: "ask_user_questions", status: "answered", createdByAgentId: agent.id, sourceRunId: shape.startsWith("control") ? asking.id : null,
      sourceCommentId: shape.startsWith("negative") ? null : origin.id, originCommentIds: [], resolvedByUserId: "board", resolvedAt: new Date(t0 + 1_000), idempotencyKey: randomUUID(),
      createdAt: new Date(t0 + 500),
      payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single", options: [{ id: "yes", label: "YES" }] }] },
      result: { version: 1, answers: [{ questionId: "q", optionIds: ["yes"] }] } } as never).returning();
    const [typed] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "board",
      body: "Also recall COBALT with YES", createdAt: new Date(t0 + 2_000) }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id,
      status: "failed", retryOfRunId: asking.id, createdAt: new Date(t0 + 2_100), startedAt: new Date(t0 + 2_100), finishedAt: new Date(t0 + 2_500),
      contextSnapshot: { issueId: issue.id, wakeCommentId: origin.id, wakeCommentIds: [origin.id, typed.id], interactionId: card.id } }).returning();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id,
      status: "succeeded", retryOfRunId: source.id, createdAt: new Date(t0 + 2_600), startedAt: new Date(t0 + 2_600), finishedAt: new Date(t0 + 3_500),
      contextSnapshot: { issueId: issue.id, wakeCommentId: typed.id, wakeCommentIds: [typed.id], interactionId: card.id, interactionIds: [card.id] } }).returning();
    const [reply] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "agent", authorAgentId: agent.id,
      createdByRunId: successor.id, body: "YES; COBALT remembered.", createdAt: new Date(t0 + 3_000) }).returning();
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: reply.id } } })
      .where(eq(heartbeatRuns.id, successor.id));
    const sweep = await settleUnansweredPersonMessage(db, { companyId: company.id, issueId: issue.id, now: new Date(t0 + 20 * 60_000) });
    const notices = await db.select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata }).from(issueComments)
      .where(and(eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "system")));
    console.log("LEGACY_CARD_ORIGIN_EVIDENCE", JSON.stringify({ shape, originId: origin.id, typedId: typed.id, cardId: card.id, sweep,
      notices: notices.map(n => ({ body: n.body, reason: (n.metadata as any)?.authorizationReason ?? null })) }));
    expect(notices, JSON.stringify(sweep)).toHaveLength(shape.startsWith("negative") ? 1 : 0);
  });
});
