import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { conversationEventColumns, conversationEventCondition } from "./conversation-events.js";
import { chatHistoryReadEvents, compactChatHistoryReadEvents, continuousChatHistoryReadEvents, historyReadRunA, historyReadRunB } from "../../__tests__/fixtures/chat-history-reads.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("compact history delivery evidence in PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("conversation-reads-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each([
    { label: "first run", rows: chatHistoryReadEvents(historyReadRunA), compact: compactChatHistoryReadEvents(historyReadRunA) },
    { label: "second run", rows: chatHistoryReadEvents(historyReadRunB), compact: compactChatHistoryReadEvents(historyReadRunB) },
    { label: "continuous turn", rows: continuousChatHistoryReadEvents(false, true, true), compact: continuousChatHistoryReadEvents(true, true, true) },
  ])("retains the full read/ACK lifecycle and identity with cursor pagination ($label)", async fixture => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "History fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", adapterType: "process", status: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    const remap = (event: ReturnType<typeof chatHistoryReadEvents>[number]) => ({
      ...event, companyId, agentId, runId, payload: { prpEvent: {
        ...(event.payload!.prpEvent as object), runId,
      } },
    });
    const rows = fixture.rows.map(remap);
    // Database id is generated; comparison below uses seq and the wire envelope.
    await db.insert(heartbeatRunEvents).values(rows.map(({ id: _id, ...row }) => row));
    const expected = fixture.compact.map(remap);
    const actual: Array<Pick<typeof heartbeatRunEvents.$inferSelect, "seq" | "eventType" | "payload">> = [];
    let cursor = 0;
    for (;;) {
      // Same columns, predicate and cursor/order as run-state.listEvents.
      const page = await db.select(conversationEventColumns(runId)).from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, cursor), conversationEventCondition(runId)))
        .orderBy(asc(heartbeatRunEvents.seq)).limit(2);
      if (!page.length) break;
      actual.push(...page);
      cursor = page.at(-1)!.seq;
    }
    expect(actual.map(row => ({ seq: row.seq, eventType: row.eventType, payload: row.payload })))
      .toEqual(expected.map(row => ({ seq: row.seq, eventType: row.eventType, payload: row.payload })));
    expect(actual.map(row => row.seq)).toEqual(expected.map(row => row.seq));
  });
});
