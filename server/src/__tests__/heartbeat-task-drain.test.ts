import { afterEach, describe, expect, it, vi } from "vitest";
import { allowTaskDrainRun, consumeTaskDrainRun, setControllerLeaseQuiesce } from "../services/task-admission.js";
import {
  getTaskDrainStatus,
  resolveHeartbeatSchedulingSuppression,
  startTaskDrain,
  stopTaskDrain,
} from "../services/heartbeat.ts";

describe("heartbeat task drain", () => {
  afterEach(() => {
    stopTaskDrain();
    setControllerLeaseQuiesce(false);
    vi.useRealTimers();
  });

  it("start_task_drain_suppresses_admission", () => {
    startTaskDrain({});
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });
  });

  // Pure admission-state guard: an exact-run capability must never turn into
  // authority for another run, another drain, or another suppression class.
  it("allows only the selected run once, without bypassing other suppression", () => {
    const drain = startTaskDrain();
    expect(allowTaskDrainRun("selected", drain)).toBe(true);
    expect(allowTaskDrainRun("other", drain)).toBe(false);
    expect(resolveHeartbeatSchedulingSuppression({}, { runId: "selected" }).suppressed).toBe(false);
    expect(resolveHeartbeatSchedulingSuppression({}, { runId: "other" }).suppressed).toBe(true);
    expect(resolveHeartbeatSchedulingSuppression({}).suppressed).toBe(true);
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_IN_WORKTREE: "1" }, { runId: "selected" }).reason).toBe("worktree_instance");
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" }, { runId: "selected" }).reason).toBe("database_restore_in_progress");
    setControllerLeaseQuiesce(true);
    expect(resolveHeartbeatSchedulingSuppression({}, { runId: "selected" }).suppressed).toBe(true);
    setControllerLeaseQuiesce(false);
    consumeTaskDrainRun("selected");
    expect(resolveHeartbeatSchedulingSuppression({}, { runId: "selected" }).suppressed).toBe(true);
    expect(allowTaskDrainRun("selected", drain)).toBe(true);
    startTaskDrain();
    expect(resolveHeartbeatSchedulingSuppression({}, { runId: "selected" }).suppressed).toBe(true);
    expect(allowTaskDrainRun("selected", drain)).toBe(false);
  });

  it("stop_task_drain_restores_admission", () => {
    startTaskDrain({});
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(stopTaskDrain()).toEqual({ wasActive: false });
  });

  it("null_ttl_produces_no_expiry", () => {
    const { expiresAt } = startTaskDrain({ ttlMs: null });
    expect(expiresAt).toBeNull();
    expect(getTaskDrainStatus().expiresAt).toBeNull();
  });

  it("an_expired_ttl_ends_the_drain_and_restores_admission", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    startTaskDrain({ ttlMs: 1000 });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: true,
      reason: "task_drain",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.001Z"));
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
    expect(getTaskDrainStatus().draining).toBe(false);
  });

  it("status_reports_quiescent_when_both_promise_sets_are_empty", () => {
    startTaskDrain({});
    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);
  });

});
