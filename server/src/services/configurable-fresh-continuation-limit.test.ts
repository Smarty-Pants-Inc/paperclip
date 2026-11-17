import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { ensureFreshContinuation } from "./fresh-continuation-fallback.js";
import { freshContinuationChain } from "./fresh-continuation-chain.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { heartbeatService } from "./heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("configured durable fresh-continuation chain limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("configured-fresh-continuation-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // Keep: durable replay/data-safety boundary, using the real transactional fallback and ledger.
  it.each([
    [undefined, 2], ["2", 2], ["02", 2], [" 2", 2], ["2 ", 2],
    ["002", 2], ["\t2\n", 2], [" 5 ", 5],
  ] as const)("allows %s fresh continuations then returns the existing exhaustion reason", async (raw, limit) => {
    vi.stubEnv("PAPERCLIP_FRESH_CONTINUATIONS_PER_CHAIN", raw);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Continuation limits", issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "idle", adapterType: "paperclip_runner",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Unfinished task", status: "todo", assigneeAgentId: agentId });
    // Occupy the real dispatch slot so admitted continuations remain queued: no provider is launched.
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId, title: "Other running work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: busyIssueId, status: "running", contextSnapshot: { issueId: busyIssueId } });
    const rootRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: rootRunId, companyId, agentId, issueId, status: "failed", responsibleUserId: userId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
    let runId: string = rootRunId;
    for (let attempt = 0; attempt <= limit; attempt++) {
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId, nativePhase: "terminal_failure",
        status: "failed", errorCode: "temporary_runner_transport_unavailable", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, runId));
      const result = await ensureFreshContinuation(db, { companyId, runId, trigger: "recovery_refused" });
      if (attempt === limit) {
        expect(result).toEqual({ kind: "not_applicable", reason: "fresh_continuation_chain_exhausted" });
      } else {
        expect(result).toMatchObject({ kind: "continued", delivery: "recorded" });
        const records = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
        expect(records).toHaveLength(attempt + 1);
        const record = records.find(row => row.evidence.runId === runId)!;
        expect(record.evidence).toMatchObject({ freshContinuation: { chainRootRunId: rootRunId, chainAttempt: attempt + 1 } });
        await deliverReconciledExecutions(db, heartbeatService(db).wakeup);
        const next = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
        const [delivered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, record.id));
        expect(delivered.evidence).toMatchObject({ continuationDelivery: "delivered" });
        expect(next).toHaveLength(1);
        expect(next[0].status).toBe("queued");
        runId = next[0].id;
      }
    }
    // A new DB handle must see the same exhausted budget, not a process-local counter.
    const restarted = createDb(database.connectionString);
    try {
      expect(await freshContinuationChain(restarted, { companyId, issueId, runId }))
        .toEqual({ rootRunId, attempts: limit });
      expect(await ensureFreshContinuation(restarted, { companyId, runId, trigger: "recovery_refused" }))
        .toEqual({ kind: "not_applicable", reason: "fresh_continuation_chain_exhausted" });
    } finally { await restarted.$client.end(); }
  });
});
