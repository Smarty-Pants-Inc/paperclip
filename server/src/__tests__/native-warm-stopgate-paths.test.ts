import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareSupersededWarmSandboxStop } from "../services/sandbox-stop-and-retain.js";
import { stopWarmSandboxesPastWindow, WARM_SANDBOX_IDLE_TIMEOUT_KEY } from "../services/warm-sandbox-expiry.js";
import * as providers from "../services/sandbox-provider-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;

type Fixture = Awaited<ReturnType<typeof fixture>>;
let db!: ReturnType<typeof createDb>;
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

async function fixture(input: { status?: "active" | "retained" | "released" | "pending_cleanup"; runStatus?: string;
  executionWorkspace?: boolean; idleAgoMs?: number } = {}) {
  const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID();
  const issueId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `sandbox://fake/${leaseId}`;
  const finishedAt = new Date(Date.now() - 5_000);
  await db.insert(companies).values({ id: companyId, name: "Stop gate", issuePrefix: `SG${companyId.slice(0, 3)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
    adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
  await db.insert(environments).values({ id: environmentId, name: `Fake sandbox ${environmentId}`, driver: "sandbox", status: "active",
    config: { provider: "fake", image: "ubuntu:24.04", reuseLease: true } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Warm work" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand",
    status: input.runStatus ?? "failed", finishedAt, nextEventSeq: 1 });
  let executionWorkspaceId: string | null = null;
  if (input.executionWorkspace) {
    executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Remote workspace", providerType: "cloud_sandbox" });
    await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
  }
  const lease = await environmentService(db).acquireLease({ companyId, environmentId, executionWorkspaceId, issueId,
    heartbeatRunId: runId, leasePolicy: "reuse_by_environment", provider: "fake", providerLeaseId,
    metadata: { agentId, driver: "sandbox", provider: "fake", image: "ubuntu:24.04", reuseLease: true,
      ...(input.idleAgoMs !== undefined ? { [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: 5 * MINUTE } : {}),
      reusableSandboxLease: { adapterType: "paperclip_runner" } } });
  const status = input.status ?? "active";
  if (status !== "active") {
    await db.update(environmentLeases).set({ status, cleanupStatus: status === "pending_cleanup" ? "failed" : "success",
      failureReason: status === "pending_cleanup" ? "pending_cleanup_retry" : null,
      releasedAt: status === "released" || status === "pending_cleanup" ? new Date() : null,
      lastUsedAt: input.idleAgoMs !== undefined ? new Date(Date.now() - input.idleAgoMs) : lease.lastUsedAt,
      metadata: status === "pending_cleanup" ? { ...lease.metadata, pendingCleanupRetryAfterMs: 0 } : lease.metadata,
    }).where(eq(environmentLeases.id, lease.id));
  }
  return { companyId, agentId, environmentId, issueId, runId, leaseId: lease.id, providerLeaseId, executionWorkspaceId,
    environment: (await environmentService(db).getById(environmentId))!, finishedAt };
}

async function savedLease(id: string) {
  return (await environmentService(db).getLeaseById(id))!;
}

async function publishValidCheckpoint(f: Fixture) {
  const checkpointAt = new Date(f.finishedAt.getTime() + 10).toISOString();
  const closedAt = new Date(f.finishedAt.getTime() + 20).toISOString();
  const lease = await savedLease(f.leaseId);
  await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
    nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: "native-session",
      runnerInstanceId: "runner", sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: f.providerLeaseId,
      authorizedProviderLeaseId: f.providerLeaseId, manifestSha256: `sha256:${"b".repeat(64)}`, completedAt: checkpointAt },
    warmNativeSessionClose: { schema: "paperclip.native-warm-session-close.v1", state: "closed", closedAt,
      providerLeaseId: f.providerLeaseId, runId: f.runId, normalizedSessionId: "native-session",
      manifestSha256: `sha256:${"b".repeat(64)}` },
    pendingCleanupRetryAfterMs: 0, pendingCleanupInFlight: false,
  } }).where(and(eq(environmentLeases.id, f.leaseId), eq(environmentLeases.companyId, f.companyId)));
}

async function sweep() {
  return heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) }).sweepPendingCleanupLeases({ backoffMs: 0 });
}

suite("one native warm checkpoint gate across every sandbox stop path", () => {
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-warm-stopgate-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => vi.restoreAllMocks());

  function providerSpies() {
    const provider = providers.requireSandboxProvider("fake");
    return { stop: vi.spyOn(provider, "stopLease"), release: vi.spyOn(provider, "releaseLease"),
      destroy: vi.spyOn(provider, "destroyLease") };
  }

  it("(1) warm-window expiry durably waits, then stops only after checkpoint and close receipt", async () => {
    const f = await fixture({ status: "retained", runStatus: "succeeded", idleAgoMs: 6 * MINUTE });
    const calls = providerSpies();
    await stopWarmSandboxesPastWindow(db);
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await sweep();
    expect(calls.stop).not.toHaveBeenCalled();
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.stop).toHaveBeenCalledOnce();
  });

  it("(2) retained-orphan settlement waits at the stop-and-retain contract", async () => {
    const f = await fixture({ status: "retained" });
    const calls = providerSpies();
    const lease = await savedLease(f.leaseId);
    await prepareSupersededWarmSandboxStop(db, lease, { recoveredOrphanedRunLease: true, ownerProof: "terminal" });
    await sweep();
    expect(calls.stop).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.stop).toHaveBeenCalledOnce();
  });

  it("(3) obsolete source/image replacement waits before superseded stop dispatch", async () => {
    const f = await fixture({ status: "retained" });
    const calls = providerSpies();
    const lease = await savedLease(f.leaseId);
    // The changed-source branch hands the old retained source to this existing
    // stop-and-retain contract; the source-change reason remains durable.
    await prepareSupersededWarmSandboxStop(db, lease, { reason: "sandbox_source_changed" });
    await sweep();
    expect(calls.stop).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.stop).toHaveBeenCalledOnce();
  });

  it("(4) explicit stop_and_retain run settlement waits before stop dispatch", async () => {
    const f = await fixture({ runStatus: "failed" });
    const calls = providerSpies();
    await environmentRuntimeService(db).releaseRunLeases(f.runId, "failed", undefined, "stop_and_retain");
    expect(calls.stop).not.toHaveBeenCalled();
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.stop).toHaveBeenCalledOnce();
  });

  it("(5) ordinary run-finalization release waits before provider release", async () => {
    const f = await fixture({ runStatus: "failed" });
    const calls = providerSpies();
    await environmentRuntimeService(db).releaseRunLeases(f.runId, "failed");
    expect(calls.release).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.stop).toHaveBeenCalledOnce();
  });

  it("(6) reusable direct destroy waits before provider destroy", async () => {
    const f = await fixture({ status: "retained" });
    const calls = providerSpies();
    await environmentRuntimeService(db).destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId });
    expect(calls.destroy).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await sweep();
    expect(calls.destroy).toHaveBeenCalledOnce();
  });

  it("(7) ordinary pending-cleanup sweep waits before destroy dispatch", async () => {
    const f = await fixture({ status: "pending_cleanup" });
    const calls = providerSpies();
    await sweep();
    expect(calls.destroy).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupRetryAfterMs}', '0'::jsonb)` })
      .where(eq(environmentLeases.id, f.leaseId));
    await sweep();
    expect(calls.destroy).toHaveBeenCalledOnce();
  });

  it("(8) remote-workspace close waits before its claimed destroy dispatch", async () => {
    const f = await fixture({ status: "active", executionWorkspace: true });
    const calls = providerSpies();
    await environmentRuntimeService(db).destroyRemoteWorkspaceLease({ companyId: f.companyId, workspaceId: f.executionWorkspaceId!,
      leaseId: f.leaseId, environmentId: f.environmentId, providerLeaseId: f.providerLeaseId });
    expect(calls.destroy).not.toHaveBeenCalled();
    expect(await savedLease(f.leaseId)).toMatchObject({ status: "pending_cleanup" });
    await publishValidCheckpoint(f);
    await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupRetryAfterMs}', '0'::jsonb)` })
      .where(eq(environmentLeases.id, f.leaseId));
    await sweep();
    expect(calls.destroy).toHaveBeenCalledOnce();
  });
});
