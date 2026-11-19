import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import * as runEvents from "../heartbeat-run-events.js";
import { logger } from "../../middleware/logger.js";
import { recordWarmRetentionProbe } from "./warm-retention-probe.js";
import { proveHandedOffWarmLeases } from "./handed-off-warm-lease.js";

// Only the remote stop/prove boundary is simulated. Selection, proof decisions,
// evidence persistence and the diagnostic recorder are the production functions.
const remote = vi.hoisted(() => ({ prove: vi.fn(async () => true) }));
vi.mock("./native-session-executor.js", () => ({
  handedOffWarmOwnerRunnerExited: remote.prove,
  handedOffWarmOwnerProofUnavailable: () => false,
}));

afterEach(async () => { await flushProbeTasks(); vi.restoreAllMocks(); remote.prove.mockClear(); });

function fixture(retained = true, retentionDecision: boolean | null = null) {
  const id = randomUUID(), companyId = randomUUID(), agentId = randomUUID(), nativeIssueId = randomUUID();
  const run = { id, companyId, nativeIssueId, status: "cancelled", runtimeMode: "native",
    runnerProfileJson: { nativeResourceDisposition: "keep_running" },
    resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: id, companyId,
      issueId: nativeIssueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
      dispatched: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } } as const;
  const lease = { id: randomUUID(), heartbeatRunId: id, companyId, agentId, provider: "daytona", providerLeaseId: randomUUID(),
    status: retained ? "retained" : "released", releasedAt: retained ? null : new Date(),
    leasePolicy: "reuse_by_environment", metadata: {} };
  const reads: unknown[] = [];
  const update = vi.fn(async () => []);
  const db = { select: vi.fn(() => ({ from: (table: unknown) => {
    reads.push(table);
    const rows = table === environmentLeases ? [lease] : table === heartbeatRuns ? [{ agentId }]
      : retentionDecision === null ? [] : [{ payload: { retained: retentionDecision } }];
    const query = { where: () => query, orderBy: () => query, limit: async () => rows,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  } })), update: () => ({ set: () => ({ where: update }) }) } as unknown as Db;
  return { db, run, lease, reads, update, input: { companyId, runId: id, agentId, predecessorRunId: null, leaseId: lease.id } };
}

// Five phases can be serialized behind the first. Flush real task turns, not
// microtasks; production decisions never await this test-only observation helper.
async function flushProbeTasks() {
  for (let turn = 0; turn <= 5; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function within<T>(work: Promise<T>, ms = 100): Promise<T | "blocked by diagnostic"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<"blocked by diagnostic">(resolve => {
    timer = setTimeout(() => resolve("blocked by diagnostic"), ms);
  })]); } finally { clearTimeout(timer); }
}

describe("warm-retention diagnostics cannot backpressure decisions", () => {
  it.each([true, false, null].flatMap(retainedInCancel => [true, false].map(runnerStopProven => ({ retainedInCancel, runnerStopProven }))))(
    "runner-stop truth preserves unknown retention: %j", async ({ retainedInCancel, runnerStopProven }) => {
      const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockResolvedValue({} as never);
      const subject = fixture(true, retainedInCancel);
      recordWarmRetentionProbe(subject.db, subject.input, { phase: "proof_runner_stop", runnerStopProven });
      await flushProbeTasks();
      expect(sink).toHaveBeenCalledOnce();
      expect(sink.mock.calls[0]![1].payload).toMatchObject({ retainedInCancel,
        stoppedRetainedRunner: retainedInCancel === null ? null : runnerStopProven && retainedInCancel });
    });

  it("a synchronously blocking sink starts only after the proof decision completes", async () => {
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockResolvedValue({} as never);
    const control = fixture();
    const baselineStarted = performance.now();
    const baseline = await proveHandedOffWarmLeases(control.db, control.run);
    const baselineMs = performance.now() - baselineStarted;
    await flushProbeTasks();
    sink.mockClear();
    sink.mockImplementation(() => {
      const until = performance.now() + 150;
      while (performance.now() < until) { /* Deliberately synchronous, not a held Promise. */ }
      return Promise.resolve({} as never);
    });
    const subject = fixture();
    const started = performance.now();
    const decision = await proveHandedOffWarmLeases(subject.db, subject.run);
    const decisionMs = performance.now() - started;
    try {
      process.stdout.write(`sync-probe-latency ${JSON.stringify({ baseline, decision, baselineMs, decisionMs, sinkCallsAtDecision: sink.mock.calls.length })}\n`);
      expect(decision).toBe(baseline);
      expect(sink).not.toHaveBeenCalled();
      expect(decisionMs).toBeLessThan(baselineMs + 100);
      expect(subject.update).toHaveBeenCalledOnce();
      expect(remote.prove).toHaveBeenCalledTimes(2);
    } finally { await flushProbeTasks(); }
    expect(sink).toHaveBeenCalledOnce();
  });

  it.each([true, false])("a held event sink cannot delay the existing proof decision (retained=%s)", async retained => {
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockResolvedValue({} as never);
    const control = fixture(retained);
    const started = performance.now();
    const baseline = await proveHandedOffWarmLeases(control.db, control.run);
    const baselineMs = performance.now() - started;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    sink.mockImplementation(async () => { await held; return {} as never; });
    const subject = fixture(retained);
    const heldStarted = performance.now();
    const work = proveHandedOffWarmLeases(subject.db, subject.run);
    try {
      const decision = await within(work);
      const heldMs = performance.now() - heldStarted;
      process.stdout.write(`probe-latency ${JSON.stringify({ retained, baseline, decision, baselineMs, heldMs })}\n`);
      expect(decision).toBe(baseline);
      expect(heldMs).toBeLessThan(baselineMs + 100);
      expect(subject.update).toHaveBeenCalledTimes(retained ? 1 : 0);
      expect(remote.prove).toHaveBeenCalledTimes(retained ? 2 : 0);
    } finally { release(); await work; }
  });

  it.each(["reject", "throw", "throw-and-logger-throws"] as const)("a %s sink cannot throw into the proof decision", async mode => {
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent");
    if (mode === "reject") sink.mockRejectedValue(new Error("private sink error"));
    else sink.mockImplementation(() => { throw new Error("private sink error"); });
    if (mode === "throw-and-logger-throws") vi.spyOn(logger, "warn").mockImplementation(() => { throw new Error("logger unavailable"); });
    const subject = fixture();
    await expect(proveHandedOffWarmLeases(subject.db, subject.run)).resolves.toBe("proven");
    expect(subject.update).toHaveBeenCalledOnce();
    // Give detached failures task turns to surface as unhandled rejections.
    await flushProbeTasks();
  });

  it("two presses produce at most one event per phase and no synchronous DB reads", async () => {
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockResolvedValue({} as never);
    const subject = fixture();
    const phases = ["acquisition", "admission", "retention", "proof", "proof_runner_stop"] as const;
    for (let press = 0; press < 2; press++) for (const phase of phases) {
      recordWarmRetentionProbe(subject.db, subject.input, { phase });
    }
    expect(subject.reads).toHaveLength(0);
    await flushProbeTasks();
    expect(sink).toHaveBeenCalledTimes(phases.length);
    for (const phase of phases) expect(sink.mock.calls.filter(([, event]) => event.payload?.phase === phase)).toHaveLength(1);
  });

  it("two completed proof attempts still make their own decision but emit only one diagnostic", async () => {
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockResolvedValue({} as never);
    const subject = fixture();
    await expect(proveHandedOffWarmLeases(subject.db, subject.run)).resolves.toBe("proven");
    await expect(proveHandedOffWarmLeases(subject.db, subject.run)).resolves.toBe("proven");
    await flushProbeTasks();
    expect(subject.update).toHaveBeenCalledTimes(2);
    expect(remote.prove).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("a held sink bounds queued work to one write per phase even after two presses", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sink = vi.spyOn(runEvents, "appendHeartbeatRunEvent").mockImplementation(async () => { await held; return {} as never; });
    const subject = fixture();
    try {
      for (let press = 0; press < 2; press++) {
        recordWarmRetentionProbe(subject.db, subject.input, { phase: "retention", retained: true });
        recordWarmRetentionProbe(subject.db, subject.input, { phase: "proof_runner_stop", runnerStopProven: true });
      }
      await flushProbeTasks();
      expect(sink.mock.calls.length).toBeLessThanOrEqual(2);
    } finally { release(); }
    await flushProbeTasks();
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
