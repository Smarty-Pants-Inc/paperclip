import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { publishLiveEvent } from "../services/live-events.js";
import { registerBudgetEnforcementWork, registerCostAccountingWork, wakeCostAccountingWork } from "../services/budget-enforcement-worker.js";

const work = vi.hoisted(() => ({
  deliver: vi.fn(), pending: vi.fn(), next: vi.fn(), reconcile: vi.fn(), accounting: vi.fn(), evaluate: vi.fn(), evaluationPending: vi.fn(),
}));
vi.mock("../services/budgets.js", () => ({
  deliverBudgetEnforcement: work.deliver,
  hasPendingBudgetEnforcement: work.pending,
  nextBudgetReconciliationAt: work.next,
  reconcileDueBudgetPolicies: work.reconcile,
  flushBudgetEvaluationWorkPage: work.evaluate,
}));
vi.mock("../services/budget-evaluation-work.js", () => ({ hasPendingBudgetEvaluation: work.evaluationPending }));
const resumeWork = vi.hoisted(() => ({ expiry: vi.fn(async (): Promise<number | null> => null),
  pendingForRun: vi.fn(async (_db: unknown, runId: string) => runId !== "run-unclaimed") }));
vi.mock("../services/budget-resume-continuation.js", () => ({ hasDeliverableBudgetResume: vi.fn(async () => false),
  hasPendingBudgetResumeForRun: resumeWork.pendingForRun, nextBudgetResumeClaimExpiryAt: resumeWork.expiry }));
vi.mock("../services/run-cost-accounting.js", () => ({ readCostAccountingWork: work.accounting }));

const tracing = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@opentelemetry/api", () => ({ trace: { getTracer: () => ({ startActiveSpan: tracing.start }) } }));

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
const subscriptions: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  tracing.start.mockImplementation((_name, _options, callback) => callback({ end: vi.fn(), setStatus: vi.fn() }));
  work.deliver.mockResolvedValue(undefined);
  work.pending.mockResolvedValue(false);
  work.next.mockResolvedValue(null);
  work.reconcile.mockResolvedValue({ nextCursor: null });
  work.accounting.mockResolvedValue({ pending: false, nextRunAt: null });
  work.evaluate.mockResolvedValue({ consumed: 0, nextCursor: null });
  work.evaluationPending.mockResolvedValue(false);
});
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  for (const c of coordinators.splice(0)) await c.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup() {
  const execute = vi.fn(async () => [{ xid: "42", status: "committed" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: unknown) => Promise<unknown>): Promise<unknown> {
    return callback({ execute, transaction: owner.transaction });
  } });
  const onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  coordinators.push(coordinator);
  return { owner, db: owner as unknown as Db, coordinator, onError };
}

describe("budget accounting delivery", () => {
  // H1 review: budget-resume claims are delivered by the always-on budget
  // worker, after the pass's Stop delivery, independent of scheduled agent work.
  it("delivers budget-resume continuations after Stop delivery in each pass", async () => {
    const s = setup();
    const order: string[] = [];
    work.deliver.mockImplementation(async () => { order.push("stops"); });
    const deliverResumeContinuations = vi.fn(async () => { order.push("continuations"); });
    await registerBudgetEnforcementWork(s.db, s.coordinator, { deliverResumeContinuations }).ready;
    expect(order).toEqual(["stops", "continuations"]);
  });

  it("wakes resume delivery when a run's Stop settles", async () => {
    const s = setup();
    const deliverResumeContinuations = vi.fn(async () => undefined);
    const worker = registerBudgetEnforcementWork(s.db, s.coordinator, { deliverResumeContinuations });
    await worker.ready;
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(1);
    // Another tenant's cancellation without a resume claim wakes nothing.
    publishLiveEvent({ companyId: "company-2", type: "heartbeat.run.status", payload: { runId: "run-unclaimed", status: "cancelled" } } as never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(1);
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: { runId: "run-1", status: "cancelled" } } as never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(2);
    // Stopping the worker removes the listener: later Stops wake nothing.
    await worker.stop();
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: { runId: "run-2", status: "cancelled" } } as never);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(2);
  });

  it("wakes when a failed dispatcher's resume claim goes stale", async () => {
    const s = setup();
    const expiry = Date.now() + 60_000;
    resumeWork.expiry.mockResolvedValue(expiry);
    const deliverResumeContinuations = vi.fn(async () => undefined);
    await registerBudgetEnforcementWork(s.db, s.coordinator, { deliverResumeContinuations }).ready;
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).toBe(expiry);
    resumeWork.expiry.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliverResumeContinuations).toHaveBeenCalledTimes(2);
  });

  it("continues cancellation delivery and retries a failed startup reconciliation", async () => {
    const s = setup();
    work.reconcile.mockResolvedValueOnce({ nextCursor: null, hadFailures: true });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.deliver).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: true });
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("rotates evaluation pages past failed companies before revisiting the first page", async () => {
    const s = setup();
    work.evaluate.mockResolvedValueOnce({ consumed: 0, nextCursor: "failed-company" });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.deliver).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.evaluate).toHaveBeenLastCalledWith(s.db, { cursor: "failed-company" });
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("recovers at startup, then leaves unchanged budget history completely quiet", async () => {
    const s = setup();
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.reconcile).toHaveBeenCalledWith(s.db, { startup: true });
    expect(work.deliver).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(work.pending).toHaveBeenCalledOnce();
    expect(work.reconcile).toHaveBeenCalledOnce();
    await s.owner.transaction(tx => notifyDeliveryWork(tx as object, DELIVERY_QUEUES.budgetEnforcement));
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.reconcile).toHaveBeenCalledOnce();
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("recovers a concrete policy-window deadline without polling before it", async () => {
    const s = setup();
    const due = Date.now() + 60_000;
    work.next.mockResolvedValue(new Date(due));
    work.reconcile.mockImplementation(async () => {
      if (Date.now() >= due) work.next.mockResolvedValue(null);
      return { nextCursor: null };
    });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(work.reconcile).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reconcile).toHaveBeenCalledTimes(2);
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: false });
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("retries interrupted delivery and disarms after acknowledgement", async () => {
    const s = setup();
    work.deliver.mockRejectedValueOnce(new Error("Provider stop unavailable"));
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(s.onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("continues bounded startup pages without forgetting the cursor after notifications", async () => {
    const s = setup();
    work.reconcile.mockResolvedValueOnce({ nextCursor: "company:agent:scope" });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: true });
    await s.owner.transaction(tx => notifyDeliveryWork(tx as object, DELIVERY_QUEUES.budgetEnforcement));
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: true, cursor: "company:agent:scope" });
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  // Recorded catch: the accounting recovery meter charged idle delivery passes.
  it("emits no recovery spans for 100 idle passes with nothing pending", async () => {
    const s = setup();
    const recover = vi.fn(async () => ({ scanned: 0, accounted: 0, changed: 0, failed: 0 }));
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    for (let pass = 1; pass < 100; pass++) {
      worker.wake();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(recover).toHaveBeenCalledTimes(100);
    expect(tracing.start).not.toHaveBeenCalled();
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("keeps an unchanged held partial quiet until its deadline, but a new receipt wakes settlement immediately", async () => {
    const s = setup();
    const due = Date.now() + 60_000;
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: due });
    const recover = vi.fn(async () => ({ scanned: 0, accounted: 0, changed: 0, failed: 0 }));
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(recover).toHaveBeenCalledOnce();
    expect(work.accounting).toHaveBeenCalledOnce();
    expect(tracing.start).not.toHaveBeenCalled();
    expect(s.coordinator.nextWakeAt()).toBe(due);
    recover.mockResolvedValue({ scanned: 1, accounted: 1, changed: 1, failed: 0 });
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: null });
    await s.owner.transaction(tx => notifyDeliveryWork(tx as object, DELIVERY_QUEUES.accounting));
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(tracing.start).toHaveBeenCalledTimes(1);
    expect(tracing.start.mock.calls[0][0]).toBe("budget.accounting.recover");
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it.each([
    { scanned: 1, accounted: 0, changed: 0, failed: 0 },
    { scanned: 0, accounted: 0, changed: 0, failed: 0 },
  ])("does not trace a no-op reconciliation even after candidate selection: %j", async result => {
    const s = setup();
    const worker = registerCostAccountingWork(s.db, s.coordinator, async () => result);
    subscriptions.push(worker.stop);
    await worker.ready;
    expect(tracing.start).not.toHaveBeenCalled();
  });

  it.each([
    { scanned: 0, accounted: 0, changed: 1, failed: 0 }, // spool/service/marker repair
    { scanned: 1, accounted: 0, changed: 0, failed: 1 }, // contained per-item failure
  ])("traces accounting progress or a contained failure: %j", async result => {
    const s = setup();
    const worker = registerCostAccountingWork(s.db, s.coordinator, async () => result);
    subscriptions.push(worker.stop);
    await worker.ready;
    expect(tracing.start).toHaveBeenCalledTimes(1);
  });

  it("traces thrown recovery failures and still schedules their retry", async () => {
    const s = setup();
    const error = new Error("recovery unavailable");
    const recover = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ changed: 0, failed: 0 });
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    expect(s.onError).toHaveBeenCalledWith(error, DELIVERY_QUEUES.accounting);
    expect(tracing.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(tracing.start).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("waits on an interrupted-service deadline and wakes terminal accounting from committed events", async () => {
    const s = setup();
    const recover = vi.fn(async () => {});
    const due = Date.now() + 120_001;
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: due });
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledOnce();
    publishLiveEvent({ companyId: "company", type: "heartbeat.run.status", payload: { status: "succeeded" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(due - Date.now());
    expect(recover).toHaveBeenCalledTimes(3);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(work.accounting).toHaveBeenCalledTimes(3);
  });

  // A sandbox stop or lease release can close a remote run's lost receipt.
  it.each([DELIVERY_QUEUES.environmentCleanup, DELIVERY_QUEUES.retainedNativeSessionCleanup])(
    "wakes accounting when %s work commits", async queue => {
      const s = setup();
      const recover = vi.fn(async () => {});
      const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
      subscriptions.push(worker.stop);
      await worker.ready;
      const before = recover.mock.calls.length;
      await s.owner.transaction(tx => notifyDeliveryWork(tx as object, queue));
      await vi.advanceTimersByTimeAsync(1);
      expect(recover.mock.calls.length).toBeGreaterThan(before);
      worker.stop();
      const stopped = recover.mock.calls.length;
      await s.owner.transaction(tx => notifyDeliveryWork(tx as object, queue));
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledTimes(stopped);
    });

  it("replays durable spool work after a pre-transaction failure and releases its local wake on stop", async () => {
    const s = setup();
    const recover = vi.fn(async () => {});
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    wakeCostAccountingWork(s.db);
    wakeCostAccountingWork(s.db);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    worker.stop();
    wakeCostAccountingWork(s.db);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });
});
