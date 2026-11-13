import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { HELD_PREDECESSOR_NOTICE } from "./native-session-executor.js";
import { readUnsupersededHeldConversationNotice, readUnsupersededHeldConversationNotices,
  writePiSessionHistoryLossNotice } from "./pi-session-recovery-notice.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("held conversation notice", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("held-conversation-notice-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function heldConversation() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Held notice", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Held agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Held task", status: "in_progress", assigneeAgentId: agentId });
    const [refused] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: sessionId, contextSnapshot: { issueId } }).returning();
    // The executor's own writer and wording (noticeHeldUnfinishedPredecessor).
    await db.transaction(tx => writePiSessionHistoryLossNotice(db, tx, { companyId, issueId, runId: refused.id, agentId,
      authorizationReason: `native_prior_owner_held:${sessionId}`, body: HELD_PREDECESSOR_NOTICE }));
    return { companyId, agentId, issueId, sessionId };
  }

  async function laterRun(f: Awaited<ReturnType<typeof heldConversation>>, input: {
    sessionId: string; status?: string; phase?: string | null; createdAt?: Date;
  }) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: input.status ?? "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: input.sessionId,
      contextSnapshot: { issueId: f.issueId }, ...(input.createdAt ? { createdAt: input.createdAt } : {}) }).returning();
    if (input.phase !== null) await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId,
      runId: run.id, phase: input.phase ?? "committed" });
    return run;
  }

  it("returns the held conversation's notice", async () => {
    const f = await heldConversation();
    const notice = await readUnsupersededHeldConversationNotice(db, { companyId: f.companyId, issueId: f.issueId });
    expect(notice).toMatchObject({ issueId: f.issueId, normalizedSessionId: f.sessionId, body: HELD_PREDECESSOR_NOTICE });
    // Company-scoped.
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: randomUUID(), issueId: f.issueId })).toBeNull();
  });

  it("is superseded by a later committed success on the same conversation", async () => {
    const f = await heldConversation();
    await laterRun(f, { sessionId: f.sessionId });
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: f.companyId, issueId: f.issueId })).toBeNull();
  });

  it("stays held after a success on another conversation (a new task)", async () => {
    const f = await heldConversation();
    await laterRun(f, { sessionId: randomUUID() });
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: f.companyId, issueId: f.issueId }))
      .toMatchObject({ normalizedSessionId: f.sessionId });
  });

  it.each([
    { name: "a success without a committed result", status: "succeeded", phase: "observed" },
    { name: "a success without a finalization row", status: "succeeded", phase: null },
    { name: "a later failed run even when committed", status: "failed", phase: "committed" },
  ])("stays held after $name on the same conversation", async ({ status, phase }) => {
    const f = await heldConversation();
    await laterRun(f, { sessionId: f.sessionId, status, phase });
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: f.companyId, issueId: f.issueId })).not.toBeNull();
  });

  it("stays held after a committed success created before the notice", async () => {
    const f = await heldConversation();
    await laterRun(f, { sessionId: f.sessionId, createdAt: new Date("2020-01-01T00:00:00Z") });
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: f.companyId, issueId: f.issueId })).not.toBeNull();
  });

  it("ignores other notices and reads a batch in one call", async () => {
    const held = await heldConversation(), other = await heldConversation();
    await db.delete(issueComments).where(eq(issueComments.issueId, other.issueId));
    // A history-loss notice with another reason, and a user comment imitating the reason.
    await db.insert(issueComments).values([
      { companyId: other.companyId, issueId: other.issueId, authorType: "system", body: "Starting a new one.",
        metadata: { version: 1, authorizationReason: `pi_session_file_missing:${other.sessionId}:x` } },
      { companyId: other.companyId, issueId: other.issueId, authorType: "user", body: HELD_PREDECESSOR_NOTICE,
        metadata: { version: 1, authorizationReason: `native_prior_owner_held:${other.sessionId}` } },
    ] as never);
    expect(await readUnsupersededHeldConversationNotice(db, { companyId: other.companyId, issueId: other.issueId })).toBeNull();
    const batch = await readUnsupersededHeldConversationNotices(db, { companyId: held.companyId, issueIds: [held.issueId, held.issueId] });
    expect([...batch.keys()]).toEqual([held.issueId]);
  });
});
