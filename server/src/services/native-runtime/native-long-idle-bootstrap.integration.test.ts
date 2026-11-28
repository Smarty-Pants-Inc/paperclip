import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agentWakeupRequests, completionContracts, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns,
  issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";

// Embedded PG and the server executor/admission/restore/retirement road are real.
// Provider execution/backend and cross-server checkpoint selection are doubles;
// sandbox commands run the production read/process scripts on local saved files.
const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(),
  executeNativeSession: boundary.execute, createNativeSessionBackend: () => ({ kind: "test" }),
}));
vi.mock("./native-codex-runner.js", async original => ({
  ...await original<typeof import("./native-codex-runner.js")>(),
  resolveRemotePaperclipRunnerBinary: async () => "/fixture/runnerd",
}));
import { closeIdleWarmNativeSessionsForRestart, executePaperclipNativeSession, scopedRunnerdStateRoot } from "./native-session-executor.js";
import * as recovery from "./remote-warm-session-recovery.js";
import * as controllerRecovery from "./native-controller-recovery.js";
import * as checkpoint from "./native-runner-checkpoint.js";
import { dispatchNativeSessionResumptions } from "./native-finalization-reconciler.js";

const fields = ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"] as const;
const modes = ["exited", "exited-resumed", "running", "unknown", ...fields.map(field => `identity-${field}`), "outbox", "pending"];

describeEmbeddedPostgres("long-idle same-conversation bootstrap", () => {
  const environment = nativeRestartFixture();
  it.each(modes.flatMap(mode => ["saved", "late"].map(timing => ({ mode, timing }))))(
    "restores only an exited settled box and preserves the owed message: $mode ($timing)", async ({ mode, timing }) => {
    const f = await environment.seedRun(`LONG-IDLE-${mode}-${timing}`);
    const { companyId, agentId, runtimeRoot } = environment.current;
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    const workspace = join(runtimeRoot, mode);
    await mkdir(workspace, { recursive: true });
    const first: NativeExecutionInputV1 = { schema: "paperclip.native-execution-input.v1",
      binding: { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: randomUUID() },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: "IDLE-1", title: "Continue the conversation", description: null, prompt: "Initial turn", workMode: "standard" },
      workspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: { ...contract.contractJson, revision: String(contract.revision) } } as NativeExecutionInputV1["completionContract"],
      interactionResponses: [], credentialBindings: [] };
    const identity = { runId: f.runId, normalizedSessionId: f.native.normalizedSessionId,
      runnerInstanceId: f.native.runnerInstanceId, environmentLeaseId: f.native.environmentLeaseId,
      turnId: f.native.turnId, itemId: f.native.itemId };
    const root = scopedRunnerdStateRoot(first);
    await mkdir(join(root, "control-plane"), { recursive: true });
    await mkdir(join(root, "runner"), { recursive: true });
    const control = { schema: "paperclip.runner.durable.control-plane-state.v1", identity };
    await writeFile(join(root, "control-plane/control-plane-state.json"), JSON.stringify(control));
    await writeFile(join(root, "runner/runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "ready" }));
    const providerSessionId = `provider-${f.runId}`;
    let lastExecution = first;
    let snapshot = { backendKind: "runner", driverKind: first.session.driverKind, sessionId: identity.normalizedSessionId,
      identity: { ...first.binding, sessionId: identity.normalizedSessionId }, providerSessionId, activeTurnId: null, pendingRuntimeRequests: [] };
    const session = { close: vi.fn(async () => {}), snapshot: async () => snapshot };
    const prompts: string[] = [], restoredReceipts: unknown[] = [];
    boundary.execute.mockReset().mockImplementation(async options => {
      if (options.input.binding.runId !== f.runId) {
        expect(options.persistedSession ?? await options.existingSession?.snapshot()).toMatchObject({ providerSessionId,
          identity: { sessionId: identity.normalizedSessionId } });
      }
      if (prompts.length === 1) restoredReceipts.push(JSON.parse(await readFile(join(root, "plugin-runner-state.json"), "utf8")));
      const queued = await options.getFirstTurnQueuedInput?.();
      prompts.push(options.input.task.prompt + (queued ?? ""));
      snapshot = { ...snapshot, identity: { ...options.input.binding, sessionId: identity.normalizedSessionId } };
      await options.onCheckpoint?.(snapshot);
      await options.onSession?.(session);
      await options.controlPlane.openRun({ identity: { ...options.input.binding, sessionId: identity.normalizedSessionId },
        backendKind: "mock", sourceInstanceId: identity.runnerInstanceId });
      const turnId = randomUUID();
      await options.controlPlane.appendEvent({ schema: "paperclip.prp.event.v1", runId: options.input.binding.runId,
        normalizedSessionId: identity.normalizedSessionId, turnId, sourceInstanceId: identity.runnerInstanceId,
        sourceEventId: `start-${turnId}`, sourceSeq: 1, sourceKind: "runner", eventType: "turn.started", schemaVersion: 1,
        priority: 0, emittedAt: new Date().toISOString(), payload: {} });
      const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT,
        completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: String(contract.revision) } };
      await options.controlPlane.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId });
      // The provider double rotates local durable authority as a real runner
      // does after admission. It does not rewrite the saved box cursor.
      const currentIdentity = { ...identity, runId: options.input.binding.runId };
      await writeFile(join(root, "control-plane/control-plane-state.json"), JSON.stringify({ ...control, identity: currentIdentity }));
      await writeFile(join(root, "runner/runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1", ...currentIdentity, lifecycle: "ready" }));
      lastExecution = options.input;
      return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId, normalizedSessionId: identity.normalizedSessionId,
        providerSessionId, driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const [sandbox] = await f.db.insert(environments).values({ name: `Long idle ${f.runId}`, driver: "sandbox" }).returning();
    const providerLeaseId = randomUUID();
    const target = { kind: "remote", transport: "sandbox", remoteCwd: workspace, environmentId: sandbox.id,
      providerKey: "fixture", leaseId: randomUUID(), sandboxLeaseAcquisition: { outcome: "created", providerLeaseId },
      runner: { execute: vi.fn(async (request: { command: string; args?: string[] }) => ({ exitCode: 0, timedOut: false, stderr: "",
        stdout: request.args?.[1] === "uname -s; uname -m" ? "Linux\nx86_64\n" : "" })) } };
    const selector = vi.spyOn(controllerRecovery, "resolveNativeControllerRecovery").mockResolvedValue({ kind: "no_prior_execution" });
    const restore = vi.spyOn(checkpoint, "restoreNativeRunnerCheckpoint").mockResolvedValue(null);
    const inspect = vi.spyOn(recovery, "inspectRemoteWarmSessionRecovery").mockImplementation(async request => ({
      identity: Object.fromEntries(fields.map(field => [field, String(request.identity[field])])),
      checkpoint: request.loadCheckpoint(lastExecution)!, previousExecution: lastExecution, reuseProcess: true,
      remote: { providerLeaseId, remoteCwd: workspace }, revalidate: async () => {} }));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile, nativeExecutionInput: first } }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.insert(environmentLeases).values({ companyId, environmentId: sandbox.id, issueId: f.issueId, heartbeatRunId: f.runId,
        provider: "fixture", providerLeaseId, status: "released", metadata: { remoteCwd: workspace } });
      expect((await executePaperclipNativeSession({ db: f.db, execution: first, runnerInstanceId: identity.runnerInstanceId,
        useRunnerd: true, runnerExecutionTarget: target as never })).exitCode).toBe(0);
      await closeIdleWarmNativeSessionsForRestart();
      await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
      await rm(join(root, "runner/runner-state.json"));
      const runnerDirectory = join(workspace, ".paperclip-runtime/paperclip-runner/sessions",
        createHash("sha256").update(identity.normalizedSessionId).digest("hex"), "runner");
      await mkdir(runnerDirectory, { recursive: true });
      const saved = { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "recoverable_failure",
        recoverableFailure: "lease_expired_requires_bootstrap", nextSourceSeq: 42, ackedSourceSeq: 41,
        outbox: mode === "outbox" ? [{ sourceSeq: 41 }] : [], pendingTerminalDelivery: mode === "pending" ? { commandId: "pending" } : null,
        ...(mode.startsWith("identity-") ? { [mode.slice(9)]: "different-owner" } : {}) };
      const runnerPath = join(runnerDirectory, "runner-state.json");
      await writeFile(runnerPath, JSON.stringify(saved));
      const savedBytes = await readFile(runnerPath, "utf8");
      let pid = 2147483646, fingerprint = "linux:abcd-1234:100";
      if (mode === "running" || mode === "unknown") {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--runner-id", identity.runnerInstanceId], { stdio: "ignore" });
        await once(child, "spawn"); pid = child.pid!;
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        fingerprint = `linux:${(await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]}`;
        if (mode === "unknown") fingerprint += "0";
      }
      await writeFile(join(runnerDirectory, "runner-process.identity"), `nonce\n${pid}\n2026-09-19T10:00:00.000Z\n${identity.runnerInstanceId}\n${fingerprint}\n`);
      let reads = 0;
      target.runner.execute.mockImplementation(async request => {
        // The box changes after the two ordinary admission reads, reproducing
        // the live-adoption door rather than pre-admitting the state earlier.
        if (timing === "late" && request.args?.[1]?.includes("base64") && ++reads <= 2) return { exitCode: 0, timedOut: false, stderr: "", stdout:
          Buffer.from(JSON.stringify({ ...saved, ...identity, lifecycle: "ready", outbox: [], pendingTerminalDelivery: null })).toString("base64") };
        if (request.args?.[2] === "paperclip-runner-port-holders") return { exitCode: 0, timedOut: false, stderr: "", stdout: "" };
        try { return { exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync(request.command, request.args ?? [], { encoding: "utf8", timeout: 10_000 }) }; }
        catch (error) { const result = error as { status?: number; stdout?: string; stderr?: string };
          return { exitCode: result.status ?? 1, timedOut: false, stderr: result.stderr ?? "", stdout: result.stdout ?? "" }; }
      });
      const nextRun = async (prompt: string, queue: boolean) => {
        const runId = randomUUID();
        const execution = { ...first, binding: { ...first.binding, runId }, task: { ...first.task, prompt } };
        await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
          nativeIssueId: f.issueId, nativeSessionId: identity.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId,
          completionContractId: contract.id, completionContractSha256: contract.canonicalSha256,
          runnerProfileJson: { nativeExecutionInput: execution }, contextSnapshot: { issueId: f.issueId } });
        await f.db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, f.issueId));
        await f.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: f.issueId, phase: "observed" });
        const [lease] = await f.db.insert(environmentLeases).values({ companyId, environmentId: sandbox.id, issueId: f.issueId,
          heartbeatRunId: runId, provider: "fixture", providerLeaseId, status: "active", metadata: { remoteCwd: workspace } }).returning();
        let wakeId: string | undefined;
        if (queue) {
          const [comment] = await f.db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user", authorUserId: "idle-person", body: prompt }).returning();
          const [wake] = await f.db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
            reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "idle-person",
            payload: { issueId: f.issueId, commentId: comment.id, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId,
              wakeReason: "issue_commented", source: "issue.comment", wakeCommentId: comment.id, wakeCommentIds: [comment.id] } } }).returning();
          wakeId = wake.id;
        }
        const outcome = executePaperclipNativeSession({ db: f.db, execution, runnerInstanceId: identity.runnerInstanceId, useRunnerd: true,
          runnerExecutionTarget: { ...target, leaseId: lease.id, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId } } as never });
        return { runId, outcome, wakeId };
      };
      // A stopped provider preserves its disk. The provider acquisition double
      // returns resumed below; the production scripts read those same bytes.
      if (mode === "exited-resumed") {
        expect(await readFile(runnerPath, "utf8")).toBe(savedBytes);
        console.info("sandbox lifecycle double: running -> stopped (disk retained) -> resumed");
      }
      const message = `Please continue the same conversation: ${mode}`;
      const next = await nextRun(message, true);
      if (mode === "exited" || mode === "exited-resumed") {
        await expect(next.outcome).resolves.toMatchObject({ exitCode: 0, sessionId: identity.normalizedSessionId });
        expect(prompts[1]).toContain(message);
        expect((await f.db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, next.runId))).filter(event => event.eventType === "turn.started")).toHaveLength(1);
        // The server receipt is lifecycle authority only: no backup replaces
        // the box's provider state or advances/rewinds its cursor.
        expect(await readFile(runnerPath, "utf8")).toBe(savedBytes);
        expect(restoredReceipts).toEqual([expect.objectContaining({ ...identity, lifecycle: "recoverable_failure" })]);
        let previousRunId = next.runId;
        for (const turn of ["ordinary one", "ordinary two"]) {
          await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, previousRunId));
          await f.db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, previousRunId));
          await f.db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.heartbeatRunId, previousRunId));
          const following = await nextRun(turn, false);
          await expect(following.outcome).resolves.toMatchObject({ exitCode: 0, sessionId: identity.normalizedSessionId });
          previousRunId = following.runId;
        }
        expect(boundary.execute).toHaveBeenCalledTimes(4);
        expect(prompts.slice(2)).toEqual(["ordinary one", "ordinary two"]);
      } else {
        await expect(next.outcome).rejects.toThrow("remote_warm_session_not_idle");
        const [settled] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, next.runId));
        expect(settled).toMatchObject({ phase: "terminal_failure", failureCode: "remote_warm_session_not_idle", nextAttemptAt: null });
        expect((settled.failureDetail as { nextAction: string }).nextAction).toContain("message remains unanswered");
        const dispatch = vi.fn();
        for (const delay of [31_000, 62_000]) expect(await dispatchNativeSessionResumptions({ db: f.db,
          runnerInstanceId: "idle-reconciler", runIds: [next.runId], now: new Date(Date.now() + delay), dispatch })).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
        expect((await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, next.wakeId!)))[0]).toMatchObject({ status: "deferred_issue_execution" });
        expect((await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId)))).toHaveLength(2);
        expect(boundary.execute).toHaveBeenCalledOnce();
        expect(await readFile(runnerPath, "utf8")).toBe(savedBytes);
      }
      console.info(JSON.stringify({ row: "long-idle", mode, timing, sourceRunId: f.runId, nextRunId: next.runId,
        normalizedSessionId: identity.normalizedSessionId, providerSessionId, turns: boundary.execute.mock.calls.length, cursor: saved.nextSourceSeq }));
    } finally {
      if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      await closeIdleWarmNativeSessionsForRestart();
      selector.mockRestore(); restore.mockRestore(); inspect.mockRestore();
    }
  }, 60_000);
});
