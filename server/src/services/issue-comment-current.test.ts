// The SQL mirror of agent-conversations.ts isConversationReset must agree with it on every body shape, on real
// PostgreSQL (SMAA-1909: a person's "/new" is a command and a boundary, never a message owed a reply).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { isConversationReset } from "./agent-conversations.js";
import { conversationResetSql } from "./issue-comment-current.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("conversationResetSql = isConversationReset", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("conversation-reset-sql-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  const bodies = ["/new", " /new ", "\t/new\n", "\r\n/new\r\n", "\u000b\u000c/new", "\u00a0/new\u3000", "\ufeff/new\u2028",
    "\u2029\u1680\u2000/new\u200a\u202f\u205f", "/new\u200b", "\u200b/new", "/NEW", "/new x", "x /new", "//new", "/new/", "new", "", "  ", "/ne w"];

  it("agrees with isConversationReset on every body shape, and requires a person author like Paperclip's callers", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reset parity", issuePrefix: companyId.slice(0, 8) });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat" });
    const rows = await db.insert(issueComments).values([
      ...bodies.map(body => ({ companyId, issueId, body, authorType: "user" as const, authorUserId: "person" })),
      { companyId, issueId, body: "/new", authorType: "system" as const, authorUserId: null },
    ]).returning();
    const matched = new Set((await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
      conversationResetSql({ body: issueComments.body, authorUserId: issueComments.authorUserId })))).map(row => row.id));
    const mismatches = rows.filter(row => matched.has(row.id) !== Boolean(row.authorUserId && isConversationReset(row.body)))
      .map(row => JSON.stringify(row.body));
    expect(mismatches).toEqual([]);
    expect(rows.filter(row => matched.has(row.id)).length, "the reset shapes in the table").toBe(8);
  });
});
