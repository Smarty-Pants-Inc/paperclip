import { describe, expect, it, vi } from "vitest";
import type { EnvironmentLease } from "@paperclipai/shared";
import { carryReusableLeasePreparation } from "./environment-lease-handoff.js";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";

type Binding = Parameters<typeof carryReusableLeasePreparation>[0];
function binding(id = "lease-1"): Binding {
  return { id, companyId: "company", environmentId: "env", executionWorkspaceId: "workspace",
    issueId: "issue", heartbeatRunId: `run-${id}`, provider: "daytona", providerLeaseId: "held-box",
    metadata: { agentId: "agent" }, acquiredAt: new Date() };
}
const receipt = { key: "a".repeat(64), leaseId: "lease-1", layout: { PATH: "/wrappers" } };

describe("retained-allocation preparation handoff", () => {
  it("rebinds only known successful receipts, including cached realization ownership", () => {
    const previous = binding();
    previous.metadata = { ...previous.metadata, anonymousGitHubLaunchers: receipt,
      nativeWorkspaceRealizationPreparation: { key: "b".repeat(64), leaseId: previous.id, cwd: "/workspace",
        realization: { mode: "copy", leaseId: previous.id, authoritativeRoot: "/workspace" } },
      unrecognizedPreparation: { token: "must-not-transfer" } };
    const next = binding("lease-2");
    const metadata = carryReusableLeasePreparation(previous, next);
    expect(metadata.anonymousGitHubLaunchers).toEqual({ ...receipt, leaseId: next.id });
    expect(metadata.nativeWorkspaceRealizationPreparation).toMatchObject({ leaseId: next.id,
      realization: { leaseId: next.id } });
    expect(metadata.workspaceRealization).toMatchObject({ leaseId: next.id });
    expect(metadata.unrecognizedPreparation).toBeUndefined();
    expect(previous.metadata.anonymousGitHubLaunchers).toEqual(receipt);
  });

  it.each(["providerLeaseId", "provider", "companyId", "environmentId", "executionWorkspaceId", "issueId"] as const)(
    "does not transfer across changed %s", (field) => {
      const previous = binding(); previous.metadata = { ...previous.metadata, anonymousGitHubLaunchers: receipt };
      const next = { ...binding("lease-2"), [field]: "different" };
      expect(carryReusableLeasePreparation(previous, next).anonymousGitHubLaunchers).toBeUndefined();
    });

  it.each(["", "other-agent", undefined])("does not transfer absent or changed agent: %s", (agentId) => {
    const previous = binding(); previous.metadata = { ...previous.metadata, anonymousGitHubLaunchers: receipt };
    const next = { ...binding("lease-2"), metadata: { agentId } };
    expect(carryReusableLeasePreparation(previous, next).anonymousGitHubLaunchers).toBeUndefined();
  });

  it.each([{ ...receipt, leaseId: "unrelated" }, { ...receipt, key: "old-format" }, null])(
    "does not bless an unbound or old receipt", (raw) => {
      const previous = binding(); previous.metadata = { ...previous.metadata, anonymousGitHubLaunchers: raw };
      expect(carryReusableLeasePreparation(previous, binding("lease-2")).anonymousGitHubLaunchers).toBeUndefined();
    });

  it("does not replace a fresh provider realization with a cached one", () => {
    const previous = binding(); previous.metadata = { ...previous.metadata,
      nativeWorkspaceRealizationPreparation: { key: "b".repeat(64), leaseId: previous.id,
        realization: { leaseId: previous.id, authoritativeRoot: "/old" } } };
    const next = binding("lease-2"); next.metadata = { ...next.metadata,
      workspaceRealization: { authoritativeRoot: "/new" } };
    const metadata = carryReusableLeasePreparation(previous, next);
    expect(metadata.nativeWorkspaceRealizationPreparation).toBeUndefined();
    expect(metadata.workspaceRealization).toEqual({ authoritativeRoot: "/new" });
  });

  it("does no launcher work after handoff, but reruns for config, unrelated row and allocation changes", async () => {
    const previous = binding();
    const asLease = (row: Binding) => ({ ...row, status: "active", acquiredAt: row.acquiredAt.toISOString() }) as unknown as EnvironmentLease;
    const prepare = vi.fn(async ({ env }) => ({ ...env, PATH: "/wrappers:" + env.PATH,
      ZDOTDIR: "/wrappers", BASH_ENV: "/wrappers/.bashrc", GH_CONFIG_DIR: "/wrappers/config",
      PAPERCLIP_GITHUB_LAUNCHER_DIR: "/wrappers" }));
    const configuration = { instructionsHash: "one", launchers: ["git", "gh"] };
    const turn = (row: Binding) => prepareHeartbeatGitHubLaunchers({ native: true, githubConfigured: false,
      agentId: "agent", runId: row.heartbeatRunId!, cwd: "/workspace", env: { PATH: "/bin" }, brokerUrl: "",
      target: { kind: "remote", transport: "sandbox", providerKey: "daytona", leaseId: row.id, remoteCwd: "/workspace" },
      createBrokerToken: () => { throw new Error("anonymous must not mint a token"); },
      preparation: { lease: asLease(row), configuration,
        save: async (saved) => { row.metadata = { ...row.metadata, anonymousGitHubLaunchers: saved }; } },
    }, prepare);
    await turn(previous);
    expect(prepare).toHaveBeenCalledTimes(1);
    const next = binding("lease-2"); next.metadata = carryReusableLeasePreparation(previous, next);
    await turn(next);
    expect(prepare).toHaveBeenCalledTimes(1);
    configuration.instructionsHash = "changed";
    await turn(next);
    expect(prepare).toHaveBeenCalledTimes(2);
    const unrelated = { ...next, id: "lease-without-validated-handoff" };
    await turn(unrelated);
    expect(prepare).toHaveBeenCalledTimes(3);
    const replaced = { ...next, providerLeaseId: "new-box" };
    await turn(replaced);
    expect(prepare).toHaveBeenCalledTimes(4);
  });
});
