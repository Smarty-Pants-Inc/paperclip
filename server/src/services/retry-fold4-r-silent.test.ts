import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";

// rf-3 E (R-SILENT): the card never says "working" from a durable continuation
// record alone; a queued or running successor (or a live wake) must exist.
// Entry point: taskInterruptionPresentation, the card projection that
// routes/issues.ts serves on GET /issues/:id (`interruption:`) and on the
// Retry answer. Agent shape: a Boat-remote pi_rpc agent with managed
// instructions (agent_files persistence).
describe("R-SILENT: no 'working' without a live successor", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("r-silent-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(continuationDelivery: "not_requested" | "pending") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "R-SILENT", defaultResponsibleUserId: "board", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle",
      adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed" } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" }).returning();
    const recordedAt = new Date(Date.now() - 45 * 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      startedAt: new Date(recordedAt.getTime() - 60_000), finishedAt: new Date(recordedAt.getTime() - 30_000),
      errorCode: "native_restart_recovery_blocked", contextSnapshot: { issueId, executionTarget: { kind: "remote", transport: "sandbox", providerKey: "boat" } },
      resultJson: {} });
    const freshContinuation = { schema: "paperclip.fresh-continuation.v1", sourceRunId: runId, trigger: "held_recovery",
      failureCode: "native_restart_recovery_blocked", delivery: "recorded", recordedAt: recordedAt.toISOString(),
      isolation: "remote_epoch", stopProof: "unproven_epoch_abandoned", unverifiedActions: [], createdObjects: [] };
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${runId}`, nextAction: "Paperclip continues the task in a fresh run from its saved work.",
      resolvedAt: recordedAt, createdAt: recordedAt, updatedAt: recordedAt,
      evidence: { runId, freshContinuationSettlement: { schema: "paperclip.fresh-continuation.v1", sourceRunId: runId },
        freshContinuation, continuationDelivery } });
    return { companyId, agentId, issueId, runId, issue: issue! };
  }

  it("a continuation recorded without a delivery request, 45 minutes old, no successor run or wake, is not 'working'", async () => {
    const f = await seed("not_requested");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([]);
    const presentation = await taskInterruptionPresentation(db, f.issue);
    expect(presentation?.state).not.toBe("working");
    // Not silent either: the card offers the one action that can change the outcome.
    expect(presentation?.canRetry).toBe(true);
  });

  it("control: the same record with a queued wake for the task (a live successor) is 'working' with no Retry", async () => {
    const f = await seed("not_requested");
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "fresh_continuation", status: "queued", payload: { issueId: f.issueId } });
    const presentation = await taskInterruptionPresentation(db, f.issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
  });
});
