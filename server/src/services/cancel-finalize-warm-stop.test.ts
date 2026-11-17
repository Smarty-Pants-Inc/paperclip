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
 * person's Stop settling as NSE does (acknowledged Stop + retained idle receipt),
 * plus the unrelated MCP / wake / usage boundaries (as warm-rebind-recovery-policy.test.ts).
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues,
} from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { captureDirectorySnapshot, directorySnapshotSha256, withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAdapterExecutionControl } from "./adapter-execution-control.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./heartbeat/runtime-execution.js";
import { finishCancelledWarmWorkspaceExport } from "./heartbeat/cancelled-warm-workspace-export.js";
import { registerCleanupSettledResumer, resetCleanupSettledWakesForTest, wakeAfterCleanupSettled } from "./native-runtime/cleanup-settled-wake.js";
import { issueRecoveryActions, nativeRunFinalizations } from "@paperclipai/db";
import { recoveryService } from "./recovery/service.js";
import { runExecutionsStoppedOrHandedOffWarm } from "./agent-execution-stop.js";
import { environmentService } from "./environments.js";
import { handedOffWarmLeaseSettled } from "./native-runtime/handed-off-warm-lease.js";
import { tryLockNativeWorkspaceFinalization, withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
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
(support.supported ? describe : describe.skip)("pl/cancel-finalize: mid-turn Stop of a warm turn keeps its box", () => {
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

  type Variant = { edit: boolean; settled: boolean; exportFails: boolean;
    /** r4 WORK (live e9608e9c): NSE's settle of the person's Stop on the coordinator. "settled" =
     * terminal_failure/native_retry_cancelled, no lease owner, no result (NSE :14280-14290), written
     * whether the warm session was retained or CLOSED; "owned" = a coordinator still owned (not settled). */
    coordinator?: "settled" | "owned";
    /** pl/r4-work3 (a): NSE's record of the CLOSED session's close for this Stop
     * (native-session-executor.ts releaseWarmNativeSession onStoppedSessionClose):
     * "clean" = closeWarmNativeSession did not throw (the Pi transport ladder completed;
     * on the Boat path the Runner's suspension receipt was accepted); "threw" = the close
     * threw (swallowed by the release, recorded here). Absent = no record at all. */
    closeProof?: "clean" | "threw";
    /** The live row's executionCancellation state at the boundary (default acknowledged). */
    executionCancellationState?: string };
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
    // The lease carries the run's task issue, as the warm acquisition writes it
    // (environment-runtime.ts acquireLease issueId: input.issueId).
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId, provider: "daytona", providerLeaseId,
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
      // The person's Stop, acknowledged; NSE settles it (retained idle receipt) only after a clean cancellation.
      const stoppedAt = new Date();
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: stoppedAt,
        resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
          executionCancellation: variant.executionCancellationState === "requested"
            ? { state: "requested", requestedAt: stoppedAt.toISOString() } : { state: "acknowledged" },
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
            reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } },
        runnerProfileJson: { ...current.runnerProfileJson,
          ...(variant.settled ? { nativeRetainedIdleCheckpoint: { schema: "paperclip.native-retained-idle-checkpoint.v1",
            companyId, issueId, runId, sessionId, bootId: "boot", generation: 1 } } : {}),
          ...(variant.closeProof ? { nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1",
            companyId, issueId, runId, sessionId, clean: variant.closeProof === "clean",
            ...(variant.closeProof === "threw" ? { failure: "Pi RPC process did not exit after bounded shutdown escalation" } : {}),
            at: stoppedAt.toISOString() } } : {}) },
      }).where(eq(heartbeatRuns.id, runId));
      if (variant.coordinator) await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId,
        phase: variant.coordinator === "settled" ? "terminal_failure" : "observed",
        failureCode: variant.coordinator === "settled" ? "native_retry_cancelled" : null,
        leaseOwner: variant.coordinator === "settled" ? null : "live-owner",
        controllerBootId: "boot", controllerGeneration: 1 });
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

    // Heartbeat teardown hands the warm box off (environment-runtime records it retained).
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, leaseId));
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const reference = readNativeWorkspaceSyncReference(stopped.runnerProfileJson?.nativeWorkspaceSync);
    const successorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, nativeIssueId: issueId, issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
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

  it.each([
    ["remote-only edit", true],
    ["no edit", false],
  ] as const)("%s: the settled Stop finishes the export; the successor adopts the SAME box", async (_label, edit) => {
    const f = await stopMidTurn({ edit, settled: true, exportFails: false });
    const expected = edit ? EDIT : BASE;
    // Base: { state: "prepared", successorExcludesBox: true } -> new box, host_current, new provider thread.
    expect({ state: f.reference?.state, successorExcludesBox: f.excluded }).toEqual({ state: "finalized", successorExcludesBox: false });
    expect(f.reference).toMatchObject({ leaseId: f.leaseId, providerLeaseId: f.providerLeaseId });
    // finalHostSha256 is the host tree that now holds the stopped turn's edit.
    const { descriptor } = await nativeWorkspaceSyncInternals.readDescriptor({ runId: f.runId, reference: f.reference! });
    const hostTree = await captureDirectorySnapshot(f.host, { exclude: descriptor.baseline.exclude, diskBacked: true });
    expect(f.reference?.finalHostSha256).toBe(directorySnapshotSha256(hostTree));
    if (edit) expect(f.reference?.finalHostSha256).not.toBe(descriptor.baselineSha256);
    else expect(f.reference?.finalHostSha256).toBe(descriptor.baselineSha256);
    // The edit is both on the box and exported to the host, sha-equal.
    expect(sha(await readFile(join(f.box, "task.txt"), "utf8"))).toBe(sha(expected));
    expect(sha(await readFile(join(f.host, "task.txt"), "utf8"))).toBe(sha(expected));
    expect(f.stopped.status).toBe("cancelled");
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toMatchObject({ state: "finalized" });
    // The unchanged reuse filter now passes for the successor.
    expect(f.excluded).toBe(false);
    expect(await successorOnSameBox(f)).toBe("adopt_remote");
    expect(sha(await readFile(join(f.box, "task.txt"), "utf8"))).toBe(sha(expected));
  }, 60_000);

  it("S048 (ii): the finalized export WAKES the parked message by that event, once, after the mark committed", async () => {
    resetCleanupSettledWakesForTest();
    const wakes: { runId: string; markCommitted: boolean; at: number }[] = [];
    let readDb: ReturnType<typeof createDb> | null = db;
    const unregister = registerCleanupSettledResumer(async ({ runId }) => {
      const [row] = await readDb!.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      wakes.push({ runId, markCommitted: (row?.profile as Record<string, any> | null)?.nativeCancelledWarmExport?.state === "finalized", at: Date.now() });
    });
    try {
      const f = await stopMidTurn({ edit: true, settled: true, exportFails: false });
      const own = wakes.filter(wake => wake.runId === f.runId);
      // Base: no wake at all (the message waits for the 30 s re-poll).
      expect(own.length).toBe(1);
      expect(own[0]!.markCommitted).toBe(true);
      // R-ONCE: the same event again is a no-op.
      expect(await wakeAfterCleanupSettled({ companyId: f.companyId, runId: f.runId, event: "export_finalized" })).toBe(false);
      expect(wakes.filter(wake => wake.runId === f.runId).length).toBe(1);
    } finally { unregister(); readDb = null; }
  }, 60_000);

  it("S048 (ii) negative: an UNPROVEN export wakes nothing (the cleanup is still pending)", async () => {
    resetCleanupSettledWakesForTest();
    const woken: string[] = [];
    const unregister = registerCleanupSettledResumer(async ({ runId }) => { woken.push(runId); });
    try {
      const f = await stopMidTurn({ edit: true, settled: true, exportFails: true });
      expect(woken.filter(id => id === f.runId)).toEqual([]);
    } finally { unregister(); }
  }, 60_000);

  it("export failure: no silent new box; the box stays protected and the run says so", async () => {
    const f = await stopMidTurn({ edit: true, settled: true, exportFails: true });
    expect(f.reference).toMatchObject({ state: "prepared", finalHostSha256: null });
    expect(f.excluded).toBe(true);
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    expect(await readFile(join(f.box, "task.txt"), "utf8")).toBe(EDIT);
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toMatchObject({ state: "unproven", reason: "export_failed" });
    expect(f.events.find(event => event.eventType === "workspace_export_deferred")).toMatchObject({ level: "warn",
      message: expect.stringContaining("The box is kept, so nothing on it is lost.") });
  }, 60_000);

  it("a Stop whose cancellation is NOT settled runs no export", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    expect(f.runnerState.calls).toBe(f.callsAtStop);
    expect(f.reference).toMatchObject({ state: "prepared", finalHostSha256: null });
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toBeUndefined();
    expect(f.events.filter(event => event.eventType.startsWith("workspace_export_"))).toEqual([]);
    expect(f.excluded).toBe(true);
  }, 60_000);

  // ---- pl/r4-work: the live r4 row (run e9608e9c, box bx_jn26j28b -> successor dfd8e50c on spare bx_c9vw2pju) ----
  /** The acquisition reuse filter (environment-runtime.ts:2113-2117) over the stopped run's box and a
   * pre-warmed spare reusable lease of the same agent/issue: which boxes the +0 successor may take. */
  async function boxRelationship(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    const spareLeaseId = randomUUID(), spareProviderLeaseId = `bx_spare${randomUUID().slice(0, 4)}`;
    await db.insert(environmentLeases).values({ id: spareLeaseId, companyId: f.companyId, issueId: f.issueId,
      provider: "daytona", providerLeaseId: spareProviderLeaseId, status: "retained", cleanupStatus: "success",
      leasePolicy: "reuse_by_environment", metadata: {} });
    const candidates = await db.select().from(environmentLeases)
      .where(sql`${environmentLeases.id} in (${f.leaseId}, ${spareLeaseId})`);
    const kept: string[] = [];
    for (const lease of candidates) {
      if (!await nativeWorkspaceExportPendingForResource(db, lease, f.successorRunId)) kept.push(lease.providerLeaseId!);
    }
    return { kept, relationship: kept.includes(f.providerLeaseId) ? "SAME" : "NEW", spareProviderLeaseId };
  }

  function liveFields(f: Awaited<ReturnType<typeof stopMidTurn>>, relationship: string) {
    const result = f.stopped.resultJson as Record<string, any>;
    const profile = f.stoppedRunProfile as Record<string, any>;
    return { status: f.stopped.status, errorCode: f.stopped.errorCode,
      executionCancellationState: result?.executionCancellation?.state,
      nativeRetainedIdleCheckpoint: profile?.nativeRetainedIdleCheckpoint ?? "ABSENT",
      nativeCancelledWarmExport: profile?.nativeCancelledWarmExport?.state ?? "ABSENT",
      nativeWorkspaceSyncState: f.reference?.state, boxRelationship: relationship };
  }

  it("r4 WORK RED: a person's Stop whose warm Pi session was CLOSED (no retained-idle receipt) but settled by NSE on the coordinator: the bounded export finalizes and the +0 successor keeps the SAME box (not the pre-warmed spare), edit sha-equal", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false, coordinator: "settled",
      executionCancellationState: "requested", closeProof: "clean" });
    const boxes = await boxRelationship(f);
    const fields = liveFields(f, boxes.relationship);
    // eslint-disable-next-line no-console
    console.log(`R4WORK_FIELDS ${JSON.stringify(fields)}`);
    // Live r4 (MATCH at base): cancelled / cancelled / requested / ABSENT / ABSENT / prepared / NEW.
    expect(fields).toEqual({ status: "cancelled", errorCode: "cancelled", executionCancellationState: "requested",
      nativeRetainedIdleCheckpoint: "ABSENT", nativeCancelledWarmExport: "finalized",
      nativeWorkspaceSyncState: "finalized", boxRelationship: "SAME" });
    // No stop writer (person's Stop teardown, 22f's proof-error intent, the warm-expiry sweep, the settle
    // predicate's reuse filter) meets an unexported turn on this box any more.
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(await nativeWorkspaceExportPendingForResource(db, lease, null)).toBe(false);
    expect(sha(await readFile(join(f.host, "task.txt"), "utf8"))).toBe(sha(EDIT));
    expect(await successorOnSameBox(f)).toBe("adopt_remote");
    expect(sha(await readFile(join(f.box, "task.txt"), "utf8"))).toBe(sha(EDIT));
  }, 60_000);

  it("r4 WORK guard: a coordinator still OWNED (the Stop is not settled) runs no export, as before", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false, coordinator: "owned",
      executionCancellationState: "requested" });
    expect(f.runnerState.calls).toBe(f.callsAtStop);
    expect(f.reference).toMatchObject({ state: "prepared", finalHostSha256: null });
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toBeUndefined();
    expect(f.excluded).toBe(true);
  }, 60_000);

  // ---- pl/r4-work3 (a) rf-3: in the CLOSED case the export runs only on a clean-close proof ----
  const TOOLS_NOT_PROVEN_LINE = "Stopped, but the box's tools could not be proven stopped, so the workspace was not copied back. The box is kept.";
  it.each([
    ["the close THREW (recorded unclean)", "threw"],
    ["no close record at all", undefined],
  ] as const)("r4work3 (a) RED: closed case, %s: no export, 'prepared' kept, the true line, the box stays protected", async (_label, closeProof) => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false, coordinator: "settled",
      executionCancellationState: "requested", closeProof });
    // Not one box command after the Stop: nothing copied while a stopped tool may still write.
    expect(f.runnerState.calls).toBe(f.callsAtStop);
    expect(f.reference).toMatchObject({ state: "prepared", finalHostSha256: null });
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    expect(await readFile(join(f.box, "task.txt"), "utf8")).toBe(EDIT);
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toMatchObject({ state: "unproven", reason: "tools_not_proven_stopped" });
    const deferred = f.events.filter(event => event.eventType === "workspace_export_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ level: "warn", message: TOOLS_NOT_PROVEN_LINE });
    expect(f.events.filter(event => event.eventType === "provider.notice.recorded").map(event => event.message))
      .toEqual([TOOLS_NOT_PROVEN_LINE]);
    expect(f.events.filter(event => event.eventType === "workspace_export_finalized")).toEqual([]);
    // The box stays a protected export source (reuse filter), and the lease is untouched (not stopped/archived).
    expect(f.excluded).toBe(true);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(lease.status).toBe("retained");
  }, 60_000);

  it("r4work3 (a) guard: the RETAINED branch (idle receipt) exports with no close record, as before", async () => {
    const f = await stopMidTurn({ edit: true, settled: true, exportFails: false, coordinator: "settled" });
    expect(f.stoppedRunProfile?.nativeStoppedSessionClose).toBeUndefined();
    expect(f.reference?.state).toBe("finalized");
    expect(f.excluded).toBe(false);
  }, 60_000);

  // ---- pl/cancel-finalize2: rf-4's three findings ----
  /** Settles a Stop that executeHeartbeatRuntime saw unsettled, so the bounded export can be driven directly. */
  async function settleLater(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson,
      nativeRetainedIdleCheckpoint: { schema: "paperclip.native-retained-idle-checkpoint.v1",
        companyId: f.companyId, issueId: f.issueId, runId: f.runId, sessionId: f.sessionId, bootId: "boot", generation: 1 } },
    }).where(eq(heartbeatRuns.id, f.runId));
  }

  it("aggregate bound + late stamp: a stamp write held past the deadline publishes nothing; the lock is free at the deadline", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    f.runnerState.gate = { match: script => script.includes("workspace-sync-v1.json.tmp") && script.includes("base64 -d"),
      until: new Promise<void>(resolve => { release = resolve; }) };
    const timeoutMs = 3_000;
    const startedAt = Date.now();
    const outcome = await finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs });
    const waitedMs = Date.now() - startedAt;
    expect(outcome).toEqual({ outcome: "unproven", reason: "timed_out" });
    expect(f.runnerState.held).toBe(1);
    expect(waitedMs).toBeLessThan(timeoutMs + 2_000);
    // (1) The finalization lock session is released at the deadline, while the remote command is still held.
    const probe = await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
      async () => "free");
    expect(probe).toMatchObject({ acquired: true });
    // (2) The held command joins after the timeout: it writes nothing visible.
    release();
    await waitFor(() => f.runnerState.inflight === 0);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    await waitFor(() => f.runnerState.inflight === 0);
    await expect(stat(join(f.box, ...STAMP))).rejects.toMatchObject({ code: "ENOENT" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync))
      .toMatchObject({ state: "prepared", finalHostSha256: null });
    expect(run.runnerProfileJson?.nativeCancelledWarmExport).toMatchObject({ state: "unproven", reason: "timed_out" });
    expect(run.status).toBe("cancelled");
  }, 60_000);

  it("the honest line: the rows the helper writes are exactly the fixture the real transcript consumer renders as ONE entry", async () => {
    const f = await stopMidTurn({ edit: true, settled: true, exportFails: true });
    const fixture = JSON.parse(await readFile(DEFERRED_FIXTURE, "utf8")) as { run: { id: string }; events: Array<Record<string, any>> };
    // Normalized: the run id and the clock are the only per-run values.
    const normalize = (row: Record<string, any>, runId: string) => {
      const payload = JSON.parse(JSON.stringify(row.payload ?? null).replaceAll(runId, "RUN"));
      if (payload?.prpEvent) payload.prpEvent.emittedAt = "AT";
      if (typeof payload?.detail === "string") payload.detail = "DETAIL";
      return { eventType: row.eventType, stream: row.stream, level: row.level, message: row.message, payload };
    };
    const written = f.events.filter(event => event.seq > 1).sort((a, b) => a.seq - b.seq)
      .filter(event => event.eventType === "workspace_export_deferred" || event.eventType === "provider.notice.recorded");
    expect(written.map(row => normalize(row, f.runId)))
      .toEqual(fixture.events.map(row => normalize(row, fixture.run.id)));
    // ui/src/components/transcript/native-run-events.test.ts feeds the fixture to nativeRunEventsToTranscript.
  }, 60_000);
  // ---- pl/cancel-finalize3: rf-4's 01:24Z findings ----
  /** A finalized stamp that a late `mv` published on the box after the deadline, for a run whose DB descriptor is still prepared. */
  async function lateStampOnBox(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    const { descriptor } = await nativeWorkspaceSyncInternals.readDescriptor({ runId: f.runId, reference: f.reference! });
    const hostTree = await captureDirectorySnapshot(f.host, { exclude: descriptor.baseline.exclude, diskBacked: true });
    const hostSha256 = directorySnapshotSha256(hostTree);
    const stamp = (finalizedRunId: string) => ({ schema: "paperclip.native-workspace-stamp/v1", workspaceId: f.workspaceId,
      providerLeaseId: f.providerLeaseId, remoteCwd: f.box, hostSha256, finalizedRunId });
    await mkdir(join(f.box, ...STAMP.slice(0, -1)), { recursive: true });
    await writeFile(join(f.box, ...STAMP), `${JSON.stringify(stamp(f.runId))}\n`);
    // The lease's last DB-recorded stamp (an earlier finalized run, same host tree).
    await db.update(environmentLeases).set({ metadata: { nativeWorkspaceSync: stamp(randomUUID()) } })
      .where(eq(environmentLeases.id, f.leaseId));
  }

  it("(1) a late remote stamp + a prepared descriptor: the box is not adopted as finalized", async () => {
    const f = await stopMidTurn({ edit: false, settled: false, exportFails: false });
    expect(f.reference).toMatchObject({ state: "prepared", finalHostSha256: null });
    await lateStampOnBox(f);
    // Reader 1, the reuse filter (DB only): the prepared descriptor keeps the box a protected export source.
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(await nativeWorkspaceExportPendingForResource(db, lease, f.successorRunId)).toBe(true);
    // Reader 2, warm adoption (native-workspace-sync.ts remoteStampMatches): the box stamp is trusted only when it
    // equals the lease's DB stamp, which is written only with a finalized descriptor. The late stamp is not adopted.
    expect(await successorOnSameBox(f)).not.toBe("adopt_remote");
  }, 60_000);

  it("(1) a late remote stamp + a prepared descriptor: recovery still runs the export (not skipped)", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await lateStampOnBox(f);
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    // Reader 3, resume (native-workspace-sync.ts resumeNativeWorkspaceSync): only a FINALIZED DB descriptor reads the box stamp.
    expect(await resumeNativeWorkspaceSync({ db, runId: f.runId,
      target: { kind: "remote", transport: "sandbox", providerKey: "test", leaseId: f.leaseId, remoteCwd: f.box,
        runner: boxRunner({ fail: false, calls: 0 }), timeoutMs: 30_000,
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: f.providerLeaseId } } })).toBe(true);
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(EDIT);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync)).toMatchObject({ state: "finalized" });
  }, 60_000);

  it("(3) an export abandoned at the deadline writes nothing to the HOST after the lock is released", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    // Hold the copyback's first remote command (the box export) past the deadline.
    f.runnerState.gate = { match: () => true, until: new Promise<void>(resolve => { release = resolve; }) };
    const outcome = await finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs: 2_000 });
    expect(outcome).toEqual({ outcome: "unproven", reason: "timed_out" });
    expect(f.runnerState.held).toBeGreaterThanOrEqual(1);
    // The lock is free; a second owner takes it and writes the host workspace.
    const second = await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
      async () => { await writeFile(join(f.host, "next.txt"), "the next owner's write\n"); return "wrote"; });
    expect(second).toMatchObject({ acquired: true });
    f.runnerState.gate = null;
    release();
    await waitFor(() => f.runnerState.inflight === 0);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await waitFor(() => f.runnerState.inflight === 0);
    // The abandoned export wrote nothing to the host afterwards: the next owner's write stands, the box edit was not merged.
    expect(await readFile(join(f.host, "next.txt"), "utf8")).toBe("the next owner's write\n");
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    await expect(stat(join(f.box, ...STAMP))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  // ---- adopt-h6-xred3: H6's Stop-pending card x cancel-finalize's held export (rf-3 19:10Z) ----
  async function xredHeldExport(timeoutMs: number) {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    // The settled coordinator the receipt is bound to (retainCancelledSession's one transaction).
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", failureCode: "native_retry_cancelled", controllerBootId: "boot", controllerGeneration: 1 });
    // The box is NOT yet handed off: the release runs after the cancellation boundary returns.
    await db.update(environmentLeases).set({ status: "active", cleanupStatus: null }).where(eq(environmentLeases.id, f.leaseId));
    await db.update(issues).set({ checkoutRunId: f.runId, executionRunId: f.runId, executionLockedAt: new Date(),
      conversationAgentId: f.agentId, conversationUserId: "board", conversationState: "active" }).where(eq(issues.id, f.issueId));
    let release!: () => void;
    f.runnerState.gate = { match: script => script.includes("workspace-sync-v1.json.tmp") && script.includes("base64 -d"),
      until: new Promise<void>(resolve => { release = resolve; }) };
    const exported = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId, nativeWorkspaceSync: f.sync, timeoutMs });
    await waitFor(() => f.runnerState.held === 1, 20_000);
    return { f, exported, release };
  }
  async function xredSweep(f: { companyId: string; issueId: string; runId: string }) {
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    return { cards: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)),
      claims: { checkoutRunId: task.checkoutRunId, executionRunId: task.executionRunId },
      h6: await runExecutionsStoppedOrHandedOffWarm(db, f.companyId, [f.runId]) };
  }

  it("XRED: a sweep during the held export and after its finalize + release raises no card; the successor adopts the same lease", async () => {
    const { f, exported, release } = await xredHeldExport(30_000);
    // (1) Export HELD in progress (receipt landed, finalization ownership held, lease active).
    const during = await xredSweep(f);
    expect({ cards: during.cards.map(card => card.cause), h6: during.h6 }).toEqual({ cards: [], h6: true });
    expect(during.claims).toEqual({ checkoutRunId: f.runId, executionRunId: f.runId });
    const [leaseDuring] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    // (2) The export finalizes; the heartbeat teardown then hands the box off (the real release writer).
    release();
    expect(await exported).toEqual({ outcome: "finalized" });
    await environmentService(db).releaseLease(f.leaseId, "retained", { cleanupStatus: "success" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const after = await xredSweep(f);
    expect({ cards: after.cards.map(card => card.cause), h6: after.h6 }).toEqual({ cards: [], h6: true });
    expect(after.claims).toEqual({ checkoutRunId: f.runId, executionRunId: f.runId });
    // Fields the export wrote on the lease: only metadata.nativeWorkspaceSync (+ updatedAt).
    const changed = Object.keys(lease.metadata ?? {}).filter(key =>
      JSON.stringify((lease.metadata ?? {})[key]) !== JSON.stringify((leaseDuring.metadata ?? {})[key]));
    expect({ status: lease.status, cleanupStatus: lease.cleanupStatus, releasedAt: lease.releasedAt, changed })
      .toEqual({ status: "retained", cleanupStatus: "success", releasedAt: null, changed: ["nativeWorkspaceSync"] });
    // The Send gate admits the same lease once the s3 fence's runner-exit stamp is persisted.
    await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
      handedOffWarmOwnerRunnerExited: { runId: f.runId, provenAt: new Date().toISOString() } } }).where(eq(environmentLeases.id, f.leaseId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [stamped] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(handedOffWarmLeaseSettled(run, stamped)).toBe(true);
    expect(await nativeWorkspaceExportPendingForResource(db, stamped, f.successorRunId)).toBe(false);
    expect(await successorOnSameBox(f)).toBe("adopt_remote");
  }, 90_000);

  it("XRED: the export TIMES OUT (unproven): what the sweep and the transcript show", async () => {
    const { f, exported, release } = await xredHeldExport(2_000);
    expect(await exported).toEqual({ outcome: "unproven", reason: "timed_out" });
    release();
    await environmentService(db).releaseLease(f.leaseId, "retained", { cleanupStatus: "success" });
    const swept = await xredSweep(f);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    const lines = events.map(event => event.message ?? "").filter(Boolean);
    if (process.env.XRED_OUT) await writeFile(process.env.XRED_OUT, JSON.stringify({ cards: swept.cards.map(card => ({ cause: card.cause, status: card.status })),
      h6: swept.h6, claims: swept.claims, lines }, null, 2));
    expect(lines.some(line => /source does not match/i.test(line) || /new task/i.test(line))).toBe(false);
    expect(lines.some(line => line.includes("could not be confirmed in time (timed_out)"))).toBe(true);
  }, 90_000);

  /** pl/lockloss: the finalization lock session's idle_in_transaction_session_timeout, for new sessions only. */
  async function withLockSessionIdleTimeout<T>(value: string, body: () => Promise<T>): Promise<T> {
    const [{ name }] = await db.execute(sql`select current_database() as name`) as unknown as Array<{ name: string }>;
    await db.execute(sql.raw(`alter database "${name}" set idle_in_transaction_session_timeout = '${value}'`));
    try { return await body(); }
    finally { await db.execute(sql.raw(`alter database "${name}" reset idle_in_transaction_session_timeout`)); }
  }

  it("(lockloss) the lock session dies mid-copyback: the copyback stops, writes nothing more to the host, the export is unproven", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    // Hold the copyback's first remote command (the box export) while the lock session is killed.
    f.runnerState.gate = { match: () => true, until: new Promise<void>(resolve => { release = resolve; }) };
    await withLockSessionIdleTimeout("3s", async () => {
      const outcome = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
        nativeWorkspaceSync: f.sync, timeoutMs: 30_000 });
      outcome.catch(() => undefined);
      await waitFor(() => (f.runnerState.held ?? 0) >= 1);
      // The finalization lock session is terminated (as the idle timeout or an operator would).
      const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
        and pid <> pg_backend_pid()`) as unknown as Array<{ pid: number }>;
      expect(lockers).toHaveLength(1);
      await db.execute(sql`select pg_terminate_backend(${lockers[0].pid})`);
      // A second owner acquires the advisory lock and writes the host workspace.
      let second = false;
      for (let attempt = 0; attempt < 50 && !second; attempt += 1) {
        second = await db.transaction(async tx => {
          const acquired = await tryLockNativeWorkspaceFinalization(tx as never, { companyId: f.companyId, runId: f.runId });
          if (acquired) await writeFile(join(f.host, "next.txt"), "the next owner's write\n");
          return acquired;
        });
        if (!second) await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(second).toBe(true);
      // Let the keepalive see the dead session (it pings every second here), then release the held copyback.
      await new Promise(resolve => setTimeout(resolve, 2_000));
      f.runnerState.gate = null;
      release();
      await waitFor(() => f.runnerState.inflight === 0);
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await waitFor(() => f.runnerState.inflight === 0);
      // Base: the copyback merges the box edit into the host after the lock was lost.
      expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
      expect(await readFile(join(f.host, "next.txt"), "utf8")).toBe("the next owner's write\n");
      await expect(stat(join(f.box, ...STAMP))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await outcome).toEqual({ outcome: "unproven", reason: "ownership_lost" });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync))
        .toMatchObject({ state: "prepared", finalHostSha256: null });
      expect(run.runnerProfileJson?.nativeCancelledWarmExport).toMatchObject({ state: "unproven", reason: "ownership_lost" });
    });
  }, 60_000);

  it("(lockloss) no false cut: timeout 120 s and 45 s of quiet remote work, the keepalive holds and the export finalizes", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    f.runnerState.gate = { match: () => true, until: new Promise<void>(resolve => { release = resolve; }) };
    await withLockSessionIdleTimeout("120s", async () => {
      const outcome = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
        nativeWorkspaceSync: f.sync, timeoutMs: 90_000 });
      outcome.catch(() => undefined);
      await waitFor(() => (f.runnerState.held ?? 0) >= 1);
      await new Promise(resolve => setTimeout(resolve, 45_000));
      f.runnerState.gate = null;
      release();
      expect(await outcome).toEqual({ outcome: "finalized" });
      expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(EDIT);
    });
  }, 120_000);

  // ---- pl/cancel-finalize4 (rf-4 02:16Z Q3 + lockloss as ONE path): the abort reaches the LOCAL restore ----
  const NEXT_OWNER_EDIT = "next owner's task edit\n";
  /** Holds the host merge lock (as a concurrent local writer would) until `release`. */
  async function holdHostMergeLock(host: string) {
    let release!: () => void;
    let held = false;
    const hold = withDirectoryMergeLock(host, async () => {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
    });
    await waitFor(() => held);
    return { hold, release: () => release() };
  }

  it("(cf4) a local merge waiting on the host merge lock past the deadline does not overwrite the next owner's edit", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    const lock = await holdHostMergeLock(f.host);
    let exportPromise: Promise<void> | undefined;
    const original = f.sync.restoreWorkspace.bind(f.sync);
    vi.spyOn(f.sync, "restoreWorkspace").mockImplementation((...args) => (exportPromise = original(...args)));
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      expect(await work).toEqual({ outcome: "unproven", reason: "timed_out" });
      // The next owner takes the finalization ownership and edits the host task file.
      const probe = await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
        async () => { await writeFile(join(f.host, "task.txt"), NEXT_OWNER_EDIT); return "next"; });
      expect(probe).toMatchObject({ acquired: true });
      lock.release();
      await lock.hold;
      const error = await exportPromise!.then(() => null, (cause: unknown) => cause);
      expect(error).toBeTruthy();
      // Base: the abandoned merge overwrites it with the stopped turn's bytes.
      expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(NEXT_OWNER_EDIT);
      await expect(stat(join(f.box, ...STAMP))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lock.release();
      await lock.hold;
      await work;
      await exportPromise?.catch(() => undefined);
    }
  }, 60_000);

  it("(cf4 lockloss) the lock session dies while the local merge waits on the host merge lock: the next owner's edit stands", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    const lock = await holdHostMergeLock(f.host);
    try {
      await withLockSessionIdleTimeout("3s", async () => {
        const outcome = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
          nativeWorkspaceSync: f.sync, timeoutMs: 30_000 });
        outcome.catch(() => undefined);
        // The remote part is done; the copyback now waits on the host merge lock.
        await waitFor(() => f.runnerState.calls > f.callsAtStop && f.runnerState.inflight === 0);
        let calls = -1;
        while (calls !== f.runnerState.calls) { calls = f.runnerState.calls; await new Promise(resolve => setTimeout(resolve, 750)); }
        // The finalization lock session is terminated.
        const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
          and pid <> pg_backend_pid()`) as unknown as Array<{ pid: number }>;
        expect(lockers).toHaveLength(1);
        await db.execute(sql`select pg_terminate_backend(${lockers[0].pid})`);
        // A second owner acquires the advisory lock and edits the host task file.
        let second = false;
        for (let attempt = 0; attempt < 50 && !second; attempt += 1) {
          second = await db.transaction(async tx => {
            const acquired = await tryLockNativeWorkspaceFinalization(tx as never, { companyId: f.companyId, runId: f.runId });
            if (acquired) await writeFile(join(f.host, "task.txt"), NEXT_OWNER_EDIT);
            return acquired;
          });
          if (!second) await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(second).toBe(true);
        // Let the keepalive see the dead session, then release the host merge lock.
        await new Promise(resolve => setTimeout(resolve, 2_000));
        lock.release();
        await lock.hold;
        expect(await outcome).toEqual({ outcome: "unproven", reason: "ownership_lost" });
        await new Promise(resolve => setTimeout(resolve, 1_000));
        // Base: the copyback merges the stopped turn's bytes over the next owner's edit.
        expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(NEXT_OWNER_EDIT);
        await expect(stat(join(f.box, ...STAMP))).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      lock.release();
      await lock.hold;
    }
  }, 60_000);
});
