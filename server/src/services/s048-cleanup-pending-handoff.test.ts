/**
 * S048 (i): the cleanup_pending gate (hasPendingRunCleanup, used by the Send
 * gate explicit-native-continuation.ts and queue.ts predecessor admission)
 * does not count a handed-off retained warm lease that passes the SHARED
 * marker-bound predicate (retainedWarmHandoffLease, runner-exit marker) as
 * pending cleanup, in both its active-before-release and retained/success
 * states. Failed cleanup, stop-only cleanup and another run's marker still count.
 * Real embedded Postgres.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { hasPendingRunCleanup } from "./execution-blocker.js";
import { HANDED_OFF_WARM_EXIT_KEY } from "./native-runtime/handed-off-warm-lease.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("S048: cleanup_pending vs a handed-off retained warm lease", () => {
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
    await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, provider: "daytona",
      providerLeaseId: `bx_${randomUUID().slice(0, 8)}`, status: "active", leasePolicy: "reuse_by_execution_workspace",
      ...lease, metadata: { ...metadata, ...(lease.metadata ?? {}) } });
    return { companyId, runId };
  }

  it("active-before-release handoff with this run's marker is NOT pending cleanup", async () => {
    const r = await stoppedWarmRun({ status: "active" });
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(false);
  });
  it("retained/success handoff with this run's marker is NOT pending cleanup", async () => {
    const r = await stoppedWarmRun({ status: "retained", cleanupStatus: "success" });
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(false);
  });
  it("NEGATIVE: failed cleanup is still pending", async () => {
    const r = await stoppedWarmRun({ status: "retained", cleanupStatus: "failed" });
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(true);
  });
  it("NEGATIVE: stop-only cleanup (stop-and-retain receipt) is still pending", async () => {
    const r = await stoppedWarmRun({ status: "active", metadata: { sandboxStopAndRetainReceipt: { at: new Date().toISOString() } } });
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(true);
  });
  it("NEGATIVE: another run's marker is still pending", async () => {
    const r = await stoppedWarmRun({ status: "retained", cleanupStatus: "success" }, "other");
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(true);
  });
  it("NEGATIVE: no marker (lease shape alone) is still pending", async () => {
    const r = await stoppedWarmRun({ status: "active" }, "none");
    expect(await hasPendingRunCleanup(db, r.companyId, r.runId)).toBe(true);
  });
});
