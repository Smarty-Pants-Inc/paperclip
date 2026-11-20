import { afterEach, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { logRecoveryCoordinatorGate, registerScopedDeadlineWork } from "../services/scoped-deadline-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(gate: "warmStandby" | "idleTaskDrain" | "schedulerStopped" | "taskDrain" = "warmStandby") {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  let task: Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];
  const coordinator = { register: (_queue: unknown, registered: typeof task) => {
    task = registered;
    return { ready: Promise.resolve(), wake() {}, async stop() { registered.onStop?.(); } };
  } } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
  const gates = { warmStandby: false, idleTaskDrain: false, schedulerStopped: false, taskDrain: false };
  gates[gate] = true;
  const canRun = Object.assign(() => !Object.values(gates).some(Boolean), {
    recoveryDiagnostics: () => ({ ...gates, enabled: true, schedulingSuppressed: false, issueCreatedAtGte: null }),
  });
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.strandedAssignments,
    decodeScope: () => undefined,
    matches: () => true,
    load: async () => [{ id: "issue-1", companyId: "company-1", dueAt: 0 },
      { id: "issue-2", companyId: "company-1", dueAt: 0 }],
    check: async () => null,
  }, canRun);
  return { info, worker, coordinator, task: () => task!, resume: () => { gates[gate] = false; } };
}

it("names a blocked gate, reports pass counts, and shares a 60-second worker rate limit", async () => {
  const f = fixture();
  try {
    expect(f.task().nextRunAt?.()).toBe(130_000);
    expect(f.info).toHaveBeenCalledWith(expect.objectContaining({ queue: "stranded-assignments", phase: "poll-blocked",
      canRun: false, warmStandby: true, idleTaskDrain: false, schedulerStopped: false, taskDrain: false }), "[recovery-diag]");
    f.task().nextRunAt?.();
    await vi.advanceTimersByTimeAsync(59_999);
    f.task().nextRunAt?.();
    expect(f.info).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    f.resume();
    await f.task().run(new AbortController().signal);
    expect(f.info).toHaveBeenCalledTimes(2);
    expect(f.info).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "pass-completed", enabled: true,
      schedulingSuppressed: false, dueEntryCount: 2, checksRunThisPass: 2, scopeFailures: [], entryFailures: [],
      lastCompletedPassAgoMs: null }), "[recovery-diag]");
    f.worker.invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    await f.task().run(new AbortController().signal);
    expect(f.info).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_000);
    f.worker.invalidate();
    await f.task().run(new AbortController().signal);
    expect(f.info).toHaveBeenLastCalledWith(expect.objectContaining({ checksRunThisPass: 2,
      lastCompletedPassAgoMs: 59_000 }), "[recovery-diag]");
  } finally { await f.worker.stop(); }
});

it.each(["warmStandby", "idleTaskDrain", "schedulerStopped", "taskDrain"] as const)("names the %s gate without dispatching checks", async gate => {
  const f = fixture(gate);
  try {
    await f.task().run(new AbortController().signal);
    expect(f.info).toHaveBeenCalledWith(expect.objectContaining({ phase: "pass-blocked", canRun: false,
      [gate]: true, checksRunThisPass: 0 }), "[recovery-diag]");
  } finally { await f.worker.stop(); }
});

it("observes a coordinator-blocked poll, uses the same limiter, and removes the observer on stop", async () => {
  const f = fixture();
  try {
    logRecoveryCoordinatorGate({}, { warmStandby: true, idleTaskDrain: false });
    expect(f.info).not.toHaveBeenCalled();
    logRecoveryCoordinatorGate(f.coordinator, { warmStandby: true, idleTaskDrain: null });
    f.task().nextRunAt?.();
    expect(f.info).toHaveBeenCalledTimes(1);
    expect(f.info).toHaveBeenCalledWith(expect.objectContaining({ phase: "coordinator-blocked", warmStandby: true }), "[recovery-diag]");
    await f.worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    logRecoveryCoordinatorGate(f.coordinator, { warmStandby: true });
    expect(f.info).toHaveBeenCalledTimes(1);
  } finally { await f.worker.stop(); }
});

it("never turns a logger failure into a recovery failure", async () => {
  const f = fixture();
  f.resume();
  f.info.mockImplementation(() => { throw new Error("logger unavailable"); });
  try {
    await expect(f.task().run(new AbortController().signal)).resolves.toBeUndefined();
    expect(f.worker.reconciliationSnapshot().reconciled).toBe(true);
    expect(f.task().nextRunAt?.()).toBeNull();
  } finally { await f.worker.stop(); }
});

it("reports failed scopes and their backoff without logging error text", async () => {
  const f = fixture();
  f.resume();
  const task = f.task();
  // Exercise a scope load failure using a second real scoped worker.
  let failingTask: typeof task;
  const coordinator = { register: (_q: unknown, registered: typeof task) => {
    failingTask = registered;
    return { ready: Promise.resolve(), wake() {}, async stop() { registered.onStop?.(); } };
  } } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
  const worker = registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.strandedAssignments, decodeScope: () => undefined, matches: () => true,
    load: async () => { throw new Error("DO NOT LOG private error details"); }, check: async () => null,
  }, () => true);
  try {
    await expect(failingTask!.run(new AbortController().signal)).rejects.toThrow("could not settle");
    expect(f.info).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "pass-failed", checksRunThisPass: 0,
      scopeFailures: [{ scope: "*", count: 1, retryAt: 130_000, backoffMs: 30_000 }] }), "[recovery-diag]");
    expect(JSON.stringify(f.info.mock.calls)).not.toContain("private error");
  } finally { await worker.stop(); await f.worker.stop(); }
});
