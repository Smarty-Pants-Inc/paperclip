import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { isRunnerResumeStateUnavailable, NativeRunnerResumeStateUnavailableError } from "../contracts/harness-driver.js";
import { defaultCapabilityRunnerdBinary, expectTurnStarted, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

it.each(["restore", "refuse", "foreign-state"] as const)(
  "continues a completed warm handoff through external cold-state preparation: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "runnerd-warm-cold-restore-"));
    const saved = await mkdtemp(join(tmpdir(), "runnerd-warm-saved-"));
    const callsPath = join(root, "calls.log");
    const identity = {
      runnerInstanceId: "cold-restore-runner",
      environmentLeaseId: "cold-restore-lease",
      runId: "first-run",
      normalizedSessionId: "cold-restore-session",
      turnId: "first-turn",
      itemId: "first-item",
    };
    const options = {
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(root, "--call-log", callsPath, "--record-process-start"),
      stateDirectory: root,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      runnerReconnectGraceMs: 2_000,
    };
    const first = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: identity });
    let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
      const openedThread = opened.thread as { id: string; sessionId: string };
      const thread = { id: openedThread.id, sessionId: openedThread.sessionId };
      await first.transport.attachRun!({ runId: "second-run", turnId: "second-turn", itemId: "second-item" });
      expect((await first.transport.request("thread/read", {})).thread).toMatchObject(thread);
      await first.transport.close();
      const controlPath = join(root, "control-plane", "control-plane-state.json");
      const controlBytes = await readFile(controlPath);
      const control = JSON.parse(controlBytes.toString());
      expect(control.completedWarmTransition.receipt.newIdentity.runId).toBe("second-run");
      const savedRunner = join(saved, "runner");
      await rename(join(root, "runner"), savedRunner);
      const savedState = JSON.parse(await readFile(join(savedRunner, "runner-state.json"), "utf8"));
      expect(savedState).toMatchObject({ lifecycle: "suspended", runId: "second-run" });
      const callsBefore = await readFile(callsPath, "utf8");
      const sentinel = "workspace content must survive cold provider recovery";
      await writeFile(join(root, "workspace-sentinel.txt"), sentinel);
      let prepared = false;
      const prepare = vi.fn(async () => {
        if (prepared) return;
        if (mode === "refuse") throw new Error("fixture cold restore authority refused");
        await cp(savedRunner, join(root, "runner"), { recursive: true, errorOnExist: true });
        if (mode === "foreign-state") {
          await writeFile(join(root, "runner", "runner-state.json"), JSON.stringify({
            ...savedState, normalizedSessionId: "another-session",
          }));
        }
        prepared = true;
      });
      const read = vi.fn(async () => JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")));
      const archive = vi.fn(async (request: { archiveKey: string }) => {
        const state = await read();
        const directory = join(root, "authority-epochs", request.archiveKey);
        await mkdir(directory, { recursive: true });
        await rename(join(root, "runner", "runner-state.json"), join(directory, "runner-state.json"));
        return state;
      });
      const exitVerifier = vi.fn(async () => { throw new Error("suspended resume must not probe exit"); });
      resumed = createCapabilityRunnerdCodexTransport({
        ...options,
        freshBootstrapExitVerified: exitVerifier,
        prpIdentity: { ...identity, runId: "third-run", turnId: "third-turn", itemId: "third-item" },
        resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
        readRunnerState: read,
        prepareExternalRunnerState: prepare,
        archiveExternalRunnerState: archive,
      });
      if (mode === "refuse") {
        await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("fixture cold restore authority refused");
        expect(read).not.toHaveBeenCalled();
        expect(archive).not.toHaveBeenCalled();
        expect(await readFile(callsPath, "utf8")).toBe(callsBefore);
        expect(await readFile(controlPath)).toEqual(controlBytes);
      } else if (mode === "foreign-state") {
        await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("native_runner_authority_rotation_requires_settled_state");
        expect(read).toHaveBeenCalled();
        expect(archive).not.toHaveBeenCalled();
        expect(await readFile(callsPath, "utf8")).toBe(callsBefore);
        expect(await readFile(controlPath)).toEqual(controlBytes);
      } else {
        expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(thread);
        expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
        const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/);
        expect(calls.filter(call => call === "thread/start")).toHaveLength(1);
        expect(calls.filter(call => call === "thread/resume")).toHaveLength(1);
        expect(calls.filter(call => call === "turn/start")).toHaveLength(0);
        expect(JSON.parse(await readFile(controlPath, "utf8")).identity.runId).toBe("third-run");
        expect(await readFile(join(root, "workspace-sentinel.txt"), "utf8")).toBe(sentinel);
        expect(exitVerifier).not.toHaveBeenCalled();
      }
    } finally {
      await Promise.allSettled([first.transport.close(), resumed?.transport.close()]);
      await rm(root, { recursive: true, force: true });
      await rm(saved, { recursive: true, force: true });
    }
  },
  30_000,
);

// Real TS transport + real runnerd; only the Codex provider is the package's
// deterministic app-server fixture. The saved failure is seeded after runnerd
// has exited, never while a process still owns the state.
const bootstrapIdentityFields = ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"] as const;
const bootstrapFailures = ["lease_expired_requires_bootstrap", "transport_reconnect_deadline_exceeded", "transport_reconnect_grace_exceeded",
  "legacy:lease_expired_requires_bootstrap"];
const bootstrapRefusals = ["outbox", "terminal", "cleanup", "transition", "other-failure", "failure-array", "failure-object", "ready", "missing-terminal",
  ...bootstrapIdentityFields.map(field => `identity-${field}`), ...bootstrapIdentityFields.map(field => `exit-proof-${field}`)];
// A copied lifecycle, allocation change, adoption or completed retirement is
// never process-exit authority. Exercise both rotation and PRP source attachment.
const unverifiedBootstrapPaths = ["road-c-copy", "environment-move", "resize", "carried-run", "adopted-run", "warm-retirement", "plugin-task", "ssh", "local"];
it.each([
  ...bootstrapFailures.flatMap(reason => ["local", "external"].map(placement => ({ mode: "restore", reason, placement }))),
  ...bootstrapRefusals.map(mode => ({ mode, reason: bootstrapFailures[0]!, placement: "external" })),
  ...bootstrapFailures.flatMap(reason => ["local", "external"].map(placement => ({ mode: "lazy-restore", reason, placement }))),
  ...bootstrapIdentityFields.map(field => ({ mode: `lazy-exit-proof-${field}`, reason: bootstrapFailures[0]!, placement: "external" })),
  ...["local", "external", "prp-local", "prp-external"].map(placement => ({ mode: "lazy-no-exit-proof", reason: bootstrapFailures[0]!, placement })),
  ...["outbox", "terminal", "cleanup", "transition", "other-failure", "ready"].map(mode =>
    ({ mode: `lazy-${mode}`, reason: bootstrapFailures[0]!, placement: "external" })),
  ...unverifiedBootstrapPaths.flatMap(path => ["local", "external", "prp-local", "prp-external"].map(placement =>
    ({ mode: `no-exit-proof-${path}`, reason: bootstrapFailures[0]!, placement }))),
  ...bootstrapFailures.slice(1, 3).map(reason => ({ mode: "no-exit-proof-reconnect", reason, placement: "external" })),
])("cold continuation loads only settled fresh-bootstrap state: $placement / $mode / $reason", async ({ mode: testMode, reason, placement }) => {
  const lazy = testMode.startsWith("lazy-"), mode = lazy ? testMode.slice(5) : testMode;
  const root = await mkdtemp(join(tmpdir(), "runnerd-bootstrap-cold-"));
  const callsPath = join(root, "calls.log"), requestsPath = join(root, "requests.jsonl");
  const identity = { runnerInstanceId: "bootstrap-runner", environmentLeaseId: "bootstrap-lease", runId: "prior-run",
    normalizedSessionId: "bootstrap-session", turnId: "prior-turn", itemId: "prior-item" };
  const options = { runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--call-log", callsPath, "--request-log", requestsPath), stateDirectory: root,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 }, runnerReconnectGraceMs: 2_000 };
  const first = createCapabilityRunnerdCodexTransport({ ...options, prpIdentity: identity });
  let resumed: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  try {
    const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    const thread = opened.thread as { id: string; sessionId: string };
    await first.transport.close();
    const runnerPath = join(root, "runner/runner-state.json"), controlPath = join(root, "control-plane/control-plane-state.json");
    const saved = { ...JSON.parse(await readFile(runnerPath, "utf8")), lifecycle: "recoverable_failure", recoverableFailure: reason };
    expect(saved).toMatchObject({ ...identity, outbox: [], pendingTerminalDelivery: null });
    if (reason.startsWith("legacy:")) { delete saved.recoverableFailure; saved.recoverable_failure = reason.slice(7); }
    if (mode.startsWith("identity-")) saved[mode.slice(9)] = "foreign-owner";
    if (mode === "outbox") saved.outbox = [{ sourceSeq: saved.nextSourceSeq }];
    if (mode === "terminal") saved.pendingTerminalDelivery = { commandId: "pending" };
    if (mode === "cleanup") saved.pendingProviderCleanup = { commandId: "pending" };
    if (mode === "transition") saved.warmTransition = { transitionId: "pending" };
    if (mode === "other-failure") saved.recoverableFailure = "unrecognized_failure";
    if (mode === "failure-array") saved.recoverableFailure = [reason];
    if (mode === "failure-object") saved.recoverableFailure = { code: reason };
    if (mode === "ready") saved.lifecycle = "ready";
    if (mode === "missing-terminal") delete saved.pendingTerminalDelivery;
    await writeFile(runnerPath, JSON.stringify(saved));
    const controlBefore = await readFile(controlPath), callsBefore = await readFile(callsPath, "utf8");
    const read = async () => JSON.parse(await readFile(runnerPath, "utf8"));
    const archived: Record<string, unknown>[] = [];
    const proof = { ...identity };
    if (mode.startsWith("exit-proof-")) proof[mode.slice(11) as typeof bootstrapIdentityFields[number]] = "foreign-owner";
    const verifyExit = vi.fn(async () => mode === "no-exit-proof" ? undefined : proof);
    let exitProof: ReturnType<typeof verifyExit> | undefined;
    resumed = createCapabilityRunnerdCodexTransport({ ...options,
      // The fixture has awaited the first real runnerd's exit. Production's
      // server must obtain the equivalent authority from its exact-box verifier.
      ...(lazy ? { freshBootstrapExitVerified: () => exitProof ??= verifyExit() }
        : !mode.startsWith("no-exit-proof-") ? { freshBootstrapExitVerified: proof } : {}),
      ...(placement.startsWith("prp-") ? { onStagedRunAttachment: async () => {} } : {}),
      prpIdentity: { ...identity, runId: "next-run", turnId: "next-turn", itemId: "next-item" },
      resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId },
      ...(placement.endsWith("external") ? { readRunnerState: read, prepareExternalRunnerState: async () => {},
        archiveExternalRunnerState: async ({ archiveKey }: { archiveKey: string }) => {
          const state = await read(); archived.push(state);
          const directory = join(root, "authority-epochs", `epoch-${archiveKey}`);
          await mkdir(directory, { recursive: true });
          await rename(runnerPath, join(directory, "runner-state.json"));
          return state;
        } } : {}),
    });
    if (mode !== "restore") {
      await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("native_runner_authority_rotation_requires_settled_state");
      expect(archived).toEqual([]);
      if (lazy) expect(verifyExit).toHaveBeenCalledTimes(mode.startsWith("exit-proof-") || mode === "no-exit-proof" ? 1 : 0);
      const quarantine = (await readdir(dirname(root))).find(name => name.startsWith(`${basename(root)}.quarantine-`));
      const preserved = quarantine ? join(dirname(root), quarantine) : root;
      expect(await readFile(join(preserved, "control-plane/control-plane-state.json"))).toEqual(controlBefore);
      expect(await readFile(join(preserved, "calls.log"), "utf8")).toBe(callsBefore);
      expect(JSON.parse(await readFile(join(preserved, "runner/runner-state.json"), "utf8"))).toEqual(saved);
      return;
    }
    expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject({ id: thread.id, sessionId: thread.sessionId });
    if (lazy) expect(verifyExit).toHaveBeenCalledOnce();
    const notifications = resumed.transport.notifications()[Symbol.asyncIterator]();
    const started = expectTurnStarted(notifications);
    const prompt = "The restored conversation owes this exact follow-up.";
    await resumed.transport.request("turn/start", { input: [{ type: "text", text: prompt }] });
    await started;
    const requests = (await readFile(requestsPath, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === "turn/start")).toMatchObject([
      { params: { input: [{ type: "text", text: prompt }] } },
    ]);
    expect(requests.filter(request => request.method === "thread/start")).toHaveLength(1);
    expect(requests.filter(request => request.method === "thread/resume")).toHaveLength(1);
    expect(JSON.parse(await readFile(controlPath, "utf8")).identity).toEqual({ ...identity, runId: "next-run", turnId: "next-turn", itemId: "next-item" });
    if (placement === "external") expect(archived).toEqual([saved]);
    console.info(JSON.stringify({ row: "real-runnerd-bootstrap", placement, reason, normalizedSessionId: identity.normalizedSessionId,
      providerSessionId: thread.sessionId, driverSessionId: thread.id, turns: 1, prompt }));
  } finally {
    await Promise.allSettled([first.transport.close(), resumed?.transport.close()]);
    await rm(root, { recursive: true, force: true });
    for (const name of await readdir(dirname(root))) if (name.startsWith(`${basename(root)}.quarantine-`))
      await rm(join(dirname(root), name), { recursive: true, force: true });
  }
}, 30_000);

// Staging class P: a follow-up's new sandbox holds no Runner control-plane
// state and no archived authority epoch for the saved session. The refusal is
// typed so the driver can tell the runtime the saved state cannot resume here.
it.each(["local", "external"] as const)("names a resume that finds no saved %s Runner state", async (placement) => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-resume-state-absent-"));
  const prepare = vi.fn(async () => {});
  try {
    const resumed = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(),
      codexCommand: fakeCodex,
      codexArgs: fakeCodexArgs(root),
      stateDirectory: root,
      prpIdentity: { runnerInstanceId: "absent-runner", environmentLeaseId: "absent-lease", runId: "follow-up-run",
        normalizedSessionId: "absent-session", turnId: "follow-up-turn", itemId: "follow-up-item" },
      resumeProviderSession: { driverSessionId: "thread-saved", providerSessionId: "provider-saved" },
      ...(placement === "external" ? {
        readRunnerState: vi.fn(async () => { throw new Error("no runner state"); }),
        prepareExternalRunnerState: prepare,
        archiveExternalRunnerState: vi.fn(async () => { throw new Error("nothing to archive"); }),
      } : {}),
    });
    const failure = await resumed.transport.request("thread/read", {}).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeRunnerResumeStateUnavailableError);
    expect(isRunnerResumeStateUnavailable(failure)).toBe(true);
    expect((failure as Error).message).toBe("PRP provider resume state is unavailable");
    await resumed.transport.close().catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
