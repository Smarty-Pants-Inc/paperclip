import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import {
  continueHeldExecutions, ensureFreshContinuation, heldExecutionsAwaitingFreshContinuation,
  listFreshContinuations, resetBacklogContinuationPacingForTests,
} from "./fresh-continuation-fallback.js";
import { settleStoppedRemoteNativeOwner } from "./native-runtime/native-failed-run-owner-release.js";

const support = await getEmbeddedPostgresTestSupport();
const refusals = ["runner_harness_state_mismatch: resumed_unavailable",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding"] as const;

// Keep: RFL F1-2's real stranded-owner incident; physical settlement and the
// waiting follow-up are different runs. No recovery hold is invented on the latter.
describe.skipIf(!support.supported)("F1 stopped-owner continuation routing", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-f1-stopped-routing-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, 60_000);
  beforeEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await db.execute(sql`truncate table companies cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(refusal: string = refusals[0]) {
    const now = new Date(), sessionId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: now, updatedAt: now });
    const [company] = await db.insert(companies).values({ name: "F1 person", issuePrefix: "FSP", defaultResponsibleUserId: userId }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Saved work", status: "idle",
      adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Answer the saved follow-up",
      status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [owner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "running",
      nativePhase: "observed", errorCode: "native_execution_ownership_unverified", responsibleUserId: userId,
      createdAt: new Date(now.getTime() - 600_000), contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: company.id, issueId: issue.id, runId: owner.id,
      phase: "observed", attempt: 2, controllerGeneration: 3, leaseOwner: "departed-owner", leaseExpiresAt: new Date(0) });
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id,
      heartbeatRunId: owner.id, provider: "boat", providerLeaseId: `stopped-${owner.id}`, status: "released", cleanupStatus: "success",
      acquiredAt: new Date(now.getTime() - 600_000), releasedAt: new Date(now.getTime() - 300_000) }).returning();
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: {
      schema: "paperclip.remote-termination.v1", companyId: company.id, runId: owner.id, leaseId: lease.id,
      provider: lease.provider, providerLeaseId: lease.providerLeaseId, state: "stopped", confirmedAt: lease.releasedAt!.toISOString(),
    } } }).where(eq(environmentLeases.id, lease.id));
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      nativeIssueId: issue.id, nativeSessionId: sessionId, runtimeMode: "native", status: "failed", nativePhase: "terminal_failure",
      errorCode: refusal, responsibleUserId: userId, createdAt: new Date(now.getTime() - 120_000),
      finishedAt: new Date(now.getTime() - 60_000), contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: company.id, issueId: issue.id, runId: source.id,
      phase: "terminal_failure", failureCode: refusal, recoveryState: "blocked" });
    return { now, company, agent, issue, owner, source, lease, userId };
  }

  async function stoppedWithOlderHold(f: Awaited<ReturnType<typeof fixture>>, settled = false) {
    expect(await settleStoppedRemoteNativeOwner(db, f.owner.id, f.now)).toBe(true);
    const [issue] = await db.update(issues).set({ status: "blocked", blockedTransitionAt: f.now })
      .where(eq(issues.id, f.issue.id)).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
      kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", status: settled ? "resolved" : "active",
      outcome: settled ? "blocked" : null, resolvedAt: settled ? f.now : null, ownerType: "board", returnOwnerAgentId: f.agent.id,
      fingerprint: `stopped-owner:${f.owner.id}`, nextAction: "The run stopped before it finished.",
      evidence: { runId: f.owner.id, nativeFailureBlock: { runId: f.owner.id, statusVersion: Number(issue.statusVersion) },
        ...(settled ? { automaticRecovery: { replay: "blocked" } } : {}) } }).returning();
    return hold;
  }

  async function assertContinued(f: Awaited<ReturnType<typeof fixture>>, holdId: string) {
    const records = await listFreshContinuations(db, { companyId: f.company.id, issueId: f.issue.id });
    expect(records).toHaveLength(1);
    expect(records[0].evidence).toMatchObject({ freshContinuation: { sourceRunId: f.source.id, previousExecutionGone: true },
      executionReconciliation: { runId: f.source.id }, continuationDelivery: "pending" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, holdId)))[0])
      .toMatchObject({ status: "resolved", outcome: "restored" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).not.toBe("blocked");
    expect(await getExecutionBlocker(db, f.company.id, f.issue.id)).toBeNull();
    const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
    expect(notes.filter(note => !note.metadata?.supersededByCommentId)).toMatchObject([{ authorType: "system", body: expect.stringContaining("Starting a fresh thread") }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(2);
  }

  it.each(refusals)("routes the older action to the latest refused follow-up: %s", async refusal => {
    const f = await fixture(refusal), hold = await stoppedWithOlderHold(f);
    await settleUnrecoverableExecutions(db, f.now);
    await assertContinued(f, hold.id);
    await settleUnrecoverableExecutions(db, f.now);
    expect((await ensureFreshContinuation(db, { companyId: f.company.id, runId: f.owner.id, trigger: "held_recovery", now: f.now })).kind)
      .toBe("already_continued");
    await assertContinued(f, hold.id);
  });

  it("finds the same obligation when an older release already settled its hold without replay", async () => {
    const f = await fixture(), hold = await stoppedWithOlderHold(f, true);
    expect(await heldExecutionsAwaitingFreshContinuation(db, f.now, 10)).toMatchObject([{ id: hold.id }]);
    expect(await continueHeldExecutions(db, f.now)).toMatchObject({ continued: 1 });
    await assertContinued(f, hold.id);
  });

  it("a direct latest-source decision also retires the older hold and its exact Blocked receipt", async () => {
    const f = await fixture(), hold = await stoppedWithOlderHold(f);
    expect((await ensureFreshContinuation(db, { companyId: f.company.id, runId: f.source.id, trigger: "held_recovery" })).kind).toBe("continued");
    await assertContinued(f, hold.id);
  });

  it("does not directly continue the latest source past a board-user decision hold with full physical proof", async () => {
    const f = await fixture(), hold = await stoppedWithOlderHold(f);
    await db.update(issueRecoveryActions).set({ ownerUserId: f.userId }).where(eq(issueRecoveryActions.id, hold.id));
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
      .toMatchObject({ status: "released", metadata: { remoteExecutionTermination: {
        companyId: f.company.id, runId: f.owner.id, leaseId: f.lease.id,
        provider: f.lease.provider, providerLeaseId: f.lease.providerLeaseId, state: "stopped",
      } } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.owner.id)))[0])
      .toMatchObject({ status: "failed", nativePhase: "terminal_failure", finishedAt: f.now });
    expect(await ensureFreshContinuation(db, { companyId: f.company.id, runId: f.source.id, trigger: "held_recovery", now: f.now }))
      .toMatchObject({ kind: "person_owned", reason: "operator_decision_recorded" });
    expect(await listFreshContinuations(db, { companyId: f.company.id, issueId: f.issue.id })).toHaveLength(0);
    const [activeHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(activeHold).toMatchObject({ status: "active", ownerType: "board", ownerUserId: f.userId });
    expect(activeHold.outcome).not.toBe("restored");
  });

  it.each(["unsettled", "different_session", "different_generation", "newer_answer", "person_block", "human_hold"] as const)(
    "does not route past a distinct owner or decision: %s", async shape => {
      const f = await fixture();
      if (shape === "unsettled") {
        await db.update(environmentLeases).set({ status: "active", cleanupStatus: null, releasedAt: null, metadata: {} })
          .where(eq(environmentLeases.id, f.lease.id));
        await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
          kind: "active_run_watchdog", cause: "native_continuation_requires_reconciliation", status: "active",
          ownerType: "board", returnOwnerAgentId: f.agent.id, fingerprint: `live-owner:${f.owner.id}`,
          nextAction: "The current step must finish.", evidence: { runId: f.owner.id } });
        expect((await ensureFreshContinuation(db, { companyId: f.company.id, runId: f.source.id, trigger: "held_recovery" })).kind).toBe("exact_recovery_pending");
        expect((await ensureFreshContinuation(db, { companyId: f.company.id, runId: f.owner.id, trigger: "held_recovery" })).kind).toBe("not_applicable");
      } else {
        const hold = await stoppedWithOlderHold(f);
        if (shape === "different_session") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.source.id));
        if (shape === "different_generation") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, conversationSessionGeneration: 1 } }).where(eq(heartbeatRuns.id, f.source.id));
        if (shape === "newer_answer") await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
          issueId: f.issue.id, nativeIssueId: f.issue.id, nativeSessionId: f.source.nativeSessionId, status: "succeeded",
          createdAt: new Date(f.now.getTime() - 1000), finishedAt: f.now });
        if (shape === "person_block") await db.update(issues).set({ lastStatusDecisionId: randomUUID(), statusVersion: sql`${issues.statusVersion} + 1` }).where(eq(issues.id, f.issue.id));
        if (shape === "human_hold") await db.update(issueRecoveryActions).set({ ownerUserId: f.userId }).where(eq(issueRecoveryActions.id, hold.id));
        await settleUnrecoverableExecutions(db, f.now);
        expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0].outcome).not.toBe("restored");
      }
      expect(await listFreshContinuations(db, { companyId: f.company.id, issueId: f.issue.id })).toHaveLength(0);
      expect(await getExecutionBlocker(db, f.company.id, f.issue.id)).not.toBeNull();
      if (shape === "unsettled") {
        const notes = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
        expect(notes).toHaveLength(1);
        expect(notes[0].body).toContain("current step must finish");
      }
    });
});
