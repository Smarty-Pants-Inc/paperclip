// Fork-only regression ports; upstream intentionally deleted the stock suite.
import { sandboxRestartMetadata } from "../sandbox-snapshot-restore.js";
import { describe, expect, it, vi } from "vitest";
import { inspectRemoteWarmSessionRecovery, isSettledRemoteWarmControlState } from "./remote-warm-session-recovery.js";

const identity = { runId: "run", normalizedSessionId: "session", runnerInstanceId: "runner", environmentLeaseId: "lease", turnId: "turn", itemId: "item" };

const terminal = { eventType: "run.terminal", envelope: { ...identity } };

const goal = { schema: "paperclip.session_goal.snapshot.v1", goal: null, workingNow: false };

const notification = { schema: "paperclip.prp.event.v1", eventType: "session.goal.snapshot", runId: identity.runId,
  normalizedSessionId: identity.normalizedSessionId, sourceInstanceId: "runner", sourceKind: "runner", payload: goal };

const snapshot = { eventType: "session.goal.snapshot", envelope: { ...identity, payload: notification } };

const state = (events: unknown[]) => ({ identity, commands: [{ status: "completed" }], committedEvents: events });

describe("process loss skips live adoption without changing session identity", () => {
  it("never transfers another allocation's restart receipt or handled generation", () => {
    const first = "2026-11-25T12:00:00.000Z";
    const lease = { providerLeaseId: "box-a", metadata: { rebootedAt: first,
      handledProcessRestartKey: JSON.stringify([null, first]) } };
    expect(sandboxRestartMetadata(lease, { providerLeaseId: "box-b" })).toEqual({});
    expect(sandboxRestartMetadata(lease, { providerLeaseId: "box-b", metadata: { rebootedAt: first } }))
      .toEqual({ rebootedAt: first });
  });

  it.each(["restoredFromSnapshotAt", "rebootedAt", "healthy", "handled", "new-generation"] as const)("steps aside only for a process-loss signal: %s", async signal => {
    const select = vi.fn(() => { throw new Error("ordinary_live_adoption_probe"); });
    const input = {
      db: { select }, execution: { binding: { runId: "next-run" }, session: { normalizedSessionId: identity.normalizedSessionId } },
      target: { kind: "remote", transport: "sandbox", leaseId: "lease", environmentId: "environment", providerKey: "boat",
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "same-box",
          ...(signal === "healthy" ? {} : signal === "handled" || signal === "new-generation"
            ? { rebootedAt: signal === "handled" ? "2026-11-25T12:00:00.000Z" : "2026-11-25T13:00:00.000Z",
                handledProcessRestartKey: JSON.stringify([null, "2026-11-25T12:00:00.000Z"]) }
            : { [signal]: "2026-11-25T12:00:00.000Z" }) } },
      identity, readControlState: vi.fn(), matchesExecution: vi.fn(), loadCheckpoint: vi.fn(), canReuseProcess: vi.fn(),
    };
    const inspect = () => inspectRemoteWarmSessionRecovery(input as unknown as Parameters<typeof inspectRemoteWarmSessionRecovery>[0]);
    if (signal === "healthy" || signal === "handled") { await expect(inspect()).rejects.toThrow("ordinary_live_adoption_probe"); expect(select).toHaveBeenCalledOnce(); }
    else { expect(await inspect()).toBeNull(); expect(select).not.toHaveBeenCalled(); }
    expect(input.execution.session.normalizedSessionId).toBe("session");
    expect(input.loadCheckpoint).not.toHaveBeenCalled();
  });
});

describe("settled remote warm control evidence", () => {
  const completed = { eventType: "turn.completed", envelope: { ...identity, payload: {
    ...notification, eventType: "turn.completed", payload: {},
  } } };

  it("accepts a completed turn only with explicit finalized Pi conversation authority", () => {
    expect(isSettledRemoteWarmControlState(state([completed]), identity)).toBe(false);
    expect(isSettledRemoteWarmControlState(state([completed]), identity, true)).toBe(true);
    expect(isSettledRemoteWarmControlState(state([completed, snapshot]), identity, true)).toBe(true);
    expect(isSettledRemoteWarmControlState(state([snapshot]), identity, true)).toBe(false);
  });

  it("uses a later completed conversation turn after a Runner terminal, but holds unfinished work and tasks", () => {
    const started = { eventType: "turn.started", envelope: { ...identity, payload: {
      ...notification, eventType: "turn.started", payload: {},
    } } };
    expect(isSettledRemoteWarmControlState(state([terminal, started, completed]), identity, true)).toBe(true);
    expect(isSettledRemoteWarmControlState(state([terminal, started]), identity, true)).toBe(false);
    expect(isSettledRemoteWarmControlState(state([terminal, started, completed]), identity)).toBe(false);
  });

  it.each(Object.keys(identity))("authenticates the completed boundary's %s", key => {
    const foreign = { ...completed, envelope: { ...completed.envelope, [key]: "other" } };
    expect(isSettledRemoteWarmControlState(state([foreign]), identity, true)).toBe(false);
  });

  it.each([
    ["pending command", { ...state([completed]), commands: [{ type: "turn.start", status: "pending" }] }],
    ["failed suspend", { ...state([completed]), commands: [{ type: "runner.suspend", status: "failed" }] }],
    ["new work", state([completed, { ...snapshot, eventType: "turn.started" }])],
    ["pending request", state([completed, { ...snapshot, eventType: "runtime_request.created" }])],
    ["active goal", state([completed, { ...snapshot, envelope: { ...snapshot.envelope, payload: { ...notification, payload: { ...goal, goal: { status: "active" } } } } }])],
    ["foreign identity", { ...state([completed]), identity: { ...identity, turnId: "other" } }],
    ["missing notification", state([{ ...completed, envelope: identity }])],
    ["foreign source", state([{ ...completed, envelope: { ...completed.envelope, payload: { ...completed.envelope.payload, sourceInstanceId: "other" } } }])],
    ["control-plane source", state([{ ...completed, envelope: { ...completed.envelope, payload: { ...completed.envelope.payload, sourceKind: "control_plane" } } }])],
    ["wrong event type", state([{ ...completed, envelope: { ...completed.envelope, payload: notification } }])],
  ])("still refuses %s at the completed conversation boundary", (_name, control) => {
    expect(isSettledRemoteWarmControlState(control, identity, true)).toBe(false);
  });
});
