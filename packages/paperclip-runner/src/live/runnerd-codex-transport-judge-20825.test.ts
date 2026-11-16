// RFL judge probe 08:31Z (#20825 loop-fix judge, checks 2, 4 and 5), copied from
// Ported from RFL loopfix judge probe judge-probe-20825.test.ts. (2026-11-16).
// Binding ruling (RFL + review-fleet-2, 08:31Z): loop fix B stands an idle warm
// owner down only on the server's "owner released to idle" fact, never on "the
// attached run has a turn terminal", so a LIVE run between two turns reconnects.
// Changes from the probe, each recorded in the #20825 loopfix3 result.md:
// - "B edge" now asserts the binding outcome (turn 2 accepted on a reconnected
//   runner, 2 launches, no native_runner_idle_warm_owner_exited) instead of
//   only reporting it.
// - "headline" is split: the released owner keeps the probe's exact assertions
//   (the server releases it to idle first, as NSE does after a finished run);
//   the same shape without that release is bounded by A (one replacement retry)
//   and fails by A's name. Supersede request recorded.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const report = (tag: string, value: unknown) => appendFileSync(process.env.JUDGE_OUT ?? "/dev/null", `${tag} ${JSON.stringify(value)}\n`);
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

type Handle = durableControlPlane.RunnerProcessHandle;

async function owner(input: { replacement?: () => Handle; providerArgs?: string[]; mode?: "warm" | "per_turn";
  firstExit?: { lifecycle: string; recoverableFailure: string | null } }) {
  const directory = await mkdtemp(join(tmpdir(), "judge-probe-20825-"));
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec): Handle => {
    if (launch.mock.calls.length > 1 && input.replacement) return input.replacement();
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore" });
    children.push(child);
    exits.push(new Promise(resolveExit => child.once("exit", () => resolveExit())));
    return {
      child,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit(input.firstExit && launch.mock.calls.length >= 1 && children[0] === child
          ? { code: null, signal: null, stdout: "", stderr: `runner_remote_process_exited lifecycle=${input.firstExit.lifecycle}`,
            runnerLifecycle: input.firstExit } as durableControlPlane.RunnerProcessResult
          : { code, signal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
    };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(directory, ...(input.providerArgs ?? [])), stateDirectory: directory,
    lifecyclePolicy: (input.mode ?? "warm") === "warm" ? { mode: "warm", idleTimeoutMs: 60_000 } : { mode: "per_turn", idleTimeoutMs: null },
    runnerReconnectGraceMs: 420_000, runnerProcessLauncher: launch,
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  const opened = await bundle.transport.request("thread/start", { cwd: directory, dynamicTools: [] }) as { thread: { id: string } };
  const notifications = bundle.transport.notifications()[Symbol.asyncIterator]();
  let failure: Error | null = null;
  const cleanup = async () => {
    vi.useRealTimers();
    const providerPid = bundle.evidence().codexPid;
    if (providerPid) { try { process.kill(providerPid, "SIGKILL"); } catch {} }
    await bundle.transport.detachControllerForRestart!().catch(() => undefined);
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(exits);
    await rm(directory, { recursive: true, force: true });
  };
  const drain = () => void (async () => { for (;;) if ((await notifications.next()).done) return; })()
    .catch(error => { failure = error as Error; });
  return { opened, bundle, launch, children, exits, notifications, drain, failure: () => failure, cleanup };
}

describe("RFL judge probe 08:31Z (#20825 loop fix B)", () => {
  // Check 2: the observed loop shape (fake remote replacements that die pre-auth), 60 s fake time, exact counts.
  const preAuthReplacement = (): Handle => ({
    child: { pid: undefined, exitCode: null, kill: () => false } as never,
    completion: Promise.resolve({ code: null, signal: null, stdout: "",
      stderr: "runner_remote_process_exited lifecycle=recoverable_failure recoverableFailure=connection_refused",
      runnerLifecycle: { lifecycle: "recoverable_failure", recoverableFailure: "connection_refused" } } as durableControlPlane.RunnerProcessResult),
    isExitConfirmed: () => true,
  });

  it("headline: idle warm owner after a settled run, 60 s fake time", async () => {
    const o = await owner({ replacement: preAuthReplacement });
    try {
      await o.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Finish, then stay warm." }] });
      for (;;) if ((await o.notifications.next()).value?.method === "turn/completed") break;
      // The run finished; the server releases its warm owner to idle (NSE warm release).
      await o.bundle.transport.release!();
      o.drain();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      o.children[0]!.kill("SIGKILL");
      await o.exits[0];
      for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise(resolveTurn => setImmediate(resolveTurn));
      }
      const diagnostics = o.bundle.evidence().diagnostics;
      report("JUDGE_HEADLINE", ({ launches: o.launch.mock.calls.length,
        failure: o.failure()?.message ?? null,
        idleCode: diagnostics.filter(line => line.startsWith("native_runner_idle_warm_owner_exited")),
        reconnectLines: diagnostics.filter(line => /runner process disconnected/.test(line)).length }));
      expect(o.launch).toHaveBeenCalledTimes(1);
      expect(o.failure()?.message).toMatch(/^native_runner_idle_warm_owner_exited/);
    } finally { await o.cleanup(); }
  }, 90_000);

  // The same loop shape when the server has NOT released the owner to idle: B
  // does not stand it down, and A bounds the same-path relaunches (the first
  // runner, its replacement, one retry), then fails by A's name. Never a loop.
  it("headline, not released to idle: bounded by A, never a relaunch loop", async () => {
    const o = await owner({ replacement: preAuthReplacement });
    try {
      await o.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Finish, then stay warm." }] });
      for (;;) if ((await o.notifications.next()).value?.method === "turn/completed") break;
      o.drain();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
      o.children[0]!.kill("SIGKILL");
      await o.exits[0];
      for (let elapsed = 0; elapsed < 60_000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise(resolveTurn => setImmediate(resolveTurn));
      }
      report("JUDGE_HEADLINE_UNRELEASED", { launches: o.launch.mock.calls.length, failure: o.failure()?.message ?? null });
      expect(o.launch).toHaveBeenCalledTimes(3);
      expect(o.failure()?.message).toMatch(/^native_runner_replacement_exited_before_authentication/);
      expect(o.bundle.evidence().diagnostics.some(line => line.startsWith("native_runner_idle_warm_owner_exited"))).toBe(false);
    } finally { await o.cleanup(); }
  }, 90_000);

  // Check 4: the runner dies BETWEEN two turns of the SAME run (turn 1 settled, turn 2 not yet started).
  // Real runnerd relaunch (no fake replacement). Today: reconnect and turn 2 is accepted.
  it("B edge: runner death between two turns of the same run, then turn 2", async () => {
    const o = await owner({ providerArgs: ["--durable-turn-ids"] });
    try {
      await o.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Turn 1 of this run." }] });
      for (;;) if ((await o.notifications.next()).value?.method === "turn/completed") break;
      o.drain();
      o.children[0]!.kill("SIGKILL");
      await o.exits[0];
      const diagnostics = () => o.bundle.evidence().diagnostics;
      await vi.waitFor(() => expect(o.failure() !== null
        || diagnostics().some(line => /restored its durable PRP session/.test(line))).toBe(true), { timeout: 30_000, interval: 50 });
      let turn2: string;
      try {
        await o.bundle.transport.request("thread/resume", { threadId: o.opened.thread.id });
        await o.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Turn 2 of the same run." }] });
        turn2 = "accepted";
      } catch (error) {
        turn2 = `rejected: ${(error as Error).message.slice(0, 900)}`;
      }
      report("JUDGE_B_EDGE", { launches: o.launch.mock.calls.length,
        failure: o.failure()?.message?.slice(0, 200) ?? null, turn2 });
      // Binding ruling: a live run between two turns is never stood down.
      expect(turn2).toBe("accepted");
      expect(o.launch).toHaveBeenCalledTimes(2);
      expect(o.failure()).toBeNull();
      expect(diagnostics().some(line => line.startsWith("native_runner_idle_warm_owner_exited"))).toBe(false);
    } finally { await o.cleanup(); }
  }, 90_000);

  // Check 5: a graceful remote exit (durable lifecycle suspended, no recoverableFailure) that reaches the
  // open transport WITHOUT runner.suspending (runnerd never commits it). Real runnerd relaunch allowed.
  it.each([["per_turn", "after its turn"], ["warm", "after thread/start, before its first turn"]] as const)(
    "C real: %s owner, graceful remote exit %s", async (mode, when) => {
      const o = await owner({ mode, providerArgs: ["--durable-turn-ids"], firstExit: { lifecycle: "suspended", recoverableFailure: null } });
      try {
        if (when === "after its turn") {
          await o.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Finish this turn." }] });
          for (;;) if ((await o.notifications.next()).value?.method === "turn/completed") break;
        }
        o.drain();
        o.children[0]!.kill("SIGKILL");
        await o.exits[0];
        await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
        report("JUDGE_C_REAL", { mode, when, launches: o.launch.mock.calls.length, failure: o.failure()?.message?.slice(0, 160) ?? null,
          restored: o.bundle.evidence().diagnostics.some(line => /restored its durable PRP session/.test(line)) });
        expect(true).toBe(true);
      } finally { await o.cleanup(); }
    }, 90_000);
});
