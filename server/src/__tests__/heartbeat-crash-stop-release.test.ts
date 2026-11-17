import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason (never-OK: a withheld next message = a dead chat): a person's
// Stop on a WARM (keep_running) native turn is durably recorded, then the
// controller crashes BEFORE the active lease release, with no saved release
// deferral. The orphaned-lease recovery (heartbeat/recovery.ts
// retryTerminalRunLeaseRelease) releases it on a new controller; then the
// person's next message. Real cancelRun, real recovery release, real
// run-control preservation and the real claim gate on a real database. Only
// the provider edge is scripted, as in heartbeat-warm-stop-hold.test.ts.
const fixture = vi.hoisted(() => ({
  warm: true,
  calls: [] as string[],
  onFirst: undefined as undefined | ((input: { runId: string }) => Promise<void>),
}));

vi.mock("../services/heartbeat/runtime-selection.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat/runtime-selection.js")>();
  return {
    ...actual,
    prepareAndSelectHeartbeatRuntime: (async (db, input, deps) => actual.prepareAndSelectHeartbeatRuntime(db, {
      ...input,
      // The admitted value a warm sandbox lifecycle selects (runtime-selection
      // nativeSandboxLifecycle.sandboxResource === "keep_running").
      onProviderResourceDisposition: disposition => input.onProviderResourceDisposition(
        fixture.warm ? "keep_running" : disposition),
    }, deps)) as typeof actual.prepareAndSelectHeartbeatRuntime,
  };
});

vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return {
    ...actual,
    // Provider edge of Stop: the run-only abort reached the live Pi session
    // (dispatched). The durable intent and acknowledgement stay product code.
    cancelNativeSession: (async (runId: string, reason: string, options?: Parameters<typeof actual.cancelNativeSession>[2]) => {
      const result = await actual.cancelNativeSession(runId, reason, options!);
      if (!options || !fixture.calls.includes(runId) || typeof result !== "object") return result;
      const { db } = options;
      const { heartbeatRuns } = await import("@paperclipai/db");
      const { eq, sql } = await import("drizzle-orm");
      await db.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson},
        '{nativeCancellation,dispatched}', 'true'::jsonb)` }).where(eq(heartbeatRuns.id, runId));
      return { ...result, dispatched: true };
    }) as typeof actual.cancelNativeSession,
    executePaperclipNativeSession: (async input => {
      const runId = input.execution.binding.runId;
      fixture.calls.push(runId);
      if (fixture.calls.length === 1 && fixture.onFirst) {
        await fixture.onFirst({ runId });
        // The executor's own unwinding after an acknowledged Stop: it settles
        // the coordinator and throws for the outer recovery handler.
        throw new actual.NativeCancellationPendingRecoveryError();
      }
      throw new Error("successor_provider_turn_reached");
    }) as typeof actual.executePaperclipNativeSession,
  };
});

import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe.skipIf(!support.supported)("a crash between a warm Stop and its lease release, then the next message", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-crash-stop-release-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "crash-stop-release-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible User",
      email: "responsible-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Warm stop", issuePrefix,
      defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "assignment",
      triggerDetail: "system", reason: "issue_assigned", payload: { issueId }, status: "queued", runId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "system", status: "queued", wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", priority: "medium",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, responsibleUserId: "responsible-user",
      issueNumber: 1, identifier: `${issuePrefix}-1`, startedAt: new Date() });
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, runId, issueId };
  }

  async function stopCrashRecoverThenMessage(options: { warm: boolean; boxLost?: boolean }) {
    fixture.warm = options.warm;
    fixture.calls = [];
    const f = await seed();
    const unsynced = path.join(home, `${f.runId}-agent-notes.md`);
    let unsyncedSha: string | null = null;
    let leaseId: string | undefined;
    let crashed = true;
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      // The controller dies before this release reaches the provider or the row.
      if (crashed) return { released: [], errors: [] };
      // The provider edge (heartbeat-warm-lease-failure.test.ts): keep_running
      // hands the lease back retained; any other disposition releases it.
      if (input.providerResourceDisposition === "keep_running") await db.update(environmentLeases)
        .set({ status: "retained", cleanupStatus: "success" })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      else await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    const deps = {
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async (runId: string) => {
        if (runId !== f.runId) return;
        const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
          heartbeatRunId: runId, provider: "daytona", providerLeaseId: randomUUID(), status: "active",
          leasePolicy: options.warm ? "reuse_by_environment" : "ephemeral",
          metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" },
        }).returning();
        leaseId = lease!.id;
        const reference = { schema: "paperclip.native-workspace-sync/v3" as const, state: "prepared" as const,
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId: randomUUID(), leaseId: lease!.id, providerLeaseId: lease!.providerLeaseId!, remoteCwd: "/work",
          resourceDisposition: options.warm ? "keep_running" as const : "destroy" as const };
        await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId, nativePhase: "observed",
          runnerProfileJson: { nativeWorkspaceSync: reference,
            ...(options.warm ? { nativeResourceDisposition: "keep_running" } : {}) },
        }).where(eq(heartbeatRuns.id, runId));
        await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: f.issueId, phase: "observed" });
      },
    };
    const crashedController = heartbeatService(db, deps);
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      await fs.writeFile(unsynced, "unsynced agent notes\n");
      unsyncedSha = createHash("sha256").update(await fs.readFile(unsynced)).digest("hex");
      // The person's Stop, exactly as POST /heartbeat-runs/:id/cancel sends it.
      stopping = crashedController.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } });
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled";
      });
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
        leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
    };
    try {
      await crashedController.resumeQueuedRuns();
      await crashedController.drainActiveRunExecutions();
      await stopping;
      expect((await crashedController.getRun(f.runId))?.status).toBe("cancelled");
      // The crash: the durable cancellation is written, the active lease was
      // never released and no release deferral was saved; the controller lease lapsed.
      await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} - 'releaseDeferral'`,
        ...(options.boxLost ? { metadata: sql`(${environmentLeases.metadata} - 'releaseDeferral')
          || '{"remoteExecutionTermination":{"state":"stopped"}}'::jsonb` } : {}) })
        .where(eq(environmentLeases.id, leaseId!));
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      const [crashLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId!));
      expect(crashLease).toMatchObject({ status: "active" });
      expect(crashLease!.metadata?.releaseDeferral).toBeUndefined();
      release.mockClear();
      crashed = false;
      // A new controller: the orphaned-lease recovery pass, then the next message.
      const recovered = heartbeatService(db, deps);
      await recovered.sweepOrphanedActiveLeases({ backoffMs: 0, companyId: f.companyId });
      const recoveryRelease = release.mock.calls.map(([input]) => input.providerResourceDisposition);
      const commentId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "responsible-user", body: "Carry on, please." });
      await recovered.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "responsible-user",
        payload: { issueId: f.issueId, commentId },
        contextSnapshot: { issueId: f.issueId, commentId, wakeReason: "issue_commented" } });
      // One dispatch pass.
      await recovered.resumeQueuedRuns();
      await recovered.drainActiveRunExecutions();
      const hold = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      const messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'commentId' = ${commentId}`));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId!));
      return { f, hold, messageRuns, lease, recoveryRelease, unsynced, unsyncedSha, calls: [...fixture.calls] };
    } finally {
      fixture.onFirst = undefined;
      factory.mockRestore();
    }
  }

  it("a person-stopped warm keep_running run is released as the handoff its teardown would use; the next message runs", async () => {
    const r = await stopCrashRecoverThenMessage({ warm: true });
    // The recovery release keeps the warm box (the teardown's disposition), never destroy.
    expect.soft(r.recoveryRelease).toEqual(["keep_running"]);
    expect.soft(r.lease).toMatchObject({ status: "retained", leasePolicy: "reuse_by_environment" });
    // No native-workspace:<run> hold; the message runs within one dispatch pass.
    expect.soft(r.hold).toEqual([]);
    expect.soft(r.messageRuns).toHaveLength(1);
    expect.soft(r.messageRuns[0]?.errorCode).not.toBe("execution_reconciliation_required");
    expect.soft(r.calls).toEqual([r.f.runId, r.messageRuns[0]?.id]);
    expect.soft(createHash("sha256").update(await fs.readFile(r.unsynced)).digest("hex")).toBe(r.unsyncedSha);
  }, 120_000);

  it("a warm box that really stopped (handoff unprovable) is stopped and retained, and its owed files keep the hold", async () => {
    const r = await stopCrashRecoverThenMessage({ warm: true, boxLost: true });
    expect(r.recoveryRelease).toEqual(["stop_and_retain"]);
    expect(r.hold).toEqual([expect.objectContaining({ cause: "native_continuation_requires_reconciliation" })]);
    expect(createHash("sha256").update(await fs.readFile(r.unsynced)).digest("hex")).toBe(r.unsyncedSha);
  }, 120_000);

});
