import { execFile, spawn } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createRemoteRunnerProcessLauncher } from "./native-session-executor.js";
import { createCapabilityRunnerdCodexTransport } from "@paperclipai/paperclip-runner/live";
import { defaultCapabilityRunnerdBinary, type DurablePrpControlPlane, type RunnerProcessHandle, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { fakeCodexAppServer } from "../../__tests__/helpers/native-restart.js";

it.skipIf(process.platform !== "linux").each(["idle", "mid-turn", "channel-only"] as const)(
  "handles real runnerd channel loss and SIGKILL after a healthy check (%s)", async phase => {
    const root = await mkdtemp(join(tmpdir(), "remote-disconnect-"));
    const children: ReturnType<typeof spawn>[] = [], exits: Promise<void>[] = [];
    const handles: RunnerProcessHandle[] = [];
    const times: Record<string, number | string | null> = { revision: process.env.MONPOLL_REVISION ?? "head", phase,
      socketCloseMs: null, processConfirmationMs: null, visibleStatusMs: null, nextMessageAcceptanceMs: null, recoveryMs: null };
    let killedAt = 0, healthyChecks = 0;
    let core!: DurablePrpControlPlane;
    const mark = (name: string) => { if (killedAt && times[name] === null) times[name] = Math.round((performance.now() - killedAt) * 10) / 10; };
    const launch = (spec: RunnerProcessLaunchSpec) => {
      const arg = (key: string) => spec.args[spec.args.indexOf(key) + 1]!;
      const runnerState = arg("--state-dir"), runnerId = arg("--runner-id");
      const execute = async (request: { command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => {
        const args = request.args ?? [], label = args[2];
        if (label === "paperclip-runner-launch") {
          const child = spawn("sh", ["-c", args[6]!, "paperclip-runner-child", ...args.slice(3, 6), ...args.slice(7)], {
            cwd: request.cwd, env: { PATH: process.env.PATH, HOME: root, ...request.env }, detached: true, stdio: "ignore",
          });
          children.push(child);
          exits.push(new Promise<void>(resolve => child.once("exit", () => resolve())));
          await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        }
        const observed = await new Promise<{ exitCode: number | null; signal: null; timedOut: boolean; stdout: string; stderr: string }>(resolve => {
          execFile(request.command, args, { cwd: request.cwd, env: { PATH: process.env.PATH, HOME: root }, timeout: request.timeoutMs ?? 10_000 },
            (error, stdout, stderr) => resolve({ exitCode: error ? typeof error.code === "number" ? error.code : null : 0,
              signal: null, timedOut: !!error?.killed, stdout, stderr }));
        });
        if (label === "paperclip-runner-monitor") {
          if (observed.exitCode === 0) healthyChecks++;
          if (observed.exitCode === 45) mark("processConfirmationMs");
        }
        return observed;
      };
      const handle = createRemoteRunnerProcessLauncher({
        target: { kind: "remote", transport: "sandbox", environmentId: "fixture-env", leaseId: "fixture-lease", remoteCwd: root },
        runner: { execute } as never, remoteBinary: spec.command, processIdentityPath: join(root, "runner.identity"),
        stateDirectory: runnerState, diagnosticsDirectory: join(root, "diagnostics"), runnerInstanceId: runnerId,
      })(spec);
      handles.push(handle);
      return handle;
    };
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodexAppServer,
      codexArgs: ["--state-file", join(root, "fake-codex-state.json"), "--hold-first-durable-turn", "--durable-turn-ids"], stateDirectory: root,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 }, runnerReconnectGraceMs: 30_000,
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: "synthetic-fixture" },
      runnerProcessLauncher: launch,
      controlPlaneRegistration: async authority => {
        core = authority;
        const attach = authority.attachWireConnection.bind(authority);
        authority.attachWireConnection = wire => attach({
          sendJson: value => wire.sendJson(value), close: code => wire.close(code), onJson: listener => wire.onJson(listener),
          onClose: listener => wire.onClose(error => { mark("socketCloseMs"); listener(error); }),
        });
        await authority.start();
        return { release: () => undefined };
      },
      onDiagnostic: message => { if (/restored its durable PRP session/.test(message)) mark("recoveryMs");
        if (/exited|restor|reconnect/.test(message)) mark("visibleStatusMs"); },
    });
    let pump: Promise<void> | undefined;
    let failure: unknown;
    try {
      const opened = await bundle.transport.request("thread/start", { cwd: root }) as { thread: { id: string } };
      pump = (async () => { for await (const _event of bundle.transport.notifications()) {} })().catch(error => { failure = error; mark("visibleStatusMs"); });
      if (phase === "channel-only") {
        const beforeDisconnect = healthyChecks;
        core.disconnectActiveRunner();
        await vi.waitFor(() => expect(healthyChecks).toBeGreaterThan(beforeDisconnect), { timeout: 1_000, interval: 5 });
        expect(handles).toHaveLength(1);
        expect(handles[0]!.isExitConfirmed?.()).toBe(false);
        expect(() => process.kill(handles[0]!.child.pid!, 0)).not.toThrow();
        await vi.waitFor(() => expect(core.activeRunnerConnectionCount()).toBe(1), { timeout: 5_000 });
        expect(failure).toBeUndefined();
        return;
      }
      if (phase === "mid-turn") await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Controlled held turn." }] });
      const previousChecks = healthyChecks;
      await vi.waitFor(() => expect(healthyChecks).toBeGreaterThan(previousChecks), { timeout: 20_000, interval: 5 });
      killedAt = performance.now();
      process.kill(handles[0]!.child.pid!, "SIGKILL");
      await exits[0];
      await vi.waitFor(() => expect(times.processConfirmationMs).not.toBeNull(), { timeout: 20_000, interval: 5 });
      await vi.waitFor(() => expect(times.recoveryMs).not.toBeNull(), { timeout: 20_000, interval: 10 });
      expect(core.activeRunnerConnectionCount()).toBe(1);
      expect(failure).toBeUndefined();
      const resumed = await bundle.transport.request("thread/resume", { threadId: opened.thread.id }) as { thread: { id: string } };
      expect(resumed.thread.id).toBe(opened.thread.id);
      await bundle.transport.request(phase === "idle" ? "turn/start" : "turn/steer", {
        input: [{ type: "text", text: "Continue after the controlled runner loss." }],
      });
      mark("nextMessageAcceptanceMs");
      expect(times.socketCloseMs).not.toBeNull();
      expect(handles[0]!.isExitConfirmed?.()).toBe(true);
      if (process.env.MONPOLL_REVISION !== "base") expect(times.recoveryMs).toBeLessThan(10_000);
      console.info("MONPOLL_TIMING", JSON.stringify(times));
      if (process.env.MONPOLL_TIMINGS_FILE) await appendFile(process.env.MONPOLL_TIMINGS_FILE, JSON.stringify(times) + "\n");
    } finally {
      await bundle.transport.close().catch(() => undefined);
      for (let index = 0; index < children.length; index++) {
        if (children[index]!.exitCode === null && children[index]!.signalCode === null) children[index]!.kill("SIGKILL");
        handles[index]?.requestExitVerification?.();
      }
      await Promise.all(exits);
      await Promise.all(handles.map(handle => handle.completion.catch(() => undefined)));
      await pump;
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000,
);

it("bounds ten idle monitors to two command requests per second over a real minute", async () => {
  const counters = Array.from({ length: 10 }, () => ({ probes: 0, dead: false }));
  const handles: RunnerProcessHandle[] = [];
  const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
  for (const counter of counters) {
    let nonce = "";
    const execute = async (request: { args?: string[] }) => {
      const label = request.args?.[2];
      if (label === "paperclip-runner-launch") { nonce = request.args![4]!; return ok; }
      if (label === "paperclip-runner-process-identity") return { ...ok, stdout: `${nonce}\n4321\n2026-09-06T00:00:00.000Z\nrunner-rate\n` };
      if (label === "paperclip-runner-monitor") { counter.probes++; return { ...ok, exitCode: counter.dead ? 45 : 0 }; }
      return { ...ok, exitCode: 1 };
    };
    handles.push(createRemoteRunnerProcessLauncher({
      target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
      runner: { execute } as never, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity",
      stateDirectory: "/runtime", diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: "runner-rate",
    })({ command: "/runtime/runnerd", args: [], cwd: "/workspace", environment: {} }));
  }
  try {
    await vi.waitFor(() => expect(counters.every(counter => counter.probes === 1)).toBe(true));
    const initial = counters.reduce((sum, counter) => sum + counter.probes, 0), started = performance.now();
    await new Promise(resolve => setTimeout(resolve, 61_000));
    const seconds = (performance.now() - started) / 1_000;
    const commands = counters.reduce((sum, counter) => sum + counter.probes, 0) - initial;
    console.info("MONPOLL_RATE", JSON.stringify({ runners: 10, seconds, commands, commandsPerSecond: commands / seconds }));
    expect(commands).toBeGreaterThan(0);
    expect(commands / seconds).toBeLessThanOrEqual(10 / 5);
  } finally {
    counters.forEach(counter => { counter.dead = true; });
    handles.forEach(handle => handle.requestExitVerification?.());
    await Promise.all(handles.map(handle => handle.completion));
  }
}, 75_000);
