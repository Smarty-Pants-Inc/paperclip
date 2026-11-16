import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PiEnvironmentProbeCleanupError } from "../drivers/pi/pi-environment-probe.js";
import { NativeEnvironmentProbeCleanupError, probeNativeRunnerEnvironment } from "./runnerd-codex-transport.js";

const { retirePiSession } = vi.hoisted(() => ({ retirePiSession: vi.fn() }));
vi.mock("../drivers/pi/pi-environment-probe.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../drivers/pi/pi-environment-probe.js")>();
  return { ...actual, probePiNativeEnvironment: retirePiSession };
});

afterEach(() => {
  retirePiSession.mockReset();
  vi.useRealTimers();
});

it.each([
  { retirementMs: 15_000, succeeds: true },
  { retirementMs: 70_000, succeeds: false },
])("uses the native setup probe's default Pi retirement budget ($retirementMs ms)", async ({ retirementMs, succeeds }) => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "native-pi-retirement-budget-"));
  const retired = Promise.withResolvers<void>();
  const operationError = new Error("Pi setup operation failed");
  const cleanupError = new Error("Pi retirement is still pending");
  const piFailure = new PiEnvironmentProbeCleanupError(retired.promise, operationError, cleanupError, () => retired.promise);
  setTimeout(() => retired.resolve(), retirementMs);
  retirePiSession.mockRejectedValue(piFailure);

  try {
    const probe = probeNativeRunnerEnvironment({
      runtimeDirectory: root,
      provider: "pi_rpc",
      model: "fixture-model",
      environment: {},
      timeoutMs: 120_000,
      // Deliberately no cleanupTimeoutMs: this matches the server's pi_rpc call.
    }).catch(error => error);

    // Let the Pi failure reach the native setup probe's teardown path.
    await vi.advanceTimersByTimeAsync(0);
    const result = probe;
    await vi.advanceTimersByTimeAsync(retirementMs);
    const failure = await result;
    let retainedCompletion: Promise<void> | undefined;

    if (succeeds) {
      // Pi's own short cleanup bound reports its pending retirement, but the
      // native setup wrapper must join it instead of adding a cleanup failure.
      expect(failure).toBeInstanceOf(PiEnvironmentProbeCleanupError);
      expect(failure).not.toBeInstanceOf(NativeEnvironmentProbeCleanupError);
    } else {
      expect(failure).toBeInstanceOf(NativeEnvironmentProbeCleanupError);
      expect(failure.operationError).toBeInstanceOf(PiEnvironmentProbeCleanupError);
      expect(failure.message).toContain("joining native Pi retirement");
      retainedCompletion = failure.retired.then(() => undefined, () => undefined);
    }

    // Finish or observe retained retirement so the proof has no unhandled work.
    retired.resolve();
    await retainedCompletion;
  } finally {
    retired.resolve();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
