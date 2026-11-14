import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunPreparationDeadline, enterRunPreparationPhase, RunPreparationStalledError,
  RUN_PREPARATION_DEADLINE_MS } from "../services/execution-preparation-deadline.js";
import { createRunPreparationTiming, measureRunPhase, withRunExecutionTiming } from "../services/execution-preparation-timing.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

function deadline(runId = "run-1", enabled = true) {
  const controller = new AbortController();
  const onExpired = vi.fn(async (_error: RunPreparationStalledError) => {});
  return { controller, onExpired, preparation: createRunPreparationDeadline({ runId, controller, enabled, onExpired }) };
}

describe("claim-to-dispatch preparation deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it("settles a never-returning nested phase at 45 seconds, once, without awaiting that phase", async () => {
    const { preparation, controller, onExpired } = deadline();
    const ready = Promise.withResolvers<void>();
    const pending = preparation.run(() => withRunExecutionTiming("run-1", () =>
      createRunPreparationTiming("run-1")("workspace", () => measureRunPhase("workspace.repository.lock_wait", () => ready.promise))));
    await vi.advanceTimersByTimeAsync(RUN_PREPARATION_DEADLINE_MS - 1);
    expect(onExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(controller.signal.reason).toBe(preparation.error);
    expect(preparation.error).toMatchObject({ code: "setup_preparation_stalled", phase: "workspace.repository.lock_wait", elapsedMs: 45_000 });
    expect(logger.info).toHaveBeenCalledWith({ runId: "run-1", phase: "workspace.repository.lock_wait", elapsedMs: 0 }, "heartbeat preparation phase");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onExpired).toHaveBeenCalledTimes(1);
    ready.resolve();
    await pending;
    await preparation.stop();
  });

  it("returns late resource handles to their owner, then fences the next phase and dispatch", async () => {
    const { preparation } = deadline();
    const ready = Promise.withResolvers<{ release: () => void }>();
    const release = vi.fn();
    const nextWork = vi.fn();
    const pending = preparation.run(async () => {
      const leave = enterRunPreparationPhase("run-1", "workspace_environment_acquire");
      const handle = await ready.promise;
      leave();
      // The cleanup handle must not be lost by a wrapper throwing on return.
      try { enterRunPreparationPhase("run-1", "workspace_environment_realize"); nextWork(); }
      finally { handle.release(); }
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(RunPreparationStalledError);
    await vi.advanceTimersByTimeAsync(45_000);
    ready.resolve({ release });
    await rejected;
    expect(release).toHaveBeenCalledOnce();
    expect(nextWork).not.toHaveBeenCalled();
    expect(() => preparation.dispatchStarted()).toThrow(RunPreparationStalledError);
    await preparation.stop();
  });

  it("disarms only at actual dispatch entry, not at runtime selection", async () => {
    const { preparation, onExpired, controller } = deadline();
    await preparation.run(async () => { enterRunPreparationPhase("run-1", "runtime_selection")(); });
    await vi.advanceTimersByTimeAsync(40_000);
    preparation.dispatchStarted();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    await preparation.stop();
  });

  it("fences dispatch after a starved event loop even before the timer callback gets CPU", async () => {
    const { preparation, onExpired } = deadline();
    vi.setSystemTime(Date.now() + 45_001);
    expect(() => preparation.dispatchStarted()).toThrow(RunPreparationStalledError);
    await preparation.settle();
    expect(onExpired).toHaveBeenCalledOnce();
    await preparation.stop();
  });

  it("keeps Stop and ownership-loss settlement with their existing owner", async () => {
    const { preparation, onExpired, controller } = deadline();
    const reason = new Error("ownership lost");
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(controller.signal.reason).toBe(reason);
    expect(preparation.error).toBeUndefined();
    await preparation.stop();
  });

  it("does not fence cleanup phases after preparation has stopped", async () => {
    const { preparation } = deadline();
    await vi.advanceTimersByTimeAsync(45_000);
    await preparation.stop();
    await preparation.run(async () => { expect(() => enterRunPreparationPhase("run-1", "warm_release")()).not.toThrow(); });
    // Stopping the observer is not permission to dispatch a timed-out run.
    expect(() => preparation.dispatchStarted()).toThrow(RunPreparationStalledError);
  });

  it("isolates simultaneous run observers and their timers", async () => {
    const one = deadline("one");
    const two = deadline("two");
    await one.preparation.run(async () => { enterRunPreparationPhase("one", "workspace_selection"); });
    await two.preparation.run(async () => { enterRunPreparationPhase("two", "session"); });
    two.preparation.dispatchStarted();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(one.preparation.error?.phase).toBe("workspace_selection");
    expect(two.onExpired).not.toHaveBeenCalled();
    await one.preparation.stop();
    await two.preparation.stop();
  });

  it("preserves native restart attachments' existing ownership deadlines", async () => {
    const { preparation, onExpired, controller } = deadline("recovery", false);
    await preparation.run(async () => { enterRunPreparationPhase("recovery", "workspace")(); });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onExpired).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    await preparation.stop();
  });
});
