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
const providerInputs = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  return { ...actual, executePaperclipNativeSession: (async input => {
    providerTurns.push(input.execution.binding.runId);
    providerInputs.set(input.execution.binding.runId, JSON.stringify(input.execution));
    throw new Error("row20_successor_provider_turn_reached");
  }) as typeof actual.executePaperclipNativeSession };
});

// adopt-stopu r2: the crash-recovered export resolves the still-running box the
// way the finalizer does (resolveEnvironmentExecutionTarget); for the crash
// lease only, it is the local "box" that holds the run's real v3 descriptor.
const boxTargets = vi.hoisted(() => new Map<string, unknown>());
const boxDelays = vi.hoisted(() => new Map<string, number>());
const exportStarts = vi.hoisted(() => [] as Array<{ leaseId: string; at: number }>);
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: (async input => {
    if (!input.leaseId || !boxTargets.has(input.leaseId)) return actual.resolveEnvironmentExecutionTarget(input);
    const delay = boxDelays.get(input.leaseId) ?? 0;
    exportStarts.push({ leaseId: input.leaseId, at: Date.now() });
    if (delay === Infinity) await new Promise(() => undefined);
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return boxTargets.get(input.leaseId);
  }) as typeof actual.resolveEnvironmentExecutionTarget };
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
import { PERSON_STOP_EXPORT_BOUND_MS, PERSON_STOP_WITHOUT_FILES_LINE, readPersonStopBoundDecision } from "../services/heartbeat/person-stop-export-bound.js";

const support = await getEmbeddedPostgresTestSupport();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!support.supported)("adopt-stopu-xpaths: a person's Stop never stops a box that holds the only copy of the edit", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("xpaths-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "xpaths-home-"));
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


  const kases = [["r4/F10 shape: export finalizes 10 s after the Stop; a Send at +0.1 s", 10_000],
    ["(superseded by replacement: one bounded behaviour, same box first, RFL record SUPERSEDE-U-UNPROVABLE-1117) export never finishes (forced timeout): box kept, no stop", Infinity]] as const;
  it.each(kases)("%s", async (_label, exportDelayMs) => {
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
      status: "cancelled", errorCode: "cancelled", error: "Cancelled by a board operator", nextEventSeq: 2,
      startedAt: new Date(stoppedAt.getTime() - 60_000), finishedAt: stoppedAt,
      controllerLeaseExpiresAt: new Date(stoppedAt.getTime() - 1),
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running",
        // pl/r4-work3 (a): NSE's settle of the person's Stop recorded the closed
        // session's clean close (the stopped turn's tools are gone) before the crash.
        nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1", companyId, issueId, runId,
          sessionId: null, clean: true, at: stoppedAt.toISOString() } },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "row20-person", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
        reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString(),
      } } });
    const hostCwd = path.join(home, `host-${runId}`);
    {
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
    if (false) await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, environmentId,
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

    void reference;
    boxDelays.set(leaseId, exportDelayMs);
    // A pre-warmed SPARE on the same environment (r4: the successor took spare
    // lease 40506ceb): a released, reusable box for the same agent/issue that
    // does NOT hold the edit.
    const spareLeaseId = randomUUID();
    const spareProviderLeaseId = `sandbox://fake/spare/${randomUUID()}`;
    await db.insert(environmentLeases).values({ id: spareLeaseId, companyId, issueId, environmentId,
      heartbeatRunId: null, provider: "fake", providerLeaseId: spareProviderLeaseId, status: "released", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", provider: "fake", image: "fixture:test", reuseLease: true,
        reusableSandboxLease: true, remoteCwd: path.join(home, `spare-${runId}`), agentId },
      acquiredAt: stoppedAt, lastUsedAt: stoppedAt, releasedAt: stoppedAt, createdAt: stoppedAt, updatedAt: stoppedAt });
    const provider = getSandboxProvider("fake")!;
    const stopAt: number[] = [];
    const originalStop = provider.stopLease?.bind(provider);
    const stop = vi.spyOn(provider, "stopLease").mockImplementation(async input => {
      if (input.providerLeaseId === providerLeaseId) stopAt.push(Date.now());
      return originalStop!(input);
    });
    const destroy = vi.spyOn(provider, "destroyLease");
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    try {
      // The Stop's teardown release: the SAME call the executor's teardown makes
      // (heartbeat.ts lease_release, keep_running admitted -> stop_and_retain for
      // a cancelled run), with NO in-run cancel-finalize mark: the Stop surfaced
      // as another error class (r4: nativeCancelledWarmExport null).
      const stopReceiptAt = Date.now();
      const release = heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: "cancelled",
        failureReason: "Cancelled by a board operator", providerResourceDisposition: "keep_running", trigger: "teardown" });
      await new Promise(resolve => setTimeout(resolve, 100));
      // F10: the Send / next message lands 0.1 s after the Stop's HTTP receipt.
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: "row20-person", body: "Send: please continue using notes.md." }).returning();
      await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "row20-person", payload: { issueId, commentId: comment.id },
        contextSnapshot: { issueId, commentId: comment.id, wakeReason: "issue_commented" } });
      const hostAtTurn = new Map<string, string | null>();
      let messageRuns: (typeof heartbeatRuns.$inferSelect)[] = [];
      const deadline = Date.now() + (exportDelayMs === Infinity ? 40_000 : 25_000);
      let released = false;
      void release.then(() => { released = true; });
      for (;;) {
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        messageRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.id} <> ${runId}`));
        for (const turn of providerTurns) if (!hostAtTurn.has(turn))
          hostAtTurn.set(turn, await fs.readFile(path.join(hostCwd, "notes.md")).then(sha, () => null));
        if ((released && providerTurns.length > 0) || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!released) await Promise.race([release, new Promise(resolve => setTimeout(resolve, 2_000))]);
      const [leaseAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const successorLeases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
        sql`${environmentLeases.heartbeatRunId} <> ${runId}`));
      const hostSha = await fs.readFile(path.join(hostCwd, "notes.md")).then(sha, () => null);
      const boxSha = await fs.readFile(owedFile).then(sha, () => null);
      const evidence = { label: _label, runId, leaseId, providerLeaseId, spareProviderLeaseId, stopReceiptAt,
        exportStarts: exportStarts.filter(s => s.leaseId === leaseId).map(s => s.at - stopReceiptAt),
        stopAtMs: stopAt.map(at => at - stopReceiptAt), released,
        reference: readNativeWorkspaceSyncReference(runAfter.runnerProfileJson?.nativeWorkspaceSync)?.state,
        cancelledWarmExport: runAfter.runnerProfileJson?.nativeCancelledWarmExport,
        lease: { status: leaseAfter.status, receipt: leaseAfter.metadata?.remoteExecutionTermination ?? null,
          deferral: readLeaseReleaseDeferral(leaseAfter.metadata) },
        lines: events.filter(e => e.eventType === "workspace_export_deferred" || e.eventType === "workspace_export_finalized").map(e => e.message),
        successorRuns: messageRuns.map(r => ({ id: r.id, status: r.status })), providerTurns: [...providerTurns],
        successorLeases: successorLeases.map(l => ({ id: l.id, providerLeaseId: l.providerLeaseId, status: l.status })),
        hostAtTurn: Object.fromEntries(hostAtTurn), hostSha, boxSha, expectedSha,
        destroyCalls: destroy.mock.calls.filter(([i]) => i.providerLeaseId === providerLeaseId).length };
      console.log("XPATHS_EVIDENCE", JSON.stringify(evidence));
      if (process.env.XPATHS_EVIDENCE_FILE) await fs.appendFile(process.env.XPATHS_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
      // Never-OK, both cases: the box holding the edit is never destroyed and
      // the edit is never lost from it.
      expect(evidence.destroyCalls).toBe(0);
      expect(boxSha).toBe(expectedSha);
      // No successor starts on the spare (which lacks the edit) before the bound.
      expect(successorLeases.filter(l => l.providerLeaseId === spareProviderLeaseId && l.status === "active")).toEqual([]);
      if (exportDelayMs !== Infinity) {
        // The export ran and FINISHED before the box's stop, at the release.
        expect(evidence.reference).toBe("finalized");
        expect(hostSha).toBe(expectedSha);
        expect(stopAt).toHaveLength(1);
        expect(stopAt[0]! - stopReceiptAt).toBeGreaterThanOrEqual(exportDelayMs);
        expect(leaseAfter.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId });
        // The Send that landed at +0.1 s did not start before the release;
        // its provider turn saw the edit on the host, sha-equal.
        for (const turn of providerTurns) expect(hostAtTurn.get(turn)).toBe(expectedSha);
      } else {
        // (c): export timed out -> NO stop, the box is KEPT (lease still active,
        // deferral recorded for the bounded retry), the person sees the true line,
        // and no successor ran without the edit.
        expect(stopAt).toEqual([]);
        expect(leaseAfter.status).toBe("active");
        expect(evidence.lease.deferral).toMatchObject({ reason: "person_stop_export_unproven" });
        expect(evidence.cancelledWarmExport).toMatchObject({ state: "unproven", reason: "timed_out" });
        expect(evidence.lines.some(line => /could not be confirmed in time.*The box is kept/.test(line ?? ""))).toBe(true);
        expect(providerTurns).toEqual([]);
        // adopt-stopu-compose4 (RFL 22:25Z, rf-4 22:53Z): the hold is BOUNDED.
        // The deferral retry lands AT the bound (retryAt capped); the worker's
        // retry is the same release call. Fake Date only: the clock jumps to it.
        const deferral = readLeaseReleaseDeferral(leaseAfter.metadata)!;
        const boundAt = Date.parse(deferral.failingSince) + PERSON_STOP_EXPORT_BOUND_MS;
        expect(Date.parse(deferral.retryAt)).toBeLessThanOrEqual(boundAt);
        // Just before the bound: still held, no decision.
        vi.useFakeTimers({ toFake: ["Date"], now: boundAt - 1_000 });
        try {
          await heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: "cancelled",
            providerResourceDisposition: "keep_running", trigger: "release_retry" }).catch(() => undefined);
        } finally { vi.useRealTimers(); }
        await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
        expect(providerTurns).toEqual([]);
        const [beforeBound] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        expect(readPersonStopBoundDecision(beforeBound.metadata)).toBeNull();
        // At the bound: the box is UNREACHABLE by line (its target never resolves:
        // the probe times out) -> run once WITHOUT the files, ONE true line.
        vi.useFakeTimers({ toFake: ["Date"], now: boundAt });
        try {
          await heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: "cancelled",
            providerResourceDisposition: "keep_running", trigger: "release_retry" }).catch(() => undefined);
        } finally { vi.useRealTimers(); }
        const boundDeadline = Date.now() + 20_000;
        while (providerTurns.length === 0 && Date.now() < boundDeadline) {
          await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        const [atBound] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        const boundEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
        const boundEvidence = { decision: readPersonStopBoundDecision(atBound.metadata), leaseStatus: atBound.status,
          stopAtMs: stopAt.map(at => at - stopReceiptAt), providerTurns: [...providerTurns],
          stopToBoundMin: (boundAt - stopReceiptAt) / 60_000,
          withoutFilesLines: boundEvents.filter(e => e.message === PERSON_STOP_WITHOUT_FILES_LINE).map(e => e.eventType) };
        console.log("XPATHS_BOUND_EVIDENCE", JSON.stringify(boundEvidence));
        if (process.env.XPATHS_EVIDENCE_FILE) await fs.appendFile(process.env.XPATHS_EVIDENCE_FILE, `${JSON.stringify(boundEvidence)}\n`);
        expect(boundEvidence.decision).toMatchObject({ decision: "without_files", reason: "box_unreachable_probe" });
        expect(boundEvidence.stopToBoundMin).toBeLessThanOrEqual(10);
        // The message ran ONCE, without the files; ONE true line in the chat (one
        // transcript notice + its system event); no 'restored' claim in its input.
        expect(providerTurns).toHaveLength(1);
        expect(boundEvidence.withoutFilesLines.sort()).toEqual(["provider.notice.recorded", "workspace_export_bound_reached"]);
        expect(providerInputs.get(providerTurns[0]!) ?? "").not.toMatch(/restored/i);
        // The box is still KEPT: lease active, never stopped, never destroyed, edit on it.
        expect(atBound.status).toBe("active");
        expect(stopAt).toEqual([]);
        expect(destroy.mock.calls.filter(([i]) => i.providerLeaseId === providerLeaseId)).toHaveLength(0);
        expect(await fs.readFile(owedFile).then(sha)).toBe(expectedSha);
      }
    } finally {
      await heartbeat.drainActiveRunExecutions();
      destroy.mockRestore(); stop.mockRestore();
    }
  }, 150_000);
});
