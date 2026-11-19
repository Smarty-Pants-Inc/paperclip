/**
 * pl/cancel-finalize: a person's mid-turn Stop of a warm (keep_running) native
 * turn must not cost the next message its box.
 *
 * Real: embedded Postgres, executeHeartbeatRuntime's cancellation boundary
 * (heartbeat/runtime-execution.ts catch of NativeCancellationPendingRecoveryError),
 * native workspace sync (prepare, copyback, descriptor, stamps) against a local
 * "box" directory through a command runner, the finalization ownership lock,
 * and the acquisition reuse filter (nativeWorkspaceExportPendingForResource).
 * Doubled: only the provider turn (executePaperclipNativeSession), which plays
 * the agent's own tool editing the TASK WORKSPACE on the box and then the
 * person's Stop settling as NSE does (acknowledged Stop + terminal_failure /
 * native_retry_cancelled, without a retained idle receipt under stop_and_retain),
 * plus the unrelated MCP / wake / usage boundaries (as warm-rebind-recovery-policy.test.ts).
 */
import { execFile } from "node:child_process";
import { assertDrainAdmissionReplacement } from "./drain-admission.test-fixture.js";
import { promises as auditFs } from 'node:fs';
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, issueRecoveryActions,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";
import type { EnvironmentLease } from "@paperclipai/shared";
import { withDirectoryMergeLock, captureDirectorySnapshot, directorySnapshotSha256 } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAdapterExecutionControl } from "./adapter-execution-control.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./heartbeat/runtime-execution.js";
import { finishCancelledWarmWorkspaceExport } from "./heartbeat/cancelled-warm-workspace-export.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import * as nativeExecutor from "./native-runtime/native-session-executor.js";
import { nativeWorkspaceExportPendingForResource } from "./native-runtime/native-workspace-finalization-state.js";
import { nativeWorkspaceSyncInternals, prepareNativeWorkspaceSync, readNativeWorkspaceSyncReference, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "./native-runtime/runtime-mode.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";

vi.mock("./native-runtime/native-run-wake-anchor.js", () => ({ readNativeRunWakeRequestedAtMs: async () => null }));
vi.mock("./usage-receipts.js", async original => ({
  ...await original<typeof import("./usage-receipts.js")>(),
  createRunUsageRecorder: async () => ({ capture: async () => {}, persistFailure: async () => {},
    complete: async () => ({ complete: true }) }),
}));
vi.mock("./native-runtime/native-runner-file-handoff.js", () => ({
  stageNativeRunnerWakeAttachments: async () => ({ attachments: [], cleanup: async () => {} }),
  renderNativeRunnerStagedAttachmentPrompt: () => "",
}));
vi.mock("./native-runtime/current-wake-comments.js", async original => ({
  ...await original<typeof import("./native-runtime/current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => {},
}));
vi.mock("./heartbeat/run-preparation.js", async original => ({
  ...await original<typeof import("./heartbeat/run-preparation.js")>(),
  buildPaperclipRuntimeMcpServers: async () => [],
  revokeHeartbeatRunGatewayTokens: async () => {},
}));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BASE = "base contents\n";
const EDIT = "edited on the box by the stopped turn\n";

type BoxState = { fail: boolean; calls: number; inflight?: number; held?: number;
  /** A command matching `match` is held until `until` resolves, then runs (a held command that joins late). */
  gate?: { match: (script: string) => boolean; until: Promise<void> } | null };

/** The "box": commands run locally against its directory. */
function boxRunner(state: BoxState): CommandManagedRuntimeRunner {
  return {
    execute: async (input) => {
      state.inflight = (state.inflight ?? 0) + 1;
      try {
        const gate = state.gate;
        if (gate && gate.match((input.args ?? []).join(" "))) {
          state.held = (state.held ?? 0) + 1;
          await gate.until;
        }
        return await runOnBox(state, input);
      } finally {
        state.inflight -= 1;
      }
    },
  };
}

function runOnBox(state: BoxState, input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) {
  return {
    run: () => new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>((resolve, reject) => {
      state.calls += 1;
      if (state.fail) {
        resolve({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "box unreachable", pid: null, startedAt: null });
        return;
      }
      const child = execFile(input.command, input.args ?? [], {
        cwd: input.cwd, env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null,
      }));
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin?.end(input.stdin ?? "");
    }),
  }.run();
}

const STAMP = [".paperclip-runtime", "paperclip-runner", "workspace-sync-v1.json"];
const DEFERRED_FIXTURE = fileURLToPath(new URL(
  "../../../ui/src/components/transcript/fixtures/cancelled-warm-export-deferred.json", import.meta.url));
async function waitFor(check: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("adopt-drain: an abandoned workspace restore never mutates the host after it releases ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cancel-finalize-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  type Variant = { edit: boolean; settled: boolean; exportFails: boolean };
  async function stopMidTurn(variant: Variant) {
    const root = await mkdtemp(join(tmpdir(), "paperclip-cancel-finalize-"));
    roots.push(root);
    vi.stubEnv("PAPERCLIP_HOME", join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "cancel-finalize");
    const host = join(root, "host"), box = join(root, "box");
    await mkdir(host, { recursive: true });
    await mkdir(box, { recursive: true });
    await writeFile(join(host, "task.txt"), BASE);

    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), sessionId = randomUUID(), contractId = randomUUID();
    const leaseId = randomUUID(), providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    const issue = { id: issueId, companyId, identifier: "CF-1", title: "Edit the file",
      description: null, workMode: "standard", assigneeAgentId: agentId, status: "in_progress",
      executionRunId: runId, checkoutRunId: null };
    const execution = buildNativeExecutionInput({
      companyId, agentId, runId, issue, taskPrompt: "Edit the file",
      workspace: { id: workspaceId, cwd: host, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: sessionId, provider: "codex",
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
      completionContract: { id: contractId, sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1",
          objective: "Edit the file", criteria: [{ id: "edit", requirement: "Edit the file" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    await db.insert(companies).values({ id: companyId, name: "Cancel finalize", defaultResponsibleUserId: "board",
      issuePrefix: `C${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "running", adapterConfig: { provider: "codex", model: null }, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Edit the file", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, issueId, runtimeMode: "native",
      status: "running", startedAt: new Date(), contextSnapshot: { issueId }, nativeSessionId: sessionId, nextEventSeq: 2,
      runnerProfileJson: { nativeExecutionInput: execution, nativeResourceDisposition: "keep_running" } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, provider: "daytona", providerLeaseId,
      status: "active", leasePolicy: "reuse_by_environment", metadata: {} });
    // The turn started on the box (not a pre-launch cancellation).
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "turn.started", stream: "system" });
    const [leaseRow] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));

    const runnerState: BoxState = { fail: false, calls: 0 };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "test", leaseId, remoteCwd: box,
      runner: boxRunner(runnerState), timeoutMs: 30_000,
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId },
    };
    const sync = (await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: host,
      target, lease: leaseRow as unknown as EnvironmentLease, resourceDisposition: "keep_running" }))!;
    expect(sync.mode).toBe("host_current");
    expect(await readFile(join(box, "task.txt"), "utf8")).toBe(BASE);

    const stop = new nativeExecutor.NativeCancellationPendingRecoveryError();
    let callsAtStop = 0;
    vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementationOnce(async () => {
      // The agent's own tool edits the task workspace on the box, mid-turn.
      if (variant.edit) await writeFile(join(box, "task.txt"), EDIT);
      // U: a clean acknowledged Stop settles the coordinator; stop_and_retain
      // never writes the warm-HANDOFF retained idle receipt.
      const stoppedAt = new Date();
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: stoppedAt,
        resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
          executionCancellation: { state: "acknowledged" },
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
            reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } },
        runnerProfileJson: { ...current.runnerProfileJson },
      }).where(eq(heartbeatRuns.id, runId));
      if (variant.settled) await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId,
        phase: "terminal_failure", failureCode: "native_retry_cancelled" });
      runnerState.fail = variant.exportFails;
      callsAtStop = runnerState.calls;
      throw stop;
    });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const resolution = resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true,
      runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null } as never);
    expect(resolution.kind).toBe("native");
    const executionControl = createAdapterExecutionControl();
    const noop = async () => {};
    const executionInput = {
      run, agent, options: {},
      task: { issueRef: issue, issueContext: null, context: {}, issueId, taskKey: null, executionContinuation: null },
      runtime: { nativeRuntimeResolution: resolution, nativeExecution: execution, nativeRunnerInstanceId: "cf-runner",
        adapter: {}, runtimeForAdapter: {}, getNativeFreshSessionHandoff: undefined, getFreshSessionHandoff: undefined,
        toolRefreshOnResume: false, runOptions: {} },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { ...execution.workspace },
        executionTarget: target, nativeWorkspaceSync: sync, workspaceOperationRecorder: {}, remoteExecution: null },
      config: { runtimeConfig: {}, resolvedConfig: {}, configuredTaskEnvironment: {}, adapterEnv: {},
        runtimeEnv: {}, useHostGitHub: false, githubSelection: { configured: false } },
      session: { runtimeSessionParamsForAdapter: null, configuredModel: null, sessionConfigMetadata: null,
        goalCheckpointSession: { current: null } },
      instructions: { instructionCopy: null, nativeInstructionWorkingCopy: () => undefined,
        collectStoppedInstructions: noop, releaseInstructionCopy: noop, nativeInstructionReservation: null },
      trace: { providerTraceCapture: null, nativeRunnerPreparationSpans: [], attestedQuestionResponseAtMs: null,
        attemptStartedAtMs: Date.now(), environmentAcquireStartedAtMs: Date.now(), environmentRealizeEndedAtMs: Date.now() },
      control: { executionControl, executionPhaseContext: { onExecutionPhase: executionControl.phases.enter },
        dispatchResolvedInteractionContinuationWithAtomicGate: async (dispatch: (mark: () => void) => Promise<unknown>) =>
          ({ dispatched: true, resultPromise: dispatch(() => {}) }) },
      output: { identityRedactor: createAgentIdentityRedactor(), appendIdentityRedactedLog: noop,
        onLog: noop, onAdapterEvent: noop, onAdapterMeta: noop },
      services: {}, effects: { onUsageCaptureReady: () => {}, onNativeDispatchStarted: () => {},
        onNativeSessionResumeScheduled: () => {} },
    } as unknown as HeartbeatRuntimeExecutionInput;
    await expect(executeHeartbeatRuntime(db, executionInput)).rejects.toBe(stop);
    executionControl.finish();

    // U: teardown releases stop_and_retain after the export, with the provider's
    // bound stop receipt. No handed-off lease or retained idle checkpoint exists.
    const [active] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...active.metadata, remoteExecutionTermination: remoteTerminationReceipt(active,
        { providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, leaseId));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const reference = readNativeWorkspaceSyncReference(stopped.runnerProfileJson?.nativeWorkspaceSync);
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, nativeIssueId: issueId, issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(stopped.runnerProfileJson?.nativeRetainedIdleCheckpoint).toBeUndefined();
    expect(retained).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect(hasRemoteTerminationReceipt(retained)).toBe(true);
    const excluded = await nativeWorkspaceExportPendingForResource(db, retained, successorRunId);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId)));
    return { root, host, box, companyId, workspaceId, leaseId, providerLeaseId, runnerState, callsAtStop, stopped,
      reference, excluded, successorRunId, retained, events, runId, stoppedRunProfile: stopped.runnerProfileJson,
      sync, agentId, issueId, sessionId };
  }

  async function successorOnSameBox(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    // The reuse filter passed: acquisition resumes the same provider box on the same lease.
    await db.update(environmentLeases).set({ heartbeatRunId: f.successorRunId, status: "active" })
      .where(eq(environmentLeases.id, f.leaseId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const successor = (await prepareNativeWorkspaceSync({ db, runId: f.successorRunId, companyId: f.companyId,
      workspaceId: f.workspaceId, workspaceLocalDir: f.host, lease: lease as unknown as EnvironmentLease,
      target: { kind: "remote", transport: "sandbox", providerKey: "test", leaseId: f.leaseId, remoteCwd: f.box,
        runner: boxRunner({ fail: false, calls: 0 }), timeoutMs: 30_000,
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: f.providerLeaseId } } }))!;
    try { return successor.mode; } finally { await successor.cleanup(); }
  }

  // ---- pl/cancel-finalize2: rf-4's three findings ----
  /** Settles a Stop that executeHeartbeatRuntime saw unsettled, so the bounded export can be driven directly. */
  async function settleLater(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", failureCode: "native_retry_cancelled" });
  }


  // rf-4 cf5ka fragment: replaced in place under the binding drain ruling.
  // The original held calls and never-OK final bytes remain; only admission order changes.
  it.each([
    ['parent-mkdir', 'deadline'], ['publish-rename', 'deadline'],
    ['parent-mkdir', 'lock-session-kill'], ['publish-rename', 'lock-session-kill'],
  ] as const)('(superseded by replacement: next owner waits for the drain, RFL record SUPERSEDE-U-DRAIN-ADMISSION-1117) INDEPENDENT regular-file %s held past deadline cannot overwrite next owner (%s)', async (branch, cause) => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    await assertDrainAdmissionReplacement({ db, connectionString: database.connectionString, f, branch, cause });
  }, 60_000);

  // ---- adopt-drain: the same never-OK assertion under the drain contract ----
  type HeldBranch = 'parent-mkdir' | 'publish-rename' | 'symlink-parent-mkdir';
  /** Holds ONE host fs call of the old owner's restore (after its signal check,
   * before the syscall runs), as the rf-4 fragment does. */
  async function holdOneHostCall(f: Awaited<ReturnType<typeof stopMidTurn>>, branch: HeldBranch) {
    if (branch === 'symlink-parent-mkdir') {
      await auditFs.rm(join(f.box, 'task.txt'));
      await auditFs.symlink('zzz-stopped-target', join(f.box, 'task.txt'));
      await auditFs.writeFile(join(f.box, 'zzz-stopped-target'), EDIT);
    }
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { arrived = r; });
    const originalMkdir = auditFs.mkdir.bind(auditFs);
    const originalRename = auditFs.rename.bind(auditFs);
    const spy = branch !== 'publish-rename'
      ? vi.spyOn(auditFs, 'mkdir').mockImplementation(async (...args: Parameters<typeof auditFs.mkdir>) => {
          if (String(args[0]) === f.host) { arrived(); await held; }
          return originalMkdir(...args);
        })
      : vi.spyOn(auditFs, 'rename').mockImplementation(async (...args: Parameters<typeof auditFs.rename>) => {
          if (String(args[1]) === join(f.host, 'task.txt')) { arrived(); await held; }
          return originalRename(...args);
        });
    const exportBox: { promise?: Promise<void> } = {};
    const originalRestore = f.sync.restoreWorkspace.bind(f.sync);
    vi.spyOn(f.sync, 'restoreWorkspace').mockImplementation((...args) => (exportBox.promise = originalRestore(...args)));
    return { release, reached, spy, exportBox };
  }
  const nextOwnerWrites = (f: Awaited<ReturnType<typeof stopMidTurn>>) =>
    withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId }, async () => {
      await auditFs.writeFile(join(f.host, 'task.txt'), 'NEXT OWNER');
      return 'next owner wrote';
    });
  async function admitNextOwner(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    const attempts: unknown[] = [];
    for (let i = 0; i < 100; i += 1) {
      const next = await nextOwnerWrites(f);
      attempts.push(next.acquired ? 'acquired' : next.reason);
      if (next.acquired) return { next, attempts };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('next owner never admitted: ' + JSON.stringify(attempts.slice(-3)));
  }
  const readHostTask = async (f: Awaited<ReturnType<typeof stopMidTurn>>) => {
    const entry = await auditFs.lstat(join(f.host, 'task.txt'));
    return entry.isSymbolicLink() ? `SYMLINK:${await auditFs.readlink(join(f.host, 'task.txt'))}` : await auditFs.readFile(join(f.host, 'task.txt'), 'utf8');
  };

  it.each(['parent-mkdir', 'publish-rename', 'symlink-parent-mkdir'] as const)('DRAIN %s held past the deadline: the next owner is not admitted until the call returns, then its file survives', async (branch) => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    const h = await holdOneHostCall(f, branch);
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      await Promise.race([h.reached, new Promise((_, reject) => setTimeout(() => reject(new Error('never reached ' + branch)), 15_000))]);
      expect(await work).toEqual({ outcome: 'unproven', reason: 'timed_out' });
      // The old owner's host call is still in flight: ownership is NOT released.
      const whileHeld = await nextOwnerWrites(f);
      expect(whileHeld).toEqual({ acquired: false, reason: 'owner_active' });
      expect(await readHostTask(f)).not.toBe('NEXT OWNER');
      h.release();
      const error = await h.exportBox.promise!.then(() => null, error => String(error));
      const { next, attempts } = await admitNextOwner(f);
      expect(next).toMatchObject({ acquired: true });
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const actual = await readHostTask(f);
      const proof = { branch, whileHeld, attempts, next, error, actual };
      console.log('DRAIN_INDEPENDENT', JSON.stringify(proof));
      await writeFile(join(process.env.TASK_OUT!, `drain-${branch}-result.json`), JSON.stringify(proof, null, 2));
      expect(actual).toBe('NEXT OWNER');
      // The box is kept: the descriptor stays prepared, the box stays a protected export source.
      expect(await readFile(join(f.box, 'task.txt'), 'utf8').catch(() => 'SYMLINK')).not.toBe('NEXT OWNER');
    } finally {
      h.release(); await work; await h.exportBox.promise?.catch(() => undefined); h.spy.mockRestore();
    }
  }, 45_000);

  it('BOUND: a host fs call stuck past the drain cap: the true line, the box kept, the next owner not admitted until it returns, then admitted once', async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    const h = await holdOneHostCall(f, 'publish-rename');
    const started = Date.now();
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      await Promise.race([h.reached, new Promise((_, reject) => setTimeout(() => reject(new Error('never reached')), 15_000))]);
      expect(await work).toEqual({ outcome: 'unproven', reason: 'timed_out' });
      // Wait past the 10 s drain cap for the person's line.
      const lineAt = await (async () => {
        for (;;) {
          const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
          const notice = rows.find(row => (row.payload as { prpEvent?: { payload?: { category?: string } } } | null)
            ?.prpEvent?.payload?.category === 'workspace_host_write_draining');
          if (notice) return { ms: Date.now() - started, message: notice.message, level: notice.level, eventType: notice.eventType };
          if (Date.now() - started > 25_000) throw new Error('no drain-cap line');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      })();
      expect(lineAt.message).toContain('has not finished after 10 s');
      expect(lineAt.ms).toBeGreaterThanOrEqual(3_000 + 10_000 - 500);
      // Past the cap: still not admitted, nothing written by a next owner.
      const pastCap = await nextOwnerWrites(f);
      expect(pastCap).toEqual({ acquired: false, reason: 'owner_active' });
      // The box is kept: the stopped turn's descriptor stays prepared and the box a protected export source.
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync)).toMatchObject({ state: 'prepared' });
      expect(await nativeWorkspaceExportPendingForResource(db, f.retained, f.successorRunId)).toBe(true);
      expect(await readFile(join(f.box, 'task.txt'), 'utf8')).toBe(EDIT);
      h.release();
      await h.exportBox.promise!.catch(() => undefined);
      const { next, attempts } = await admitNextOwner(f);
      expect(attempts.filter(a => a === 'acquired')).toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const actual = await readHostTask(f);
      const proof = { lineAt, pastCap, attempts, next, actual };
      console.log('DRAIN_BOUND', JSON.stringify(proof));
      await writeFile(join(process.env.TASK_OUT!, 'drain-bound-result.json'), JSON.stringify(proof, null, 2));
      expect(actual).toBe('NEXT OWNER');
    } finally {
      h.release(); await work; await h.exportBox.promise?.catch(() => undefined); h.spy.mockRestore();
    }
  }, 60_000);

  /** pl/lockloss: the finalization lock session's idle_in_transaction_session_timeout, for new sessions only. */
  async function withLockSessionIdleTimeout<T>(value: string, body: () => Promise<T>): Promise<T> {
    const [{ name }] = await db.execute(sql`select current_database() as name`) as unknown as Array<{ name: string }>;
    await db.execute(sql.raw(`alter database "${name}" set idle_in_transaction_session_timeout = '${value}'`));
    try { return await body(); }
    finally { await db.execute(sql.raw(`alter database "${name}" reset idle_in_transaction_session_timeout`)); }
  }

  it('LOCKLOSS: the lock session is killed mid-restore with a delayed rename: the next owner is not admitted until the rename returns; its file survives', async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    const h = await holdOneHostCall(f, 'publish-rename');
    await withLockSessionIdleTimeout('3s', async () => {
      const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
        nativeWorkspaceSync: f.sync, timeoutMs: 30_000 });
      work.catch(() => undefined);
      try {
        await Promise.race([h.reached, new Promise((_, reject) => setTimeout(() => reject(new Error('never reached')), 15_000))]);
        const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
          and pid <> pg_backend_pid()`) as unknown as Array<{ pid: number }>;
        expect(lockers).toHaveLength(1);
        await db.execute(sql`select pg_terminate_backend(${lockers[0].pid})`);
        // Let the keepalive see the dead session.
        await new Promise(resolve => setTimeout(resolve, 2_500));
        const lockFree = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
          and pid <> pg_backend_pid()`) as unknown as Array<{ n: number }>;
        // The physical lock is gone, but the old owner's host call is in flight: not admitted.
        const whileHeld = await nextOwnerWrites(f);
        expect(whileHeld).toMatchObject({ acquired: false });
        h.release();
        const error = await h.exportBox.promise!.then(() => null, error => String(error));
        const outcome = await work;
        const { next, attempts } = await admitNextOwner(f);
        await new Promise(resolve => setTimeout(resolve, 1_500));
        const actual = await readHostTask(f);
        const proof = { lockersAfterKill: lockFree[0]?.n, whileHeld, error, outcome, attempts, next, actual };
        console.log('DRAIN_LOCKLOSS', JSON.stringify(proof));
        await writeFile(join(process.env.TASK_OUT!, 'drain-lockloss-result.json'), JSON.stringify(proof, null, 2));
        expect(outcome).toEqual({ outcome: 'unproven', reason: 'ownership_lost' });
        expect(actual).toBe('NEXT OWNER');
      } finally {
        h.release(); await work.catch(() => undefined); await h.exportBox.promise?.catch(() => undefined); h.spy.mockRestore();
      }
    });
  }, 60_000);
});
