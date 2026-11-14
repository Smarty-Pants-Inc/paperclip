import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues, agentWakeupRequests, approvals, issueApprovals } from "@paperclipai/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../heartbeat.js";

// Independent RFL checks. Real isolated PostgreSQL; no mocked recovery predicates.
// The race tests hold the same issue-row fence as comment/held-notice writers,
// wait until the sweep reaches that fence, then commit the concurrent write.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RFL independent unanswered-message safety", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("rfl-unanswered-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    const messageId = randomUUID(), runId = randomUUID();
    const old = Date.now() - 300_000;
    await db.insert(companies).values({ id: companyId, name: "RFL audit", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed audit agent", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", lifecycleMode: "warm", instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Person asks for work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: "audit-person", body: "Please do this.", createdAt: new Date(old) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      contextSnapshot: { issueId, wakeCommentId: messageId, wakeReason: "issue_commented" }, errorCode: "adapter_failed",
      error: "runner_state_identity_mismatch: prior_owner_active", createdAt: new Date(old + 1_000), finishedAt: new Date(old + 2_000) });
    const notices = async () => (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt))))
      .filter(row => row.metadata?.recoveryResponsibility !== "system")
      .filter(row => !(row.metadata as Record<string, unknown> | null)?.supersededBy); // RFL 10:14Z: CURRENT notes (never-delete part 1)
    // Match the production worker's flags, including skipping the unrelated
    // company-wide active-action reconciliation.
    const sweep = () => heartbeatService(db).reconcileStrandedAssignedIssues({ companyId, issueId, skipRelatedRecovery: true, skipExternalConversationSettlement: true });
    return { companyId, issueId, agentId, messageId, runId, old, notices, sweep };
  }

  async function waitForSweepAtIssueFence() {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      const rows = await db.$client<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query ilike '%for no key update%'`;
      if (rows[0]?.n) return;
      await delay(10);
    }
    throw new Error("Sweep did not reach the issue fence; race is not established");
  }

  it("BLOCKED after an agent answer and a pending question: no false notice, no wake, no status change", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.runId, body: "I have the result; which option should I apply?", createdAt: new Date(f.old + 3_000) });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId,
      kind: "request_confirmation", status: "pending", addresseeUserId: "audit-person", payload: { version: 1, prompt: "Apply this result?" } });
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("blocked");
  });

  it("BLOCKED unanswered failure: only the notice changes, no new run or wake or status transition", async () => {
    const f = await seed();
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue?.status).toBe("blocked");
  });

  it("two concurrent sweeps dedupe the same person-message reason", async () => {
    const f = await seed();
    await Promise.all([f.sweep(), f.sweep()]);
    expect(await f.notices()).toHaveLength(1);
  });

  it("an agent answer committed while the sweep waits on the issue fence prevents a notice, including next tick", async () => {
    const f = await seed();
    let pending: ReturnType<typeof f.sweep> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update");
        pending = f.sweep();
        await waitForSweepAtIssueFence();
        const retryRunId = randomUUID();
        await tx.insert(heartbeatRuns).values({ id: retryRunId, companyId: f.companyId, agentId: f.agentId,
          status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId, retryOfRunId: f.runId,
          contextSnapshot: { issueId: f.issueId, wakeCommentId: f.messageId },
          createdAt: sql`statement_timestamp()`, finishedAt: sql`statement_timestamp()` });
        await tx.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
          createdByRunId: retryRunId, body: "Here is the answer, now delivered.", createdAt: sql`statement_timestamp()` });
      });
    } finally { await pending; }
    await f.sweep();
    expect(await f.notices()).toHaveLength(0);
  });

  it("a held notice committed while the sweep waits on the issue fence leaves exactly one visible notice", async () => {
    const f = await seed();
    let pending: ReturnType<typeof f.sweep> | undefined;
    try {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update");
        pending = f.sweep();
        await waitForSweepAtIssueFence();
        await tx.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system",
          body: "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.",
          metadata: { version: 1, authorizationReason: `native_prior_owner_held:${randomUUID()}`, sections: [] },
          createdAt: sql`statement_timestamp()` });
      });
    } finally { await pending; }
    await f.sweep();
    expect(await f.notices()).toHaveLength(1);
  });

  it("an approval from before this person's new message does not answer that message's failed run", async () => {
    const f = await seed();
    await db.update(issueComments).set({ body: "What is the current status? Please answer this new question; this is not my approval." })
      .where(eq(issueComments.id, f.messageId));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      body: "Please approve the earlier deployment.", createdAt: new Date(f.old - 60_000) });
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "deploy", requestedByAgentId: f.agentId,
      status: "pending", payload: { summary: "An earlier deployment request" }, createdAt: new Date(f.old - 60_000) }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval!.id, linkedByAgentId: f.agentId });
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(1);
  });

  it("a later unrelated timer success cannot silence a person message whose own wake failed and grace elapsed", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, error: null,
      contextSnapshot: { issueId: f.issueId, wakeReason: "heartbeat_timer" } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "failed", finishedAt: new Date(f.old + 2_000),
      payload: { issueId: f.issueId, commentId: f.messageId } });
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(1);
  });

  it("a visible person-owned question is an answer/wait even if no separate agent prose comment was written", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, error: null,
      resultJson: { finalizationReasonCode: "conversation_turn_finished" } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId,
      kind: "request_confirmation", status: "pending", addresseeUserId: "audit-person", createdByAgentId: f.agentId,
      title: "Approve this action", summary: "I need your approval before continuing.",
      payload: { version: 1, prompt: "Approve this action?" }, createdAt: new Date(f.old + 3_000) });
    await f.sweep(); await f.sweep();
    expect(await f.notices()).toHaveLength(0);
  });
});
