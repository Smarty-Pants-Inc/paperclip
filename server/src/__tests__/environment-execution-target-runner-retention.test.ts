import { describe, expect, it, vi } from "vitest";
import type { EnvironmentLease } from "@paperclipai/shared";
import type { EffectiveExecutionCapabilities } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

const { config } = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("../services/environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: config }));
import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import { RetainedSandboxAbsentError } from "../services/retained-sandbox-absent-error.js";

const capabilities: EffectiveExecutionCapabilities = { reusableLeases: true, duplexCommandStream: true, runnerWebSocketIngress: true,
  nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false, independentControlCommands: false,
  incrementalSessionOutput: false, concurrentSyncOperations: false };
const environment = { id: "environment", driver: "sandbox", config: { provider: "fixture:boat", reuseLease: true, runnerIdleTimeoutMs: 900_000 } };
const lease = { id: "lease-B", companyId: "company", environmentId: "environment", heartbeatRunId: "run-B", issueId: "issue",
  executionWorkspaceId: "workspace", provider: "fixture:boat", providerLeaseId: "physical-allocation", status: "active",
  leasePolicy: "reuse_by_environment", metadata: { agentId: "agent", runnerGuardianVersion: 1 } } as unknown as EnvironmentLease;

async function fixture(options: { capabilities?: Partial<EffectiveExecutionCapabilities>; lease?: Partial<EnvironmentLease>; reuse?: boolean } = {}) {
  const selected = { ...lease, ...options.lease };
  config.mockResolvedValue({ driver: "sandbox", config: { ...environment.config, reuseLease: options.reuse ?? true } });
  const release = vi.fn(async () => ({ ...selected, status: "released", cleanupStatus: "success" } as EnvironmentLease));
  const resume = vi.fn(async () => ({ providerLeaseId: selected.providerLeaseId }));
  const select = vi.fn(), where = vi.fn();
  select.mockReturnValue({ from: () => ({ where }) });
  const runtime = { supportsSync: () => false, resolveCapabilities: async () => ({ ...capabilities, ...options.capabilities }),
    getDriver: vi.fn(() => ({ releaseRunLease: release })), resumeRunLease: resume,
  } as unknown as EnvironmentRuntimeService;
  const target = await resolveEnvironmentExecutionTarget({ db: { select } as never, companyId: "company", adapterType: "paperclip_runner",
    environment, leaseId: lease.id, lease: selected, leaseMetadata: selected.metadata, environmentRuntime: runtime });
  if (target?.kind !== "remote" || target.transport !== "sandbox") throw new Error("Expected sandbox target");
  return { target, release, resume, runtime, where, selected };
}

describe("sandbox Runner exact lease callbacks", () => {
  it.each([{ capabilities: { reusableLeases: false } }, { capabilities: { duplexCommandStream: false } }, { reuse: false },
    { lease: { id: "wrong-row" } }, { lease: { companyId: "foreign" } }, { lease: { environmentId: "foreign" } },
    { lease: { providerLeaseId: null } }, { lease: { heartbeatRunId: null } }, { lease: { executionWorkspaceId: null, issueId: null } },
    { lease: { metadata: {} } }, { lease: { status: "pending_cleanup" as const } }, { lease: { leasePolicy: "ephemeral" as const } },
  ])("withholds lifecycle without admission: %j", async options => {
    const { target } = await fixture(options);
    expect(target.runnerLeaseLifecycle).toBeUndefined();
  });

  it("does not infer guardian opt-in from reuse and duplex capabilities", async () => {
    const { target } = await fixture({ lease: { metadata: { agentId: "agent" } } });
    expect(target.runnerLeaseLifecycle).toBeDefined(); expect(target.runnerGuardian).toBeUndefined();
  });

  it("uses only the exact current B lease row and preserves the configured warm window", async () => {
    const { target, release, resume, runtime, selected } = await fixture();
    await target.runnerLeaseLifecycle!.releaseLease();
    expect(runtime.getDriver).toHaveBeenCalledWith("sandbox");
    expect(release).toHaveBeenCalledExactlyOnceWith({ environment, lease: selected, status: "released" });
    await expect(target.runnerLeaseLifecycle!.resumeLease()).resolves.toBe("resumed");
    expect(resume).toHaveBeenCalledExactlyOnceWith({ environment, lease: selected, warmRunnerIdleTimeoutMs: 900_000 });
    expect(target.runnerGuardian).toEqual({ version: 1 });
    expect(JSON.stringify(target)).not.toContain("releaseLease");
  });

  it.each([null, { ...lease, status: "pending_cleanup", cleanupStatus: "failed" },
    { ...lease, status: "released", cleanupStatus: "success", providerLeaseId: "replacement" },
    { ...lease, status: "released", cleanupStatus: "success", heartbeatRunId: "stale-run" },
  ])("does not acknowledge null, pending cleanup or changed ownership: %j", async reply => {
    const f = await fixture(); f.release.mockResolvedValueOnce(reply as never);
    await expect(f.target.runnerLeaseLifecycle!.releaseLease()).rejects.toThrow("release_unconfirmed");
  });

  it("holds a durable stop-only intent on retry; never invokes destructive release behind it", async () => {
    const f = await fixture(); f.release.mockResolvedValueOnce({ ...lease, status: "pending_cleanup" } as EnvironmentLease);
    await expect(f.target.runnerLeaseLifecycle!.releaseLease()).rejects.toThrow("unconfirmed");
    f.where.mockResolvedValueOnce([{ ...lease, status: "pending_cleanup" }]);
    await expect(f.target.runnerLeaseLifecycle!.releaseLease()).rejects.toThrow("pending_cleanup");
    expect(f.release).toHaveBeenCalledOnce();
    f.where.mockResolvedValueOnce([{ ...lease, status: "released", cleanupStatus: "success" }]);
    await expect(f.target.runnerLeaseLifecycle!.releaseLease()).resolves.toBeUndefined();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("accepts only typed retained absence, never a timeout or replacement resource", async () => {
    const f = await fixture();
    f.resume.mockRejectedValueOnce(new Error("worker timeout"));
    await expect(f.target.runnerLeaseLifecycle!.resumeLease()).rejects.toThrow("worker timeout");
    f.resume.mockResolvedValueOnce({ providerLeaseId: "replacement" });
    await expect(f.target.runnerLeaseLifecycle!.resumeLease()).rejects.toThrow("allocation_mismatch");
    f.resume.mockRejectedValueOnce(new RetainedSandboxAbsentError());
    await expect(f.target.runnerLeaseLifecycle!.resumeLease()).resolves.toBe("unavailable");
  });
});
