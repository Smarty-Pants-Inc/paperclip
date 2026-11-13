import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, environments,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";
import { heartbeatService } from "./heartbeat.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("explicit continuation after a warm preparation failure", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("warm-preparation-continuation-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(input: {
    status?: "failed" | "cancelled" | "interrupted";
    errorCode?: string;
    providerWorkStarted?: boolean;
    stop?: "confirmed" | "unconfirmed" | "wrong_allocation" | "failed";
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), environmentId = randomUUID(), pluginId = randomUUID(), commentId = randomUUID();
    const providerLeaseId = `warm-${runId}`;
    await db.insert(companies).values({ id: companyId, name: "Warm continuation regression",
      issuePrefix: `W${companyId.replaceAll("-", "")}`, defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer",
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue after failed preparation",
      status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: input.status ?? "failed", errorCode: input.errorCode ?? "adapter_failed",
      contextSnapshot: { issueId }, finishedAt: new Date("2026-11-12T10:00:00Z"),
      resultJson: input.providerWorkStarted === undefined ? {} : {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: input.providerWorkStarted },
      } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      cause: "uncertain_external_action", fingerprint: runId, status: "resolved", outcome: "blocked",
      nextAction: "Continue only after execution cleanup.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user",
      authorUserId: "board", body: "Continue with this new instruction.", createdAt: new Date("2026-11-12T11:00:00Z") });
    await db.insert(environments).values({ id: environmentId, name: `Warm ${runId}`, driver: "sandbox", status: "active",
      config: { provider: "warm-continuation-test", image: "test", reuseLease: true } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: `test.warm-continuation-${pluginId}`,
      packageName: "@test/warm-continuation", version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
      manifestJson: { id: `test.warm-continuation-${pluginId}`, apiVersion: 1, version: "1.0.0",
        displayName: "Controlled lifecycle provider", description: "DB-backed continuation regression", author: "Test",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "warm-continuation-test", kind: "sandbox_provider", displayName: "Test",
          supportsReusableLeases: true, configSchema: { type: "object" } }] } });
    const lease = await environmentService(db).acquireLease({ companyId, environmentId, issueId, heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment", provider: "warm-continuation-test", providerLeaseId,
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, provider: "warm-continuation-test", agentId } });
    const call = vi.fn(async (_pluginId: string, method: string) => {
      if (method !== "environmentStopLease") throw new Error(`Unexpected lifecycle operation: ${method}`);
      if (input.stop === "failed") throw new Error("Stop unavailable");
      if (input.stop === "unconfirmed") return undefined;
      return { providerLeaseId: input.stop === "wrong_allocation" ? "another-allocation" : providerLeaseId, state: "stopped" };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: (id: string) => id === pluginId, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease",
        "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    return { companyId, agentId, issueId, runId, commentId, lease, call, runtime };
  }

  async function sendNextInstruction(f: Awaited<ReturnType<typeof seed>>) {
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await heartbeatService(db).wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: f.commentId },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId } });
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))[0]!;
  }

  it("stops a never-started adapter_failed warm run, records its exact receipt, and admits the next instruction", async () => {
    const f = await seed({ providerWorkStarted: false });
    await f.runtime.releaseRunLeases(f.runId, "failed", undefined, "keep_running");
    const [settled] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect.soft(settled).toMatchObject({ status: "released", leasePolicy: "reuse_by_environment", cleanupStatus: "success" });
    expect.soft(hasRemoteTerminationReceipt(settled)).toBe(true);
    expect.soft(settled.metadata?.remoteExecutionTermination).toMatchObject({ companyId: f.companyId,
      runId: f.runId, leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId, state: "stopped" });
    expect.soft(f.call.mock.calls.map(call => call[1])).toEqual(["environmentStopLease"]);
    const wake = await sendNextInstruction(f);
    expect.soft(wake).toMatchObject({ status: "queued", runId: expect.any(String) });
    expect.soft(wake.payload?.executionWait).toBeUndefined();
    if (!wake.runId) return;
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(next).toMatchObject({ status: "queued", contextSnapshot: { issueId: f.issueId,
      previousRunId: f.runId, forceFreshSession: true, wakeCommentId: f.commentId } });
    const [original] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(original).toMatchObject({ status: "failed", errorCode: "adapter_failed",
      resultJson: { executionRecovery: { providerWorkStarted: false } } });
  });

  it.each(["unconfirmed", "wrong_allocation", "failed"] as const)("keeps the next instruction deferred after %s stop", async stop => {
    const f = await seed({ providerWorkStarted: false, stop });
    await f.runtime.releaseRunLeases(f.runId, "failed", undefined, "keep_running");
    const [settled] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(settled).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    expect(hasRemoteTerminationReceipt(settled)).toBe(false);
    const wake = await sendNextInstruction(f);
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "remote_cleanup" } } });
  });

  it.each([
    { status: "cancelled", errorCode: "cancelled", providerWorkStarted: false },
    { status: "interrupted", errorCode: "native_session_interrupted", providerWorkStarted: false },
    { status: "failed", errorCode: "adapter_failed", providerWorkStarted: true },
    { status: "failed", errorCode: "adapter_failed", providerWorkStarted: undefined },
    { status: "failed", errorCode: "adapter_error", providerWorkStarted: false },
  ] as const)("preserves selected warm retention outside the exact failed-preparation case ($status/$errorCode/$providerWorkStarted)", async input => {
    const f = await seed(input);
    await f.runtime.releaseRunLeases(f.runId, "failed", undefined, "keep_running");
    const [settled] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(settled).toMatchObject({ status: "retained", cleanupStatus: "success" });
    expect(f.call).not.toHaveBeenCalled();
    expect(hasRemoteTerminationReceipt(settled)).toBe(false);
  });
});
