import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkerBoundLoginPtyOpener as deviceOpener, sessionLoginHomePath } from "../services/device-login-service.js";
import { createWorkerBoundLoginPtyOpener as setupOpener } from "../services/setup-token-transport-binding.js";
import { buildLoginLeaseAcquireArgs } from "../services/adapter-login-lease.js";

// No login is performed; the worker dispatch is the observed boundary.
describe("S fresh-only login exclusions", () => {
  it.each(["device", "setup"] as const)("%s refuses any id other than this flow's acquired allocation", async flow => {
    const openLoginPtySession = vi.fn();
    const lease = { id: "fresh-row", providerLeaseId: "fresh-box", metadata: { pluginId: "plugin", provider: "fixture" } };
    const open = async () => {
      const opener = flow === "device"
        ? await deviceOpener({ workerManager: { openLoginPtySession } })({
          companyId: "company", environmentId: "environment", adapterType: "codex_local", providerLeaseId: "old-box",
          lease: lease as never, environment: { id: "environment", driver: "sandbox" } as never,
          sessionHome: sessionLoginHomePath(randomUUID()),
        })
        : await setupOpener({ workerManager: { openLoginPtySession }, environments: { getLeaseById: async () => ({ ...lease, providerLeaseId: "old-box" }) } })({
          scope: { companyId: "company", adapterType: "claude_local" } as never, environmentId: "environment", leaseId: lease.id,
          acquiredProviderLeaseId: lease.providerLeaseId,
        } as never);
      return opener("ignored-fixed-login-command");
    };
    await expect(open()).rejects.toMatchObject({ code: "sandbox_lease_start_denied" });
    expect(openLoginPtySession).not.toHaveBeenCalled();
  });

  it.each(["sandbox", "plugin"])("%s login acquisition disables reuse", driver => {
    const args = buildLoginLeaseAcquireArgs({ browserLogin: true,
      metadata: { companyId: "company", adapterType: "codex_local", environment: { id: "environment", driver } as never } });
    expect({ issueId: args.issueId, heartbeatRunId: args.heartbeatRunId, persistedExecutionWorkspace: args.persistedExecutionWorkspace })
      .toEqual({ issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null });
    expect(Object.keys(args).filter(key => /providerLeaseId|reuse|resume/i.test(key))).toEqual([]);
  });
});
