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
import { promises as auditFs } from 'node:fs';
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
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

/** adopt-stopu-ugate: the box's process-gone check (stopped-turn-process-gone.ts). */
function isStoppedTurnProcessCheck(input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]): boolean {
  return input.command === "sh" && String(input.args?.[1] ?? "").includes("/proc/stat");
}
function runStoppedTurnProcessCheck(input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) {
  return new Promise<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>>(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, timeout: input.timeoutMs }, (error, stdout, stderr) =>
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
        timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  });
}
/** The proven-gone box for a direct call of the export boundary. */
const provenStoppedTurnBox = (remoteCwd: string) => async () => ({ runner: boxRunner({ fail: false, calls: 0 }), remoteCwd });

/** The "box": commands run locally against its directory. */
function boxRunner(state: BoxState): CommandManagedRuntimeRunner {
  return {
    execute: async (input) => {
      // adopt-stopu-ugate: the process-gone check (noStoppedTurnProcessRemains)
      // runs on the box as itself: outside this fixture's copyback accounting
      // (calls / fail / gate), which models the EXPORT's box commands.
      if (isStoppedTurnProcessCheck(input)) return await runStoppedTurnProcessCheck(input);
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
        runnerProfileJson: { ...current.runnerProfileJson,
          // pl/r4-work3 (a), taken into U: NSE's settle of the Stop records the
          // closed session's clean close (the stopped turn's tools are gone).
          ...(variant.settled ? { nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1",
            companyId, issueId, runId, sessionId: null, clean: true, at: stoppedAt.toISOString() } } : {}) },
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

  // ---- pl/cancel-finalize2: rf-4's three findings ----
  /** Settles a Stop that executeHeartbeatRuntime saw unsettled, so the bounded export can be driven directly. */
  async function settleLater(f: Awaited<ReturnType<typeof stopMidTurn>>) {
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // pl/r4-work3 (a): NSE's settle writes the clean-close proof with it.
    const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson,
      nativeStoppedSessionClose: { schema: "paperclip.native-stopped-session-close.v1", companyId: f.companyId,
        issueId: f.issueId, runId: f.runId, sessionId: null, clean: true, at: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.runId));
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
      stoppedTurnBox: provenStoppedTurnBox(f.box),
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

  it.each(["adoption", "recovery"])("AUDIT Q1 held final mv: %s ignores actual late stamp", async (reader) => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    f.runnerState.gate = { match: script => script.includes("mv ") && !script.includes("base64 -d") && script.includes("workspace-sync-v1.json.tmp"),
      until: new Promise<void>(resolve => { release = resolve; }) };
    let exportPromise!: Promise<void>;
    const original = f.sync.restoreWorkspace.bind(f.sync);
    vi.spyOn(f.sync, "restoreWorkspace").mockImplementation((...args) => (exportPromise = original(...args)));
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      stoppedTurnBox: provenStoppedTurnBox(f.box),
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      await waitFor(() => f.runnerState.held === 1);
      expect(await work).toEqual({ outcome: "unproven", reason: "timed_out" });
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId }, async () => "free"))
        .toMatchObject({ acquired: true });
      release();
      await exportPromise.catch(() => undefined);
      const stamp = JSON.parse(await readFile(join(f.box, ...STAMP), "utf8"));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(stamp.finalizedRunId).toBe(f.runId);
      expect(readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync)?.state).toBe("prepared");
      const { descriptor } = await nativeWorkspaceSyncInternals.readDescriptor({ runId: f.runId, reference: f.reference! });
      expect(descriptor.state).toBe("prepared");
      await db.update(environmentLeases).set({ metadata: { nativeWorkspaceSync: { ...stamp, finalizedRunId: randomUUID() } } })
        .where(eq(environmentLeases.id, f.leaseId));
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      expect(await nativeWorkspaceExportPendingForResource(db, lease, f.successorRunId)).toBe(true);
      await writeFile(join(process.env.TASK_OUT!, `held-mv-${reader}-events.json`), JSON.stringify({ actualHostText: await readFile(join(f.host, "task.txt"), "utf8"),
        stamp, descriptorState: descriptor.state, events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId)) }, null, 2));
      if (reader === "adoption") {
        const mode = await successorOnSameBox(f);
        console.log("AUDIT_Q1_ACTUAL_LATE_MV", JSON.stringify({ reader, stamp, descriptorState: descriptor.state, successorMode: mode }));
        await writeFile(join(process.env.TASK_OUT!, "held-mv-adoption-result.json"), JSON.stringify({ stamp, descriptorState: descriptor.state, successorMode: mode }, null, 2));
        expect(mode).not.toBe("adopt_remote");
      } else {
        const laterEdit = "unfinalized edit after late stamp\n";
        await writeFile(join(f.box, "task.txt"), laterEdit);
        expect(await resumeNativeWorkspaceSync({ db, runId: f.runId, target: { kind: "remote", transport: "sandbox", providerKey: "test", leaseId: f.leaseId,
          remoteCwd: f.box, runner: boxRunner({ fail: false, calls: 0 }), timeoutMs: 30_000,
          sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: f.providerLeaseId } } })).toBe(true);
        console.log("AUDIT_Q1_ACTUAL_LATE_MV", JSON.stringify({ reader, stamp, descriptorState: descriptor.state, hostText: await readFile(join(f.host, "task.txt"), "utf8") }));
        await writeFile(join(process.env.TASK_OUT!, "held-mv-recovery-result.json"), JSON.stringify({ stamp, descriptorState: descriptor.state, hostText: await readFile(join(f.host, "task.txt"), "utf8") }, null, 2));
        expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(laterEdit);
      }
    } finally {
      release();
      await work;
      await exportPromise?.catch(() => undefined);
    }
  }, 60_000);

  it("AUDIT Q2 cancelled deferred export names no recovery action that this state lacks", async () => {
    const f = await stopMidTurn({ edit: true, settled: true, exportFails: true });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    console.log("AUDIT_Q2_ACTIONS", JSON.stringify({ runStatus: f.stopped.status, result: f.stopped.resultJson,
      mark: f.stoppedRunProfile?.nativeCancelledWarmExport, actions }));
    await writeFile(join(process.env.TASK_OUT!, "not-copied-events.json"), JSON.stringify({ actualHostText: await readFile(join(f.host, "task.txt"), "utf8"), actions, events: f.events }, null, 2));
    expect(actions).toHaveLength(0);
    expect(f.stoppedRunProfile?.nativeCancelledWarmExport).toMatchObject({ state: "unproven", reason: "export_failed" });
    const notice = f.events.find(event => event.eventType === "workspace_export_deferred");
    expect(notice?.message).toContain("The box is kept, so nothing on it is lost.");
    expect(notice?.message).not.toMatch(/Recover saved files|\b(?:click|choose|press)\b/i);
    expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
    expect(await readFile(join(f.box, "task.txt"), "utf8")).toBe(EDIT);
  }, 60_000);

  it('AUDIT A1 actual deadline during symlink parent mkdir must not overwrite the next owner', async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    await auditFs.rm(join(f.box, 'task.txt'));
    await auditFs.symlink('zzz-stopped-target', join(f.box, 'task.txt'));
    await auditFs.writeFile(join(f.box, 'zzz-stopped-target'), EDIT);
    let release!: () => void, arrived!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { arrived = r; });
    const originalMkdir = auditFs.mkdir.bind(auditFs);
    const spy = vi.spyOn(auditFs, 'mkdir').mockImplementation(async (...args: Parameters<typeof auditFs.mkdir>) => {
      if (String(args[0]) === f.host) { arrived(); await held; }
      return originalMkdir(...args);
    });
    let exportPromise: Promise<void> | undefined;
    const originalRestore = f.sync.restoreWorkspace.bind(f.sync);
    vi.spyOn(f.sync, 'restoreWorkspace').mockImplementation((...args) => (exportPromise = originalRestore(...args)));
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      stoppedTurnBox: provenStoppedTurnBox(f.box),
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('never reached symlink mkdir')), 15_000))]);
      expect(await work).toEqual({ outcome: 'unproven', reason: 'timed_out' });
      const next = await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId }, async () => {
        await auditFs.writeFile(join(f.host, 'task.txt'), 'NEXT OWNER');
        return 'next owner wrote';
      });
      expect(next).toMatchObject({ acquired: true });
      release();
      const error = await exportPromise!.then(() => null, error => String(error));
      const entry = await auditFs.lstat(join(f.host, 'task.txt'));
      const actual = entry.isSymbolicLink() ? `SYMLINK:${await auditFs.readlink(join(f.host, 'task.txt'))}` : await auditFs.readFile(join(f.host, 'task.txt'), 'utf8');
      console.log('AUDIT_A1_DEADLINE_SYMLINK', JSON.stringify({ next, error, actual }));
      await writeFile(join(process.env.TASK_OUT!, 'deadline-symlink-result.json'), JSON.stringify({ next, error, actual }, null, 2));
      expect(actual).toBe('NEXT OWNER');
    } finally {
      release(); await work; await exportPromise?.catch(() => undefined); spy.mockRestore();
    }
  }, 45_000);

  it("AUDIT Q3 a local merge waiting past deadline must not write HOST after ownership release", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    let lockHeld = false;
    const hold = withDirectoryMergeLock(f.host, async () => {
      lockHeld = true;
      await new Promise<void>(resolve => { release = resolve; });
    });
    await waitFor(() => lockHeld);
    let exportPromise!: Promise<void>;
    const original = f.sync.restoreWorkspace.bind(f.sync);
    vi.spyOn(f.sync, "restoreWorkspace").mockImplementation((...args) => (exportPromise = original(...args)));
    const work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      stoppedTurnBox: provenStoppedTurnBox(f.box),
      nativeWorkspaceSync: f.sync, timeoutMs: 3_000 });
    try {
      expect(await work).toEqual({ outcome: "unproven", reason: "timed_out" });
      const callsAtDeadline = f.runnerState.calls;
      expect(f.runnerState.inflight).toBe(0);
      const probe = await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId },
        async () => { await writeFile(join(f.host, "next.txt"), "next owner\n"); return "free"; });
      expect(probe).toMatchObject({ acquired: true });
      expect(await readFile(join(f.host, "task.txt"), "utf8")).toBe(BASE);
      release();
      await hold;
      const error = await exportPromise.catch(error => String(error));
      const actual = await readFile(join(f.host, "task.txt"), "utf8");
      console.log("AUDIT_Q3_LOCAL_MERGE", JSON.stringify({ callsAtDeadline, callsAfterJoin: f.runnerState.calls,
        probe, exportError: error, hostText: actual, nextText: await readFile(join(f.host, "next.txt"), "utf8") }));
      expect(f.runnerState.calls).toBe(callsAtDeadline);
      expect(actual).toBe(BASE);
    } finally {
      release();
      await hold;
      await work;
      await exportPromise?.catch(() => undefined);
      await waitFor(() => f.runnerState.inflight === 0);
    }
  }, 60_000);

  it("(3) an export abandoned at the deadline writes nothing to the HOST after the lock is released", async () => {
    const f = await stopMidTurn({ edit: true, settled: false, exportFails: false });
    await settleLater(f);
    let release!: () => void;
    // Hold the copyback's first remote command (the box export) past the deadline.
    f.runnerState.gate = { match: () => true, until: new Promise<void>(resolve => { release = resolve; }) };
    const outcome = await finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      stoppedTurnBox: provenStoppedTurnBox(f.box),
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
});
