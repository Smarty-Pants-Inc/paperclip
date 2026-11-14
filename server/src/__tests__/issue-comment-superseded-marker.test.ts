// RFL VERDICT-supnotice-6b885941 F1 (11:20Z, score 20): the comments read path must carry B''s supersession
// marker. Real PostgreSQL, the production B' writers and the production issueService reads; no injected rows.
// Keep reason: a kept superseded note (never deleted, org 09:18Z) is history only if its readers see the marker.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { issueCommentMetadataSchema } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
type Meta = Record<string, unknown> | null;

describe("shared comment metadata: supersededBy (B' never-delete marker)", () => {
  it("accepts an optional comment-id string and rejects any other shape", () => {
    const base = { version: 1 as const, sections: [{ rows: [{ type: "text" as const, text: "x" }] }] };
    const id = randomUUID();
    expect((issueCommentMetadataSchema.parse({ ...base, supersededBy: id }) as Meta)?.supersededBy).toBe(id);
    expect((issueCommentMetadataSchema.parse(base) as Meta)?.supersededBy).toBeUndefined();
    expect(issueCommentMetadataSchema.safeParse({ ...base, supersededBy: 42 }).success).toBe(false);
    expect(issueCommentMetadataSchema.safeParse({ ...base, supersededBy: "" }).success).toBe(false);
  });
});

describe.skipIf(!support.supported)("RFL supnotice F1: issueService list/get return B''s supersededBy marker from PostgreSQL", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("superseded-marker-"); db = createDb(temp.connectionString); }, 60000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function heldChat() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: userId + "@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "Marker", issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "blocked", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId, body: "Please continue", createdAt: at(-300_000) });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      createdAt: at(-240_000), finishedAt: at(-180_000), errorCode: "native_continuation_requires_reconciliation", error: null, contextSnapshot: { issueId } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board", status: "active",
      cause: "native_continuation_requires_reconciliation", fingerprint: "marker:" + runId, nextAction: "Inspect", evidence: { runId } });
    const settle = (ms = 0) => settleUnansweredPersonMessage(db, { companyId, issueId, now: at(ms) });
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    return { companyId, agentId, issueId, userId, at, settle, notes };
  }

  async function expectReadsCarryMarker(issueId: string, noteId: string, supersededBy: string) {
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, noteId));
    expect((stored!.metadata as Meta)?.supersededBy, "the writer stored the marker").toBe(supersededBy);
    expect(stored!.deletedAt).toBeNull();
    const service = issueService(db);
    const listed = (await service.listComments(issueId, { order: "asc" })).find(c => c.id === noteId);
    const exact = await service.getComment(noteId);
    for (const [read, row] of [["listComments", listed], ["getComment", exact]] as const) {
      expect(row, `${read} returns the kept note`).toBeTruthy();
      expect(row!.metadata, `${read} must not drop the note's metadata`).not.toBeNull();
      expect((row!.metadata as Meta)?.supersededBy, `${read} carries the durable supersession marker`).toBe(supersededBy);
      expect(row!.metadata?.authorizationReason).toBe((stored!.metadata as Meta)?.authorizationReason);
      expect(row!.metadata?.sections, `${read} keeps the rest of the structured metadata`).toEqual((stored!.metadata as Meta)?.sections);
    }
  }

  it("an answered held note (marked by the answer writer) reads back with supersededBy = the answer", async () => {
    const f = await heldChat();
    await f.settle();
    const [note] = await f.notes();
    expect(note).toBeDefined();
    const [answer] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, body: "Here is your answer", createdAt: f.at(1000) }).returning();
    expect((await f.settle(2000)).kind).toBe("answered");
    await expectReadsCarryMarker(f.issueId, note!.id, answer!.id);
  });

  it("an earlier held note (marked by a later message's held note) reads back with supersededBy = the current note; the current note has none", async () => {
    const f = await heldChat();
    await f.settle();
    const [first] = await f.notes();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: f.userId,
      body: "Still there?", createdAt: f.at(1000) });
    await f.settle(130_000);
    const rows = await f.notes();
    expect(rows).toHaveLength(2);
    const current = rows.find(n => n.id !== first!.id)!;
    await expectReadsCarryMarker(f.issueId, first!.id, current.id);
    const read = await issueService(db).getComment(current.id);
    expect(read!.metadata).not.toBeNull();
    expect((read!.metadata as Meta)?.supersededBy).toBeUndefined();
  });
});
