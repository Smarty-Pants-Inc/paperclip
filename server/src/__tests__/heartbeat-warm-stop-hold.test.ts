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

// Keep reason: Stop on a WARM (keep_running) native chat turn, then the
// person's next message. Crosses the real heartbeat teardown (the
// NativeCancellationPendingRecoveryError handler), real cancelRun, real lease
// release and the real run-dispatch claim gate on a real database. Only the
// provider edge is scripted: the executor's settle-then-throw after an
// acknowledged Stop (native-session-executor.ts, cancellation pending recovery)
// and the admitted warm sandbox lifecycle (runtime-selection's keep_running).
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
import { preserveCancelledNativeWorkspaces } from "../services/native-runtime/native-failed-workspace-recovery.js";

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

describe.skipIf(!support.supported)("Stop on a warm native turn, then the next message", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-warm-stop-hold-");
    db = createDb(tempDb.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "warm-stop-hold-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "responsible-user", name: "Responsible User",
      email: "responsible-user@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
    const writable = async (dir: string): Promise<void> => {
      const stat = await fs.lstat(dir).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      await fs.chmod(dir, 0o700);
      for (const entry of await fs.readdir(dir, { withFileTypes: true }))
        if (entry.isDirectory()) await writable(path.join(dir, entry.name));
    };
    if (home) { await writable(home); await fs.rm(home, { recursive: true, force: true }); }
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

  async function stopThenMessage(options: { warm: boolean; messageDelay: "immediate" | "after_sweep" }) {
    fixture.warm = options.warm;
    fixture.calls = [];
    const f = await seed();
    const unsynced = path.join(home, `${f.runId}-agent-notes.md`);
    let unsyncedSha: string | null = null;
    let leaseId: string | undefined;
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    // The provider edge of lease release: a keep_running release hands the
    // lease back retained (heartbeat-warm-lease-failure.test.ts); nothing stops.
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active"),
          eq(environmentLeases.provider, "local")));
      if (input.providerResourceDisposition === "keep_running") await db.update(environmentLeases)
        .set({ status: "retained", cleanupStatus: "success" })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    const heartbeat = heartbeatService(db, {
      // The scripted executor below owns the provider edge; no backend is driven.
      nativeSessionBackendFactory: () => ({}) as never,
      beforeNativeRuntimeSelection: async runId => {
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
    });
    const commentId = randomUUID();
    const sendMessage = async () => {
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "responsible-user", body: "Carry on, please." });
      await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "responsible-user",
        payload: { issueId: f.issueId, commentId },
        contextSnapshot: { issueId: f.issueId, commentId, wakeReason: "issue_commented" } });
    };
    let stopping: Promise<unknown> | undefined;
    fixture.onFirst = async ({ runId }) => {
      // Mid tool call: the tool has written an agent file the turn has not synced.
      await fs.writeFile(unsynced, "unsynced agent notes\n");
      unsyncedSha = createHash("sha256").update(await fs.readFile(unsynced)).digest("hex");
      // The person's Stop, exactly as POST /heartbeat-runs/:id/cancel sends it.
      stopping = heartbeat.cancelRun(runId, "Cancelled by a board operator", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: "responsible-user" } });
      void stopping.catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const value = row?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        return value?.dispatchState === "acknowledged" && row?.status === "cancelled";
      });
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_retry_cancelled",
        leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
      // +0 s: the person's message arrives once the Stop is visible as a
      // terminal run, while this turn is still unwinding.
      if (options.messageDelay === "immediate") {
        await sendMessage();
      }
    };
    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      await stopping;
      expect((await heartbeat.getRun(f.runId))?.status).toBe("cancelled");
      if (options.messageDelay === "after_sweep") {
        // +30 s: the cancelled-workspace sweep has had its pass before the person writes.
        await preserveCancelledNativeWorkspaces(db);
      }
      if (options.messageDelay === "after_sweep") await sendMessage();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const hold = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.fingerprint, `native-workspace:${f.runId}`)));
      const messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'commentId' = ${commentId}`));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId!));
      return { f, hold, messageRuns, lease, release, unsynced, unsyncedSha, calls: [...fixture.calls] };
    } finally {
      fixture.onFirst = undefined;
      factory.mockRestore();
    }
  }

  it.each(["immediate", "after_sweep"] as const)(
    "a warm keep_running Stop writes no file-preservation hold; the message (%s) runs once on the same box",
    async messageDelay => {
      const r = await stopThenMessage({ warm: true, messageDelay });
      // No native-workspace:<run> recovery hold for the stopped warm turn.
      expect.soft(r.hold).toEqual([]);
      // The warm box is not stopped: the lease is never released stop_and_retain.
      expect.soft(r.release).not.toHaveBeenCalledWith(expect.objectContaining({ providerResourceDisposition: "stop_and_retain" }));
      expect.soft(r.release).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: r.f.runId, providerResourceDisposition: "keep_running" }));
      expect.soft(r.lease).not.toMatchObject({ leasePolicy: "retain_on_failure" });
      // Exactly one run for the message, and it reached the executor (one provider turn).
      expect.soft(r.messageRuns).toHaveLength(1);
      expect.soft(r.messageRuns[0]!.errorCode).not.toBe("execution_reconciliation_required");
      expect.soft(r.calls).toEqual([r.f.runId, r.messageRuns[0]!.id]);
      // The unsynced agent file is untouched.
      expect.soft(createHash("sha256").update(await fs.readFile(r.unsynced)).digest("hex")).toBe(r.unsyncedSha);
    },
    120_000,
  );

  it("a non-warm Stop (the box really stops) still preserves the prepared files", async () => {
    const r = await stopThenMessage({ warm: false, messageDelay: "immediate" });
    expect(r.hold).toEqual([expect.objectContaining({ cause: "native_continuation_requires_reconciliation" })]);
    expect(r.release).toHaveBeenCalledWith(expect.objectContaining({ heartbeatRunId: r.f.runId, providerResourceDisposition: "stop_and_retain" }));
    expect(createHash("sha256").update(await fs.readFile(r.unsynced)).digest("hex")).toBe(r.unsyncedSha);
  }, 120_000);
});
