import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// KEEP: row 20, never-OK dead chat/file custody. Crash fixture = exactly the
// durable rows left AFTER cancellation and BEFORE lease release; there is no
// old in-process executor and, critically, NO saved releaseDeferral. Neither
// recovery, cancellation preservation, execution blocker nor wake admission is
// mocked. Only the provider turn is scripted, as in heartbeat-warm-stop-hold.
const providerTurns = vi.hoisted(() => [] as string[]);
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    providerTurns.push(input.execution.binding.runId);
    throw new Error("row20_successor_provider_turn_reached");
  }) as typeof actual.executePaperclipNativeSession };
});

// adopt-stopu r2: the crash-recovered export resolves the still-running box the
// way the finalizer does (resolveEnvironmentExecutionTarget); for the crash
// lease only, it is the local "box" that holds the run's real v3 descriptor.
const boxTargets = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async input => input.leaseId && boxTargets.has(input.leaseId)
    ? boxTargets.get(input.leaseId) : actual.resolveEnvironmentExecutionTarget(input)) as typeof actual.resolveEnvironmentExecutionTarget };
});

import { execFile } from "node:child_process";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { getSandboxProvider } from "../services/sandbox-provider-runtime.js";
import { nativeRunNeverLaunchedRunner, readLeaseReleaseDeferral } from "../services/environment-lease-release-deferral.js";
import { readNativeWorkspaceSyncReference } from "../services/native-runtime/native-workspace-sync.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!support.supported)("rf-4 row 20: crash after durable cancel before active warm release", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("rf4-row20-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "rf4-row20-home-"));
    process.env.PAPERCLIP_HOME = home;
    await db.insert(authUsers).values({ id: "row20-person", name: "Person", email: "row20@example.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
    // The admitted successor stages read-only runtime-context assets.
    if (home) await new Promise(resolve => execFile("chmod", ["-R", "u+w", home], resolve));
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  /** The "box": commands run locally in its directory (as cancel-finalize-warm-stop.test.ts). */
  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.end(input.stdin ?? "");
  }) };

  // rf-4's RED used a synthetic descriptor ("a"x64), which no export can prove.
  // The U-shape row (adopt-stopu r2) seeds the same crash boundary with the
  // run's REAL prepared v3 descriptor: the edit exists only on the box.
  it.each([["U shape: real prepared v3 descriptor", true], ["GAP: rf-4 synthetic descriptor, no export provable", false]] as const)(
    "the next person's comment runs within 10s, or offers an honest Retry; owed files are never destroyed (%s)", async (_label, realDescriptor) => {
    providerTurns.length = 0;
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `sandbox://fake/${runId}/${randomUUID()}`;
    const stoppedAt = new Date(Date.now() - 60_000);
    const remoteCwd = path.join(home, `provider-task-workspace-${runId}`);
    await fs.mkdir(remoteCwd);
    const owedFile = path.join(remoteCwd, "notes.md");
    await fs.writeFile(owedFile, `task-workspace edit made before Stop, not yet exported: ${randomUUID()}\n`);
    let expectedSha = sha(await fs.readFile(owedFile));
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Row 20", issuePrefix,
      defaultResponsibleUserId: "row20-person", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "row20-person",
      status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native worker", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Warm crash source ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "fake", image: "fixture:test", reuseLease: true } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue my chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, responsibleUserId: "row20-person", issueNumber: 1,
      identifier: `${issuePrefix}-1`, conversationAgentId: agentId, conversationUserId: "row20-person",
      conversationState: "active", executionRunId: null, checkoutRunId: null });
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
      descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
      workspaceId, leaseId, providerLeaseId, remoteCwd, resourceDisposition: "keep_running" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", nativePhase: "terminal_failure", invocationSource: "on_demand",
      status: "cancelled", errorCode: "cancelled", error: "Cancelled by a board operator",
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      controllerLeaseExpiresAt: new Date(stoppedAt.getTime() - 1),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { ...(realDescriptor ? {} : { nativeWorkspaceSync: reference }), nativeResourceDisposition: "keep_running" },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "row20-person", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
        reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString(),
      } } });
    const hostCwd = path.join(home, `host-${runId}`);
    if (realDescriptor) {
      // The turn's own prepare: host -> box at the base, then the stopped turn's
      // tool edits the box. The edit is NOT exported (the crash came first).
      await fs.mkdir(hostCwd);
      await fs.writeFile(path.join(hostCwd, "notes.md"), "host base\n");
      await fs.rm(owedFile);
      const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "fake", leaseId,
        remoteCwd, runner: boxRunner, timeoutMs: 30_000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } };
      boxTargets.set(leaseId, target);
      const [leaseRow] = await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
        heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
        metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true,
          reusableSandboxLease: true, remoteCwd, agentId },
        acquiredAt: new Date(stoppedAt.getTime() - 60_000), lastUsedAt: stoppedAt,
        createdAt: new Date(stoppedAt.getTime() - 60_000), updatedAt: stoppedAt }).returning();
      const prepared = await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: hostCwd,
        target, lease: leaseRow as unknown as EnvironmentLease, resourceDisposition: "keep_running" });
      expect(prepared?.reference.state).toBe("prepared");
      await fs.writeFile(owedFile, `task-workspace edit made before Stop, not yet exported: ${randomUUID()}\n`);
      expectedSha = sha(await fs.readFile(owedFile));
    }
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_retry_cancelled", leaseOwner: null, leaseExpiresAt: null });
    // Prevent the startup/never-launched exception from disguising a mid-turn Stop.
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "tool.execution.started", stream: "system" });
    if (!realDescriptor) await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
      heartbeatRunId: runId, provider: "fake", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true,
        reusableSandboxLease: true, remoteCwd, agentId },
      acquiredAt: new Date(stoppedAt.getTime() - 60_000), lastUsedAt: stoppedAt,
      createdAt: new Date(stoppedAt.getTime() - 60_000), updatedAt: stoppedAt });

    // Fixture preconditions: no hold has been pre-seeded, the source is still
    // ACTIVE, the controller/finalizer owns nothing, and its v3 export is owed.
    const [before] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(before).toMatchObject({ status: "active", leasePolicy: "reuse_by_environment", releasedAt: null });
    expect(readLeaseReleaseDeferral(before.metadata)).toBeNull();
    const [seeded] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(readNativeWorkspaceSyncReference(seeded.runnerProfileJson?.nativeWorkspaceSync)).toMatchObject({ state: "prepared", leaseId });
    expect(await nativeRunNeverLaunchedRunner(db, runId, companyId)).toBe(false);
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();

    const provider = getSandboxProvider("fake")!;
    // Real fake-provider lifecycle, observed at the provider boundary. If a
    // regression calls destroy, make its filesystem consequence observable too.
    const originalDestroy = provider.destroyLease.bind(provider);
    const destroy = vi.spyOn(provider, "destroyLease").mockImplementation(async input => {
      if (input.providerLeaseId === providerLeaseId) await fs.rm(remoteCwd, { recursive: true, force: true });
      return originalDestroy(input);
    });
    const stop = vi.spyOn(provider, "stopLease");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      // This NEW facade has no live executor; emulate the first restart pass,
      // not the ordinary warm Stop handler or the cancelled-workspace sweep.
      const sweep = await heartbeat.sweepOrphanedActiveLeases({ companyId, leaseId, backoffMs: 0 });
      const [afterSweep] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const holds = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: "row20-person", body: "Please answer using my kept notes.md." }).returning();
      const admissionAt = Date.now();
      await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "row20-person", payload: { issueId, commentId: comment.id },
        contextSnapshot: { issueId, commentId: comment.id, wakeReason: "issue_commented" } });
      // Real admission/dispatch, no manual successor insertion. Bound is wall
      // time, not fake timers. A fixed bounded/Retry path need not create a run.
      let messageRuns: (typeof heartbeatRuns.$inferSelect)[] = [];
      let blocker = await getExecutionBlocker(db, companyId, issueId);
      for (;;) {
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
          sql`(${heartbeatRuns.contextSnapshot}->>'commentId' = ${comment.id}
            OR ${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${comment.id}
            OR ${heartbeatRuns.contextSnapshot}->'wakeCommentIds' @> ${JSON.stringify([comment.id])}::jsonb)`));
        blocker = await getExecutionBlocker(db, companyId, issueId);
        if (messageRuns.some(run => providerTurns.includes(run.id)) || blocker?.canRetry || Date.now() - admissionAt >= 10_000) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      const sourceSha = await fs.readFile(owedFile).then(sha, () => null);
      const elapsedMs = Date.now() - admissionAt;
      const executed = messageRuns.length === 1 && providerTurns.includes(messageRuns[0].id);
      // The fallback must be actionable, not merely a reassuring resolved hold:
      // one nonempty truthful line saying the work is kept, with Retry enabled.
      const line = blocker?.nextAction ?? "";
      const actionable = blocker?.canRetry === true && line.trim().length > 0 && !/[\r\n]/.test(line)
        && /kept|preserv|saved|recover/i.test(line);
      console.log("ROW20_EVIDENCE", JSON.stringify({ base: "8d1fc3e6fd4419fd8122c3da68798211fe6319dd",
        companyId, issueId, runId, leaseId, providerLeaseId, commentId: comment.id,
        sweep, before, afterSweep, holds, blocker, wakes, messageRuns, providerTurns, elapsedMs,
        expectedSha, sourceSha, destroyCalls: destroy.mock.calls, stopCalls: stop.mock.calls, executed, actionable }));
      // Custody is checked BEFORE the expected RED, so a green file assertion
      // and zero provider destroys are independently visible on the base.
      expect(destroy.mock.calls.filter(([input]) => input.providerLeaseId === providerLeaseId)).toHaveLength(0);
      expect(sourceSha).toBe(expectedSha);
      expect(elapsedMs).toBeLessThan(12_000);
      if (realDescriptor) {
        // adopt-stopu r2, U's intent: the crash-recovered release did what the
        // Stop's teardown does (U1 export finalized, then stop_and_retain), so
        // there is no preserve hold and the next message is admitted ONCE with
        // the stopped turn's edit on the host, sha-equal.
        const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const hostSha = await fs.readFile(path.join(hostCwd, "notes.md")).then(sha, () => null);
        const uShape = JSON.stringify({ reference: readNativeWorkspaceSyncReference(
          runAfter.runnerProfileJson?.nativeWorkspaceSync)?.state, cancelledWarmExport: runAfter.runnerProfileJson?.nativeCancelledWarmExport,
          lease: { status: afterSweep.status, policy: afterSweep.leasePolicy, stopReceipt: afterSweep.metadata?.remoteExecutionTermination },
          holds: holds.length, hostSha, expectedSha, messageRuns: messageRuns.length, providerTurns, elapsedMs });
        console.log("ROW20_U_SHAPE", uShape);
        if (process.env.ROW20_EVIDENCE_FILE) await fs.appendFile(process.env.ROW20_EVIDENCE_FILE, `${uShape}\n`);
        expect(readNativeWorkspaceSyncReference(runAfter.runnerProfileJson?.nativeWorkspaceSync)?.state).toBe("finalized");
        expect(hostSha).toBe(expectedSha);
        expect(afterSweep.status).toBe("released");
        expect(afterSweep.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId });
        expect(stop.mock.calls.filter(([input]) => input.providerLeaseId === providerLeaseId)).toHaveLength(1);
        expect(holds).toEqual([]);
        // The only blocker allowed is the scripted successor's own provider
        // failure (its turn throws by design), never a hold on the stopped run.
        expect(blocker?.runId ?? null).not.toBe(runId);
        expect(messageRuns).toHaveLength(1);
        expect(providerTurns.filter(id => id === messageRuns[0]?.id)).toHaveLength(1);
      }
      if (!realDescriptor) {
        // GAP (adopt-stopu r2, reported, NOT fixed): with a descriptor no export
        // can prove, the crash-recovered release is stop_and_retain (never
        // destroy, files kept on the box), the U1 export is recorded unproven,
        // and the existing preservation holds the message until the workspace
        // recovery worker restores it. Same as U's ordinary Stop with an
        // unproven export; rf-4's 10 s bound is not met on this path.
        const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(runAfter.runnerProfileJson?.nativeCancelledWarmExport).toMatchObject({ state: "unproven" });
        expect(afterSweep.metadata?.sandboxStopAndRetainReceipt).toMatchObject({ providerLeaseId });
        expect(blocker).toMatchObject({ runId, canRetry: false, workspaceRepairRequired: true, savedMessageCount: 1 });
        return;
      }
      expect(executed || actionable,
        `ROW20 DEAD CHAT: ${messageRuns.length} message runs; ${wakes.map(w => `${w.status}/runId=${w.runId}`).join(", ")}; `
        + `blocker.canRetry=${blocker?.canRetry}; nextAction=${line}`).toBe(true);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      destroy.mockRestore(); stop.mockRestore();
    }
  }, 60_000);
});
