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
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { recoveryService } from "./recovery/service.js";
import { prepareSandboxStopAndRetain } from "./sandbox-stop-and-retain.js";
import { hasRemoteTerminationReceipt, remoteTerminationReceipt } from "./remote-execution-termination.js";
import type { EnvironmentLease } from "@paperclipai/shared";
import { captureDirectorySnapshot, directorySnapshotSha256, withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { personFacingText, STOP_ABSENT_LINES } from "../__tests__/helpers/person-facing-lines.js";
import { createAdapterExecutionControl } from "./adapter-execution-control.js";
import { createAgentIdentityRedactor } from "./agent-identity-redaction.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./heartbeat/runtime-execution.js";
import { finishCancelledWarmWorkspaceExport } from "./heartbeat/cancelled-warm-workspace-export.js";
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

// adopt-stopu-escaped (RFL 01:00Z, rf-3's RED shape): the turn edits F, then
// starts an ESCAPED background writer (its own session: setsid, as nohup/setsid
// would) that keeps rewriting the SAME F; the person presses Stop; the real
// export runs. Each writer version is CHUNKS x CHUNK bytes of one repeated
// 10-byte line "v<8 digits>\n", written in CHUNK-sized write() calls, so a
// copy that mixes two versions, or catches a version half-written, is TORN.
const CHUNK = 16 * 1024, CHUNKS = 32;
const WRITER = `import os, sys, time
path, mode, counter = sys.argv[1], sys.argv[2], sys.argv[3]
CH, N = ${CHUNK}, ${CHUNKS}
n = 0
while True:
    n += 1
    chunk = (("v%08d\\n" % n) * (CH // 10 + 1)).encode()[:CH]
    if mode == "atomic":
        tmp = path + ".writer-tmp"
        with open(tmp, "wb") as f:
            for _ in range(N): f.write(chunk); f.flush()
        os.rename(tmp, path)
    else:
        f = open(path, "r+b" if mode == "inplace" and os.path.exists(path) else "wb")
        for _ in range(N): f.write(chunk); f.flush()
        f.truncate(); f.close()
    with open(counter + ".tmp", "w") as c: c.write(str(n))
    os.rename(counter + ".tmp", counter)
`;
type WriterMode = "inplace" | "truncate" | "atomic";
/** What a copy of F is: the base, the turn's own edit, ONE complete writer version, or TORN. */
function classifyF(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (text === BASE) return "base";
  if (text === EDIT) return "turn_edit";
  if (bytes.length === CHUNK * CHUNKS) {
    const first = bytes.subarray(0, CHUNK);
    const match = /^v(\d{8})\n/.exec(first.subarray(0, 10).toString("utf8"));
    let whole = Boolean(match);
    for (let i = 1; whole && i < CHUNKS; i++) whole = first.equals(bytes.subarray(i * CHUNK, (i + 1) * CHUNK));
    if (whole && match) return `writer_v${Number(match[1])}`;
  }
  return `TORN(len=${bytes.length},head=${JSON.stringify(bytes.subarray(0, 10).toString("utf8"))},tail=${JSON.stringify(bytes.subarray(Math.max(0, bytes.length - 10)).toString("utf8"))})`;
}
const escapedWriters: number[] = [];
function stopEscapedWriters() {
  for (const pid of escapedWriters.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
}
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
(support.supported ? describe : describe.skip)("adopt-stopu-escaped: the ordinary person-Stop export vs an escaped writer of the same file", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cancel-finalize-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    stopEscapedWriters();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  type Variant = { edit: boolean; settled: boolean; exportFails: boolean;
    /** pl/r4-work3 (a), taken into U: NSE's record of the CLOSED session's close for this Stop
     * (native-session-executor.ts releaseWarmNativeSession onStoppedSessionClose):
     * "clean" = closeWarmNativeSession did not throw (the Pi transport ladder completed;
     * on the Boat path the Runner's suspension receipt was accepted); "threw" = the close
     * threw (swallowed by the release, recorded here); "none" = no record at all.
     * Default: "clean" when NSE settled the Stop (what NSE writes on a clean close). */
    closeProof?: "clean" | "threw" | "none";
    /** adopt-stopu-escaped: after the edit, the turn starts an escaped writer of the same F. */
    writer?: WriterMode };
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
      if (variant.writer) {
        // The turn's tool starts a background loop in its OWN session (setsid;
        // detached=true calls setsid(2)): it escapes the turn's process group,
        // so the session close (pgid kill) does not reach it.
        const script = join(root, "writer.py"), counter = join(root, "writer.count");
        await writeFile(script, WRITER);
        const child = spawn("python3", [script, join(box, "task.txt"), variant.writer, counter], { detached: true, stdio: "ignore" });
        child.unref();
        escapedWriters.push(child.pid!);
        await waitFor(() => { try { return Number(readFileSync(counter, "utf8")) >= 3; } catch { return false; } });
      }
      // The person's Stop, acknowledged; NSE settles it (coordinator terminal_failure /
      // native_retry_cancelled) after a clean cancellation. adopt-stopu: under
      // stop_and_retain no retained idle receipt is written.
      const stoppedAt = new Date();
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: stoppedAt,
        resultJson: { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
          executionCancellation: { state: "acknowledged" },
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId, scope: "run",
            reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
            intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } },
        runnerProfileJson: { ...current.runnerProfileJson,
          ...((variant.closeProof ?? (variant.settled ? "clean" : "none")) !== "none" ? { nativeStoppedSessionClose: {
            schema: "paperclip.native-stopped-session-close.v1", companyId, issueId, runId, sessionId,
            clean: (variant.closeProof ?? "clean") === "clean",
            ...(variant.closeProof === "threw" ? { failure: "Pi RPC process did not exit after bounded shutdown escalation" } : {}),
            at: stoppedAt.toISOString() } } : {}) },
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
        onNativeSessionResumeScheduled: () => {},
        onNativeWorkspaceFinalizeScheduled: () => { finalizeScheduled = true; } },
    } as unknown as HeartbeatRuntimeExecutionInput;
    let finalizeScheduled = false;
    await expect(executeHeartbeatRuntime(db, executionInput)).rejects.toBe(stop);
    executionControl.finish();
    // adopt-stopu U1: what the heartbeat teardown sees at the release.
    const [atRelease] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const referenceAtRelease = readNativeWorkspaceSyncReference(atRelease.runnerProfileJson?.nativeWorkspaceSync);

    // adopt-stopu: the heartbeat teardown releases the box stop_and_retain (as
    // upstream); for a reuse lease environment-runtime records it `released` with
    // the provider's bound stop receipt (environment-runtime.ts releaseRunLease).
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
    const excluded = await nativeWorkspaceExportPendingForResource(db, retained, successorRunId);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId)));
    return { referenceAtRelease, finalizeScheduled,
      root, host, box, companyId, workspaceId, leaseId, providerLeaseId, runnerState, callsAtStop, stopped,
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


  // ---- adopt-stopu-escaped (RFL 01:00Z): never-OK: no TORN F ever reaches the host ----
  it.each([
    ["in-place rewrite (r+, same size, chunked)", "inplace"],
    ["truncate-then-write (> F, chunked)", "truncate"],
    ["atomic temp+rename", "atomic"],
  ] as const)("escaped writer, %s: the real Stop export never puts a torn F on the host", async (_label, writer) => {
    const f = await stopMidTurn({ edit: true, settled: true, exportFails: false, closeProof: "clean", writer });
    const hostAtExport = classifyF(await readFile(join(f.host, "task.txt")));
    const boxAtExport = classifyF(await readFile(join(f.box, "task.txt")));
    const counterAtExport = Number(readFileSync(join(f.root, "writer.count"), "utf8"));
    stopEscapedWriters();
    await new Promise(resolve => setTimeout(resolve, 200));
    const boxAfterWriterKilled = classifyF(await readFile(join(f.box, "task.txt")));
    const strays = (await import("node:fs/promises")).readdir(f.host);
    const record = { writer, exportOutcome: f.stoppedRunProfile?.nativeCancelledWarmExport, descriptor: f.reference?.state,
      successorExcludesBox: f.excluded, hostAtExport, boxAtExport, counterAtExport, boxAfterWriterKilled,
      hostEntries: (await strays).sort() };
    console.info(`[adopt-stopu-escaped] ${JSON.stringify(record)}`);
    if (process.env.ESCAPED_RECORDS) await (await import("node:fs/promises")).appendFile(process.env.ESCAPED_RECORDS,
      `${JSON.stringify({ ...record, deferredLines: f.events.filter(event => event.eventType === "workspace_export_deferred").map(event => event.payload) })}\n`);
    // never-OK: the host's F is the base (nothing copied), the turn's edit, or ONE whole writer version, never torn.
    expect(hostAtExport).toMatch(/^(base|turn_edit|writer_v\d+)$/);
    // Finalized means the host holds what was copied; unproven means the host was left untouched.
    if (f.reference?.state === "finalized") expect(hostAtExport).not.toBe("base");
    else expect(hostAtExport).toBe("base");
  }, 90_000);
});
