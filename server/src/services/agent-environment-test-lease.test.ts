import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: { id: "environment", companyId: "company", name: "plugin environment", driver: "plugin", config: { pluginId: "plugin" } },
  lease: { id: "lease", environmentId: "environment", metadata: { remoteCwd: "/workspace" } },
  acquire: vi.fn(), updateLeaseMetadata: vi.fn(), resolveTarget: vi.fn(),
}));
vi.mock("./environments.js", () => ({ environmentService: () => ({
  getById: async () => mocks.environment,
  updateLeaseMetadata: mocks.updateLeaseMetadata,
  releaseLease: vi.fn(),
}) }));
vi.mock("./environment-runtime.js", () => ({ environmentRuntimeService: () => ({
  acquireRunLease: mocks.acquire,
  getDriver: () => ({ releaseRunLease: vi.fn() }),
  supportsTasks: async () => true,
}) }));
vi.mock("./instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));
vi.mock("./plugin-environment-driver.js", () => ({ pluginEnvironmentRequiresAgent: async () => false }));
vi.mock("./environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: mocks.resolveTarget }));

import { agentEnvironmentTestService } from "./agent-environment-test.js";

describe("plugin Runner setup-test lease", () => {
  it("requests a lease that outlives the probe and its unbounded sync-out + rm teardown (>= 600 s)", async () => {
    mocks.acquire.mockResolvedValue({ lease: { ...mocks.lease } });
    mocks.updateLeaseMetadata.mockResolvedValue({ ...mocks.lease, metadata: { remoteCwd: "/workspace", runnerTaskProbe: {} } });
    mocks.resolveTarget.mockResolvedValue({ kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: "/workspace", runnerTaskProbe: { runId: "run", sessionId: "session" }, runnerTask: vi.fn() });
    const service = agentEnvironmentTestService({} as never);
    const before = Date.now();
    const result = await service.resolveAdapterTestExecutionContext({ companyId: "company", adapterType: "paperclip_runner", environmentId: "environment" });
    expect(result.fallbackChecks).toEqual([]);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company", adapterType: "paperclip_runner",
      requestedExpiresAt: expect.any(Date),
    }));
    const requestedExpiresAt = mocks.acquire.mock.calls[0]![0].requestedExpiresAt as Date;
    expect(requestedExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
  });
});
