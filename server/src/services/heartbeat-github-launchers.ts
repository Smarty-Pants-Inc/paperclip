import { createHash } from "node:crypto";
import type { EnvironmentLease } from "@paperclipai/shared";
import { githubLauncherSource, githubBrokerEnvironment } from "@paperclipai/adapter-utils/github-launcher";
import { cleanupGitHubOperationLaunchers, prepareGitHubOperationLaunchers } from "@paperclipai/adapter-utils/execution-target";

type LauncherInput = Parameters<typeof prepareGitHubOperationLaunchers>[0];

// Persist only non-secret layout fields, never an invocation's credentials.
const LAYOUT_KEYS = ["PATH", "ZDOTDIR", "BASH_ENV", "GH_CONFIG_DIR", "PAPERCLIP_GITHUB_LAUNCHER_DIR"] as const;
export interface AnonymousGitHubLauncherReceipt {
  key: string;
  layout: Record<string, string>;
}


export async function prepareHeartbeatGitHubLaunchers(
  input: LauncherInput & {
    native: boolean;
    githubConfigured: boolean;
    agentId: string;
    brokerUrl: string;
    createBrokerToken: () => string;
    preparation?: {
      lease: EnvironmentLease;
      configuration: unknown;
      save: (receipt: AnonymousGitHubLauncherReceipt) => Promise<void>;
    };
  },
  prepareLaunchers = prepareGitHubOperationLaunchers,
  cleanupLaunchers = cleanupGitHubOperationLaunchers,
) {
  if (input.target?.kind === "remote" && input.target.transport === "sandbox" && input.target.runnerTask) {
    // Provider-owned tasks decide their own runtime layout and command environment.
    return { env: githubBrokerEnvironment(input.env, {
      url: input.githubConfigured ? input.brokerUrl : "",
      token: input.githubConfigured ? input.createBrokerToken() : "",
    }), cleanupLocation: null };
  }
  // Native configured access is owned by the provider session supervisor.
  // Defer staging until it has acquired that session; never mutate a live
  // process's authorization from heartbeat preparation.
  if (input.native && input.githubConfigured) {
    return { env: githubBrokerEnvironment(input.env, { url: "", token: "" }), cleanupLocation: null };
  }
  // An unconfigured sandbox has no managed GitHub identity to broker. Its
  // token-free wrappers still isolate image credentials, but may live as long
  // as the workspace so a warm provider never inherits a deleted run path.
  // Other adapter paths retain their run-scoped capability/retirement rules.
  const anonymous = input.native && !input.githubConfigured &&
    input.target?.kind === "remote" && input.target.transport === "sandbox";
  const location = {
    runId: anonymous
      ? `anonymous-${input.agentId}-${createHash("sha256").update(input.env.PATH ?? "").digest("hex").slice(0, 16)}`
      : input.runId,
    target: input.target,
  };
  const env = githubBrokerEnvironment(input.env, {
    url: anonymous ? "" : input.brokerUrl,
    token: anonymous ? "" : input.createBrokerToken(),
  });
  const lease = input.preparation?.lease;
  const eligible = anonymous && lease?.status === "active" && !lease.releasedAt && !lease.cleanupStatus
    && lease.providerLeaseId && input.target?.kind === "remote" && input.target.leaseId === lease.id
    && (!lease.expiresAt || new Date(lease.expiresAt).getTime() > Date.now());
  const key = eligible ? createHash("sha256").update(JSON.stringify({
    version: 1, launcher: githubLauncherSource(), staging: prepareGitHubOperationLaunchers.toString(),
    agentId: input.agentId, companyId: lease.companyId, leaseId: lease.id,
    providerLeaseId: lease.providerLeaseId, environmentId: lease.environmentId,
    configuration: input.preparation!.configuration, cwd: input.cwd,
    remoteCwd: input.target?.kind === "remote" ? input.target.remoteCwd : null,
    path: env.PATH ?? "",
  })).digest("hex") : null;
  const saved = lease?.metadata?.anonymousGitHubLaunchers as Partial<AnonymousGitHubLauncherReceipt> | undefined;
  if (key && saved?.key === key && saved.layout && LAYOUT_KEYS.every(name => typeof saved.layout![name] === "string")) {
    return { env: { ...env, ...Object.fromEntries(LAYOUT_KEYS.map(name => [name, saved.layout![name]!])) }, cleanupLocation: null };
  }
  try {
    const prepared = await prepareLaunchers({ ...location, cwd: input.cwd, env });
    if (key && LAYOUT_KEYS.every(name => typeof prepared[name] === "string")) {
      await input.preparation!.save({ key, layout: Object.fromEntries(LAYOUT_KEYS.map(name => [name, prepared[name]!])) });
    }
    return {
      env: prepared,
      cleanupLocation: anonymous ? null : location,
    };
  } catch (error) {
    // The caller cannot retain a cleanup location until staging returns. Clean
    // partial run-specific files here, preserving the original staging failure.
    // Anonymous files may still belong to a live warm provider; never delete them.
    if (!anonymous) await cleanupLaunchers(location).catch(() => undefined);
    throw error;
  }
}
