import { describe, expect, it } from "vitest";
import {
  providerResourceDispositionForTerminalRun,
  resolveNativeSandboxLifecycle,
  resolveReusableSandboxLifecycle,
} from "../services/heartbeat.js";

const reusableSandbox = {
  kind: "remote" as const,
  transport: "sandbox",
  reusableLeaseConfigured: true,
  effectiveCapabilities: { reusableLeases: true },
};

describe("paperclip_runner sandbox lifecycle", () => {
  it("keeps a warm reusable sandbox running", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "warm",
      sandboxResource: "keep_running",
      failoverBackup: "verified",
    });
  });

  it("keeps the same warm reusable sandbox for a legacy adapter", () => {
    expect(
      resolveReusableSandboxLifecycle({
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "warm",
      sandboxResource: "keep_running",
      failoverBackup: "verified",
    });
  });

  it("stops and reuses a per-turn reusable sandbox", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: reusableSandbox,
      }),
    ).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "stop_and_reuse",
      failoverBackup: "verified",
    });
  });

  it("destroys a per-turn disposable sandbox", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: {
          ...reusableSandbox,
          reusableLeaseConfigured: false,
        },
      }),
    ).toEqual({
      runnerProcess: "per_turn",
      sandboxResource: "destroy_after_turn",
      failoverBackup: "verified",
    });
  });

  it("rejects warm mode without an effective reusable-lease capability", () => {
    expect(() =>
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
        target: {
          ...reusableSandbox,
          effectiveCapabilities: { reusableLeases: false },
        },
      }),
    ).toThrow("runner_warm_lifecycle_requires_reusable_provider_lease");
  });

  it("leaves legacy and non-sandbox targets untouched", () => {
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "codex_local",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: reusableSandbox,
      }),
    ).toBeNull();
    expect(
      resolveNativeSandboxLifecycle({
        adapterType: "paperclip_runner",
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        target: { kind: "local" },
      }),
    ).toBeNull();
  });

  it("keeps a selected warm sandbox after ordinary terminal outcomes", () => {
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "succeeded"),
    ).toBe("keep_running");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "failed", "adapter_failed"),
    ).toBe("keep_running");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "cancelled"),
    ).toBe("keep_running");
    expect(
      providerResourceDispositionForTerminalRun("keep_running", "timed_out"),
    ).toBe("stop_and_retain");
    expect(providerResourceDispositionForTerminalRun("keep_running", "interrupted")).toBe("keep_running");
    expect(providerResourceDispositionForTerminalRun("keep_running", "failed", "native_session_interrupted")).toBe("keep_running");
    expect(providerResourceDispositionForTerminalRun("destroy", "failed")).toBe("destroy");
    expect(providerResourceDispositionForTerminalRun("stop_and_retain", "failed", "adapter_failed")).toBe("stop_and_retain");
  });

  it("stops a selected warm sandbox only for a never-started adapter_failed preparation", () => {
    expect(providerResourceDispositionForTerminalRun("keep_running", "failed", "adapter_failed", false)).toBe("stop_and_retain");
    for (const workStarted of [undefined, null, true, "false", 0, {}]) {
      expect(providerResourceDispositionForTerminalRun("keep_running", "failed", "adapter_failed", workStarted)).toBe("keep_running");
    }
    expect(providerResourceDispositionForTerminalRun("destroy", "failed", "adapter_failed", false)).toBe("destroy");
    expect(providerResourceDispositionForTerminalRun(undefined, "failed", "adapter_failed", false)).toBeUndefined();
    expect(providerResourceDispositionForTerminalRun("keep_running", "cancelled", "adapter_failed", false)).toBe("keep_running");
    expect(providerResourceDispositionForTerminalRun("keep_running", "interrupted", "native_session_interrupted", false)).toBe("keep_running");
  });

  it.each(["native_restart_recovery_blocked", "native_continuation_requires_reconciliation",
    "native_event_replay_conflict", "native_session_cleanup_quarantined", "lease_released_before_terminal", "unknown_failure"])(
    "does not earn warm retention for an untrusted or unclassified failure: %s", errorCode => {
      expect(providerResourceDispositionForTerminalRun("keep_running", "failed", errorCode)).toBe("stop_and_retain");
    },
  );

  it.each(["running", "queued", "scheduled_retry", null, undefined])("does not retain an unsettled turn: %s", status => {
    expect(providerResourceDispositionForTerminalRun("keep_running", status)).toBe("stop_and_retain");
  });
});
