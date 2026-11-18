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

describe.skipIf(!support.supported)("adopt-stopu-ugate (2), never-OK: close-success alone never exports a box a stopped turn's escaped writer still writes", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("ugate-escaped-");
    db = createDb(temporary.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ugate-escaped-home-"));
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
  let processTableUnreadable = false;
  const boxRunner: CommandManagedRuntimeRunner = { execute: async input => new Promise(resolve => {
    // Case 2: the box answers, but its process table cannot be read (no /proc).
    if (processTableUnreadable && input.command === "sh" && String(input.args?.[1] ?? "").includes("/proc/stat"))
      return resolve({ exitCode: 4, signal: null, timedOut: false, stdout: "ERR no_proc\n", stderr: "", pid: null, startedAt: null });
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env },
      timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
      timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.end(input.stdin ?? "");
  }) };


  it.each([["killable: the writer is killed, then the export is consistent", false],
    ["process table unreadable: no export, box kept, the true line", true]] as const)
  ("a setsid/nohup loop writing notes.md survives the clean close (%s)", async (_label, unreadable) => {
    const exportDelayMs = 0;
    processTableUnreadable = unreadable;

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
    // THE ESCAPED WRITER: a daemonised (setsid + nohup) child of the stopped
    // turn, started after the turn start, still appending to the workspace file
    // although NSE recorded the session close as clean.
    const { spawn } = await import("node:child_process");
    const pidFile = path.join(home, `writer-${runId}.pid`);
    spawn("sh", ["-c", `setsid nohup sh -c 'echo $$ > ${pidFile}; while :; do date +%s%N >> notes.md; sleep 0.05; done' >/dev/null 2>&1 &`],
      { cwd: remoteCwd, stdio: "ignore", detached: true }).unref();
    let writerPid = 0;
    for (let i = 0; i < 50 && !writerPid; i++) { await new Promise(r => setTimeout(r, 100));
      writerPid = Number((await fs.readFile(pidFile, "utf8").catch(() => "")).trim()) || 0; }
    expect(writerPid).toBeGreaterThan(0);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: () => ({}) as never });
    const provider = getSandboxProvider("fake")!;
    const stop = vi.spyOn(provider, "stopLease");
    try {
      await Promise.race([heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: "cancelled",
        failureReason: "Cancelled by a board operator", providerResourceDisposition: "keep_running", trigger: "teardown" })
        .catch(() => undefined), new Promise(resolve => setTimeout(resolve, 45_000))]);
      const writerAliveAfter = alive(writerPid);
      const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const [leaseAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const state = readNativeWorkspaceSyncReference(runAfter.runnerProfileJson?.nativeWorkspaceSync)?.state;
      const boxSha1 = await fs.readFile(owedFile).then(sha, () => null);
      await new Promise(resolve => setTimeout(resolve, 600));
      const boxSha2 = await fs.readFile(owedFile).then(sha, () => null);
      const hostSha = await fs.readFile(path.join(hostCwd, "notes.md")).then(sha, () => null);
      const evidence = { label: _label, writerPid, writerAliveAfter, state, mark: runAfter.runnerProfileJson?.nativeCancelledWarmExport,
        leaseStatus: leaseAfter.status, providerStops: stop.mock.calls.filter(([i]) => i.providerLeaseId === providerLeaseId).length,
        boxStable: boxSha1 === boxSha2, hostEqualsBox: hostSha === boxSha2, hostSha, boxSha: boxSha2,
        lines: events.filter(e => e.eventType === "workspace_export_deferred").map(e => e.message) };
      console.log("UGATE_ESCAPED_EVIDENCE", JSON.stringify(evidence));
      if (process.env.UGATE_EVIDENCE_FILE) await fs.appendFile(process.env.UGATE_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`);
      if (unreadable) expect(state).toBe("prepared"); else expect(state).toBe("finalized");
      if (state === "finalized") {
        // Exported: only after the writer was killed, and the host holds exactly the box's final bytes.
        expect(writerAliveAfter).toBe(false);
        expect(evidence.boxStable).toBe(true);
        expect(evidence.hostEqualsBox).toBe(true);
      } else {
        // Not exported: the box kept (never stopped), the true line shown.
        expect(evidence.providerStops).toBe(0);
        expect(leaseAfter.status).toBe("active");
        expect(evidence.lines).toContain("Stopped, but the box's tools could not be proven stopped, so the workspace was not copied back. The box is kept.");
      }
      // Passing with the writer alive AND the export done is NOT MET.
      expect(writerAliveAfter && state === "finalized").toBe(false);
    } finally {
      if (alive(writerPid)) process.kill(writerPid, "SIGKILL");
      await heartbeat.drainActiveRunExecutions();
      stop.mockRestore();
    }
  }, 120_000);
});
