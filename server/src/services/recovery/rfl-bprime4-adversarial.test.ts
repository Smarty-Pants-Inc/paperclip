import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";

// Independent judge cases required by the Bprime4 brief. Keep reason: recorded
// SMAA-501 loss of a person's message plus the message/run attribution boundary.
// Actual stranded sweep and isolated PostgreSQL; no mocked recovery decisions.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL Bprime4 message attribution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("rfl-bprime4-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `judge-${randomUUID()}`;
    const base = Date.now() - 300_000;
    await db.insert(companies).values({ id: companyId, name: "Independent attribution", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Two questions", status: "blocked", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting" });
    const message = async (body: string, at: number) => {
      const [row] = await db.insert(issueComments).values({ companyId, issueId, body, authorType: "user", authorUserId: userId,
        createdAt: new Date(at), updatedAt: new Date(at) }).returning(); return row!.id;
    };
    const run = async (messageId: string, at: number, status = "succeeded") => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, runtimeMode: "native", nativeIssueId: issueId,
        status, contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: messageId, wakeCommentIds: [messageId] },
        createdAt: new Date(at), startedAt: new Date(at), finishedAt: new Date(at + 30_000),
        errorCode: status === "failed" ? "adapter_failed" : null }).returning(); return row!.id;
    };
    const reply = (runId: string, at: number) => db.insert(issueComments).values({ companyId, issueId,
      authorType: "agent", authorAgentId: agentId, createdByRunId: runId, body: "The production version is v8.", createdAt: new Date(at) });
    const card = (runId: string, at: number) => db.insert(issueThreadInteractions).values({ companyId, issueId, sourceRunId: runId,
      createdByAgentId: agentId, addresseeUserId: userId, kind: "request_confirmation", status: "pending", title: "Confirm version",
      payload: { version: 1, prompt: "Use v8 for the version report?" }, createdAt: new Date(at) });
    const sweep = () => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId,
      skipRelatedRecovery: true, skipExternalConversationSettlement: true });
    const notices = async () => (await db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(row => row.metadata?.recoveryResponsibility !== "system");
    return { companyId, agentId, issueId, userId, base, message, run, reply, card, sweep, notices };
  }

  for (const key of ["commentId", "nested-single", "nested-list"] as const) {
    it(`(a) failed wake carrying a DIFFERENT message via ${key} cannot bypass this message's grace`, async () => {
      const f = await fixture();
      const first = await f.message("What is the production version?", f.base);
      const firstRun = await f.run(first, f.base + 1_000);
      await f.reply(firstRun, f.base + 40_000);
      const secondAt = Date.now() - 5_000;
      const second = await f.message("What is the staging version?", secondAt);
      const payload = key === "commentId" ? { issueId: f.issueId, commentId: first }
        : { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId,
          ...(key === "nested-single" ? { wakeCommentId: first } : { wakeCommentIds: [first] }) } };
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "on_demand", reason: "issue_commented", status: "failed", payload, finishedAt: new Date(), updatedAt: new Date() }).returning();
      await f.sweep(); await f.sweep();
      expect(await f.notices()).toHaveLength(0);
      // Positive control: THIS message's failure is immediate, not disabled wholesale.
      await db.update(agentWakeupRequests).set({ payload: { issueId: f.issueId, commentId: second }, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wake!.id));
      await f.sweep(); await f.sweep();
      expect((await f.notices()).map(n => n.metadata?.authorizationReason)).toEqual([`unanswered_message:${second}`]);
    });
  }

  for (const presentation of ["prose", "own-card"] as const) {
    it(`(b) two person messages in a row; run answers only FIRST by ${presentation}: exactly one notice for SECOND`, async () => {
      const f = await fixture();
      const first = await f.message("What is the production version?", f.base);
      const firstRun = await f.run(first, f.base + 1_000);
      // Second arrives AFTER the first run's input boundary, BEFORE its output.
      // Its wake is cancelled without delivery: it was never input to firstRun.
      const second = await f.message("Also, what is the staging version?", f.base + 10_000);
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        reason: "issue_commented", status: "cancelled", error: "operator_cancelled", payload: { issueId: f.issueId, commentId: second },
        finishedAt: new Date(f.base + 20_000), updatedAt: new Date(f.base + 20_000) });
      if (presentation === "prose") await f.reply(firstRun, f.base + 40_000);
      else await f.card(firstRun, f.base + 40_000);
      await f.sweep(); await f.sweep();
      const notices = await f.notices();
      // Also retain the direct-owner outcome to distinguish candidate filtering
      // from an incorrect settled decision without mocking either path.
      const direct = await settleUnansweredPersonMessage(db, f);
      console.log("BPRIME4_TWO_MESSAGES", JSON.stringify({ presentation, first, second, firstRun,
        sweepNotices: notices.map(n => n.metadata?.authorizationReason), direct }));
      expect(notices.map(n => n.metadata?.authorizationReason)).toEqual([`unanswered_message:${second}`]);
      expect((await f.notices()).map(n => n.metadata?.authorizationReason)).toEqual([`unanswered_message:${second}`]);
    });
  }

  it("(c) card from EARLIER run, even created after current message, does not answer the current carrying run", async () => {
    const f = await fixture();
    const first = await f.message("What is the production version?", f.base);
    const earlierRun = await f.run(first, f.base + 1_000);
    const second = await f.message("What is the staging version?", f.base + 10_000);
    await f.run(second, f.base + 11_000, "failed");
    await f.card(earlierRun, f.base + 50_000);
    await f.sweep(); await f.sweep();
    expect((await f.notices()).map(n => n.metadata?.authorizationReason)).toEqual([`unanswered_message:${second}`]);
  });
});
