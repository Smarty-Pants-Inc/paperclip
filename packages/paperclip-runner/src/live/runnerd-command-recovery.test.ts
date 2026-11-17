// F-04G: a durable pending turn belongs to the command, not its old runner PID.
import { afterEach, expect, it, vi } from "vitest";
import { waitForRunnerCommand } from "./runnerd-codex-transport.js";
afterEach(() => vi.useRealTimers());

function wait(overrides: Record<string, unknown> = {}) {
  return waitForRunnerCommand({ type: "turn.start", deadline: Date.now() + 1_000,
    abortOnClose: true, isClosed: () => false, throwIfFailed: () => {},
    command: () => ({ status: "pending" }), runnerHasExited: async () => true,
    runnerRecoveryPending: () => true, failureCode: () => "provider_transport_failed",
    ...overrides,
  });
}

it("waits for the same pending durable turn during confirmed-exit recovery, without a false failure", async () => {
  vi.useFakeTimers();
  let status = "pending";
  const result = wait({ command: () => ({ status }) }).then(() => "accepted", e => e.message);
  await vi.advanceTimersByTimeAsync(250);
  status = "completed";
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toBe("accepted");
});

it.each(["session.open", "runner.drain"])("does not turn %s process loss into turn recovery", async type => {
  await expect(wait({ type })).rejects.toThrow(`runnerd exited while waiting for ${type}`);
});

it("still reports command rejection during recovery", async () => {
  await expect(wait({ command: () => ({ status: "failed", result: { reason: "provider refused" } }) }))
    .rejects.toThrow("PRP command turn.start failed");
});

it("does not retain a turn without restart authority", async () => {
  await expect(wait({ runnerRecoveryPending: () => false })).rejects.toThrow("runnerd exited while waiting");
});

it("reports recovery failure instead of masking it", async () => {
  await expect(wait({ throwIfFailed: () => { throw new Error("transport_reconnect_grace_exceeded"); } }))
    .rejects.toThrow("transport_reconnect_grace_exceeded");
});

it("retains the original command deadline during recovery", async () => {
  vi.useFakeTimers();
  const result = wait().catch(e => e.message);
  await vi.advanceTimersByTimeAsync(1_001);
  expect(await result).toBe("provider_transport_failed: PRP command turn.start timed out");
});

it("honors Close during recovery", async () => {
  await expect(wait({ isClosed: () => true })).rejects.toThrow("transport closed while waiting");
});
