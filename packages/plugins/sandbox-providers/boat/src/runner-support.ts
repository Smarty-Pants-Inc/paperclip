import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PluginEnvironmentRunnerIngressError } from "@paperclipai/plugin-sdk";
import type { PluginEnvironmentAcquireLeaseParams, PluginEnvironmentExecuteResult, PluginEnvironmentRunnerIngressFailure } from "@paperclipai/plugin-sdk";

export const WORKSPACE_SENTINEL_RELATIVE_PATH = ".paperclip-runtime/reusable-sandbox-lease.json";
export const DEFAULT_WARM_RUNNER_IDLE_TIMEOUT_MS = 300_000;
export const WARM_IDLE_AUTO_STOP_MARGIN_SECONDS = 300;
export type RunnerConfig = {
  apiKey: string; type: string; ttlSeconds: number; reuseLease: boolean;
  snapshot?: string; from?: string; pinnedSnapshotId?: string; boatEnvironment?: string; setupScript?: string;
  runnerLifecycleMode: "inherit" | "per_turn" | "warm";
  runnerIdleTimeoutMs: number; warmRunnerIdleTimeoutMs?: number; runnerReconnectGraceMs?: number;
};
export type BoatIO = {
  request(path: string, init?: RequestInit, allowMissing?: boolean): Promise<any>;
  run(command: string, timeout: number): Promise<PluginEnvironmentExecuteResult>;
};
export function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }
export function workspaceDirectory(value: unknown): string {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.includes("\0")) {
    throw new Error("Boat workspace directory must be a normalized absolute POSIX path.");
  }
  return value;
}
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter(k => record[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function effectiveTtlSeconds(config: RunnerConfig): number {
  const warm = config.reuseLease ? config.warmRunnerIdleTimeoutMs ?? (config.runnerLifecycleMode === "warm" ? config.runnerIdleTimeoutMs : 0) : 0;
  const floor = Math.max(warm, config.runnerReconnectGraceMs ?? 0);
  return floor > 0 ? Math.max(config.ttlSeconds, Math.ceil(floor / 1000) + WARM_IDLE_AUTO_STOP_MARGIN_SECONDS) : config.ttlSeconds;
}
export function workspaceSentinelToken(params: PluginEnvironmentAcquireLeaseParams, config: RunnerConfig, id: string): string | null {
  if ((!config.reuseLease && !params.runId) || !params.agentId || (!params.executionWorkspaceId && !params.issueId)) return null;
  return sha256(stableStringify({
    provider: "boat", companyId: params.companyId, environmentId: params.environmentId, agentId: params.agentId,
    executionWorkspaceId: params.executionWorkspaceId, ...(params.executionWorkspaceId ? {} : { projectlessIssueId: params.issueId }),
    adapterType: params.adapterType ?? null,
    ...(!config.reuseLease ? { ephemeralRunId: params.runId, ephemeralProviderLeaseId: id } : {}),
    type: config.type, snapshot: config.snapshot, from: config.from, pinnedSnapshotId: config.pinnedSnapshotId, boatEnvironment: config.boatEnvironment,
    // Resource/bootstrap identity, never the API key or secret-bearing setup text.
    setupScriptDigest: config.setupScript === undefined ? null : sha256(config.setupScript),
  }));
}
export async function writeWorkspaceSentinel(params: PluginEnvironmentAcquireLeaseParams, config: RunnerConfig, id: string, remoteCwd: string, io: BoatIO) {
  const sentinelPath = path.posix.join(remoteCwd, WORKSPACE_SENTINEL_RELATIVE_PATH);
  const token = workspaceSentinelToken(params, config, id);
  if (!token) return { path: sentinelPath, token: null, result: "skipped" };
  const made = await io.run(`mkdir -p ${quote(path.posix.dirname(sentinelPath))}`, 30_000);
  if (made.timedOut || made.exitCode !== 0) throw new Error("Boat workspace sentinel directory creation failed.");
  const content = JSON.stringify({ version: 1, token, companyId: params.companyId, environmentId: params.environmentId,
    agentId: params.agentId, executionWorkspaceId: params.executionWorkspaceId,
    ...(params.executionWorkspaceId ? {} : { projectlessIssueId: params.issueId }),
    adapterType: params.adapterType ?? null, provider: "boat", writtenAt: new Date().toISOString() }, null, 2);
  // Boat PUT files: out/runner/boat-docs/write-file.md:35-72,97-120.
  await io.request(`/sandboxes/${encodeURIComponent(id)}/files`, { method: "PUT", body: JSON.stringify({ path: sentinelPath, content, encoding: "utf8" }) });
  return { path: sentinelPath, token, result: "written",
    allocationFiles: { providerLeaseId: id, remoteCwd, files: [{ relativePath: WORKSPACE_SENTINEL_RELATIVE_PATH, sha256: sha256(content) }] },
    ...(!config.reuseLease ? { runId: params.runId, providerLeaseId: id } : {}) };
}
export function resumeSentinelMetadata(metadata: Record<string, unknown> | undefined, id: string, remoteCwd: string) {
  const sentinel = metadata?.workspaceSentinel as Record<string, unknown> | undefined;
  if (!sentinel || typeof sentinel.token !== "string" || !/^[a-f0-9]{64}$/.test(sentinel.token)) return null;
  if (metadata?.sandboxId !== id) return null;
  // Core may replace remoteCwd with a prepared .paperclip-workspaces child.
  // The allocation receipt retains the original cwd; never derive a new proof
  // location from the prepared cwd or accept an arbitrary recorded path.
  const allocation = metadata.workspaceAllocationFiles as Record<string, unknown> | undefined;
  const writtenAllocation = sentinel.allocationFiles as Record<string, unknown> | undefined;
  const originalCwd = allocation?.remoteCwd ?? writtenAllocation?.remoteCwd ?? remoteCwd;
  try { workspaceDirectory(originalCwd); } catch { return null; }
  for (const receipt of [allocation, writtenAllocation]) {
    if (receipt !== undefined && (receipt?.providerLeaseId !== id || receipt?.remoteCwd !== originalCwd)) return null;
  }
  const expectedPath = path.posix.join(originalCwd as string, WORKSPACE_SENTINEL_RELATIVE_PATH);
  if (sentinel.path !== expectedPath) return null;
  if (metadata.reuseLease === false && (sentinel.providerLeaseId !== id || typeof sentinel.runId !== "string" || !sentinel.runId)) return null;
  return { ...sentinel, path: expectedPath, token: sentinel.token };
}
export async function verifyWorkspaceSentinel(sentinel: NonNullable<ReturnType<typeof resumeSentinelMetadata>>, io: BoatIO) {
  // Boat commands: boatdocs-0110c/x_execute-sandbox-command.md:35-61.
  const result = await io.run(`cat ${quote(sentinel.path)}`, 30_000);
  if (result.timedOut) throw new Error("Boat workspace sentinel verification timed out; preserve the lease.");
  if (result.exitCode !== 0) return { ...sentinel, result: "missing" };
  try {
    const parsed = JSON.parse(result.stdout);
    return { ...sentinel, result: parsed?.version === 1 && parsed?.provider === "boat" && parsed?.token === sentinel.token ? "matched" : "mismatch" };
  } catch { return { ...sentinel, result: "mismatch" }; }
}

// Like Daytona, preview credential rotation is NOT a new runtime generation.
// Key by company/environment/account as well as allocation ID; no cross-tenant cache.
const generations = new Map<string, { revision: string | null; generation: string }>();
export function ingressScopeKey(params: { companyId: string; environmentId: string }, config: RunnerConfig, id: string): string {
  return sha256(`${params.companyId}\0${params.environmentId}\0${sha256(config.apiKey)}\0${id}`);
}
export const runnerIngressGenerationStore = {
  get(key: string, sandbox: { updatedAt?: string; createdAt?: string }): string {
    const revision = sandbox.updatedAt ?? sandbox.createdAt ?? null;
    const current = generations.get(key);
    if (current && current.revision === revision) return current.generation;
    const generation = sha256(`${key}\0${revision ?? randomUUID()}`);
    generations.set(key, { revision, generation });
    return generation;
  },
  invalidate(key: string) { generations.delete(key); },
  reset() { generations.clear(); },
};
export async function acquireRunnerIngress<T>(phase: PluginEnvironmentRunnerIngressFailure["phase"], operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const status = error && typeof error === "object" ? (error as { httpStatus?: number }).httpStatus : undefined;
    if (typeof status === "number" && status >= 400 && status <= 599) throw new PluginEnvironmentRunnerIngressError({ phase, httpStatus: status });
    // Do not forward URLs, query tokens, provider bodies, or transport causes.
    throw new Error(`Boat runner ingress failed during ${phase}.`);
  }
}
export function privateRunnerEndpoint(preview: any, runnerPath: string) {
  if (typeof preview?.url !== "string" || preview.isProtected !== true || preview.access !== "private" || preview.port !== 43127) throw new Error("Boat returned an incomplete private preview endpoint.");
  let url: URL;
  try { url = new URL(preview.url); } catch { throw new Error("Boat returned an invalid private preview URL."); }
  const token = url.searchParams.get("_token");
  // Boat's documented Cookie auth accepts the private URL's token, avoiding a
  // signed URL or public route. Never interpolate a cookie delimiter/control.
  // out/runner/boat-docs/hosting.md:82-105; expose-a-port.md:41-45,102-114.
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || url.pathname !== "/"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*-43127\.on\.boat\.dev$/.test(url.hostname)
    || [...url.searchParams.keys()].length !== 1 || !token || !/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(token)) {
    throw new Error("Boat returned an invalid private preview URL.");
  }
  url.search = ""; url.protocol = "wss:"; url.pathname = runnerPath;
  return { kind: "authenticated_websocket" as const, websocketUrl: url.toString(), secretHeaders: [{ name: "Cookie", value: `_port_auth=${token}` }] };
}
