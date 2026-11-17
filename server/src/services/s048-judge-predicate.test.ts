/** S048 independent negative: the brief says a lease with NO runner_exit marker
 * still counts as pending. Exercise retained/success with both reusable policies.
 * The reused seed is the builder's real-PG fixture, not a second lease predicate.
 * The reuse_by_environment exception predates this branch; report it as an unmet
 * literal acceptance condition, NOT as a newly introduced regression.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { HANDED_OFF_WARM_EXIT_KEY } from "./native-runtime/handed-off-warm-lease.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("S048 judge: no-marker retained lease negative across both reusable policies", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s048-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function stoppedWarmRun(lease: Partial<typeof environmentLeases.$inferInsert>, marker: "own" | "other" | "none" = "own") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "S048", defaultResponsibleUserId: "board",
      issuePrefix: `S${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", adapterConfig: { provider: "codex", model: null }, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Edit", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, issueId, runtimeMode: "native",
      status: "cancelled", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    const metadata = marker === "none" ? {} : { [HANDED_OFF_WARM_EXIT_KEY]: { runId: marker === "own" ? runId : randomUUID(), provenAt: new Date().toISOString() } };
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "active", leasePolicy: "reuse_by_execution_workspace",
      ...lease, metadata: { ...metadata, ...(lease.metadata ?? {}) } });
    return { companyId, runId };
  }

  it.each(["reuse_by_environment", "reuse_by_execution_workspace"])("a retained/success lease with NO runner_exit marker still counts (%s)", async leasePolicy => {
    const r = await stoppedWarmRun({ status: "retained", cleanupStatus: "success", leasePolicy }, "none");
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(true);
  });
});
