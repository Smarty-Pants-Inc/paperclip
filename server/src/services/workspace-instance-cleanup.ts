import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { parse as parseEnvContents } from "dotenv";
import { expandHomePrefix } from "../home-paths.js";
import { isValidLocalEncryptedMasterKey } from "../secrets/local-encrypted-provider.js";
import { INSTANCE_HEARTBEAT_RUN_MARKER } from "./instance-run-marker.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";

const execFileAsync = promisify(execFile);
const INSTANCE_ID_RE = /^[A-Za-z0-9_-]+$/;
const POSTGRES_STOP_TIMEOUT_MS = 10_000;
export const WORKTREE_INSTANCE_ROOT_METADATA_KEY = "worktreeInstanceRoot";

export function deriveWorktreeInstanceId(workspacePath: string): string {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  const normalized = path.basename(resolvedWorkspacePath)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48);
  const pathHash = createHash("sha256").update(resolvedWorkspacePath).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

/**
 * The instance id a seeded worktree actually runs as, read from the pointer the
 * guest process itself loads.
 *
 * Synchronous and null-on-anything-unexpected by design: callers use it to
 * decide whether they can prove workspace identity at all, and an unsafe or
 * unreadable pointer must fail closed rather than fall back to a guess.
 */
export function readWorktreeInstanceId(workspacePath: string): string | null {
  const envPath = path.join(path.resolve(workspacePath), ".paperclip", ".env");
  let contents: string;
  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  const instanceId = parseEnvContents(contents).PAPERCLIP_INSTANCE_ID?.trim();
  if (!instanceId || !INSTANCE_ID_RE.test(instanceId)) return null;
  return instanceId;
}

export type WorktreeInstancePointer = {
  envPath: string;
  envContents: string;
};

export type WorktreeInstanceCleanupResult =
  | { status: "not_configured" }
  | { status: "already_absent"; instanceRoot: string }
  | { status: "refused"; instanceRoot: string | null; warning: string }
  | { status: "removed"; instanceRoot: string; postgresStopped: boolean };

export type WorktreeInstanceCleanupDependencies = {
  stopEmbeddedPostgres: (dataDir: string) => Promise<boolean>;
  removeInstanceRoot: (instanceRoot: string) => Promise<void>;
};

export type EmbeddedPostgresStopDependencies = {
  processIsAlive: (pid: number) => boolean;
  readVerifiedPostgresCommand: (pid: number, dataDir: string) => Promise<string | null>;
  signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  wait: (milliseconds: number) => Promise<unknown>;
};

const defaultCleanupDependencies: WorktreeInstanceCleanupDependencies = {
  stopEmbeddedPostgres: stopEmbeddedPostgresIfRunning,
  removeInstanceRoot: async (instanceRoot) => {
    await fs.rm(instanceRoot, { recursive: true, force: true });
  },
};

const defaultPostgresStopDependencies: EmbeddedPostgresStopDependencies = {
  processIsAlive,
  readVerifiedPostgresCommand,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  wait: delay,
};

/**
 * Raw-trace directories a Paperclip instance writes under its own root, with the
 * env override its owner reads. Removing an instance root must never delete any
 * of them (R-keep-all-traces, never-OK), so an instance root that holds one is
 * kept whole. The defaults come from:
 * - durable-sessions: native-harness-backup-stamp.ts nativeHarnessStateBase()
 *   (native harness backups, continuity archives, quarantined session roots and
 *   conversation evidence; also native-setup-evidence.ts createNativeSetupRuntime())
 * - provider-traces: provider-trace-store.ts traceRoot()
 * - run-logs: run-log-store.ts (RUN_LOG_BASE_PATH default)
 */
export const WORKTREE_INSTANCE_RAW_TRACE_DIRECTORIES: ReadonlyArray<{ relativePath: string; envOverride: string }> = [
  { relativePath: path.join("runtime", "paperclip-runner", "durable-sessions"), envOverride: "PAPERCLIP_RUNNER_STATE_DIR" },
  { relativePath: path.join("data", "provider-traces"), envOverride: "PROVIDER_TRACE_BASE_PATH" },
  { relativePath: path.join("data", "run-logs"), envOverride: "RUN_LOG_BASE_PATH" },
];

/**
 * Provider homes a Paperclip instance writes under its own root (sessions,
 * rollouts, provider state), by line:
 * - <root>/codex-home, <root>/companies/<id>/codex-home:
 *   packages/adapters/codex-local/src/server/codex-home.ts resolveManagedCodexHomeDir() (:179, :180),
 *   packages/adapter-utils/src/acpx-engine/execute.ts resolveManagedCodexHomeDir() (:840),
 *   server/src/services/feedback.ts (:402-407, companies/<id>/codex-home/sessions)
 * - <root>/grok-home, <root>/companies/<id>/grok-home:
 *   packages/adapters/grok-local/src/server/grok-home.ts resolveManagedGrokHomeDir() (:127, :128),
 *   packages/adapter-utils/src/acpx-engine/execute.ts resolveManagedGrokHomeDir() (:854)
 * - <root>/companies/<id>/acp-engine (per-agent state and codex-home):
 *   packages/adapter-utils/src/acpx-engine/execute.ts defaultStateDir() (:836), resolveManagedCodexApiKeyHomeDir() (:844)
 * - <root>/companies/<id>/agents/<agentId>/codex-home: server/src/routes/agents.ts codexLocalAgentHome() (:2329)
 * - <root>/companies/<id>/agents/<agentId>/claude-runtime:
 *   packages/adapters/claude-local/src/server/claude-config.ts (:165, per-agent Claude runtime state)
 * - <root>/workspaces/<agentId> (agent_home cwd, where agent-home runs write):
 *   server/src/home-paths.ts resolveDefaultAgentWorkspaceDir() (:55)
 */
export const WORKTREE_INSTANCE_PROVIDER_HOME_NAMES = ["codex-home", "grok-home", "workspaces"] as const;
export const WORKTREE_INSTANCE_AGENT_PROVIDER_HOME_NAMES = ["codex-home", "claude-runtime"] as const;
export const WORKTREE_INSTANCE_COMPANY_PROVIDER_STATE_NAMES = ["codex-home", "grok-home", "acp-engine"] as const;

/**
 * The ALLOW-LIST: everything a worktree instance's create path writes under its
 * root before any run (RFL ruling, rf-3 https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7001341272).
 * The reaper removes an instance ONLY when its root holds nothing but this.
 * By line:
 * - the root itself: scripts/setup-paperclip-worktree.sh write_fallback_worktree_config()
 *   fs.mkdirSync(instanceRoot) (:528)
 * - secrets/: setup-paperclip-worktree.sh (:594, :607); cli/src/commands/worktree.ts
 *   copySeededSecretsKey() mkdirSync(dirname(targetKeyFilePath)) (:1066), run by
 *   `worktree init`/`ensure-seeded` seeding (:1689)
 * - secrets/master.key, a master key: setup-paperclip-worktree.sh inline write (:595-598)
 *   or copy of the source key (:608-609); worktree.ts copySeededSecretsKey() inline
 *   write (:1073) or copy (:1097)
 * NOT scaffold, by line: config.json and .env. Every worktree create path writes them
 * to <worktree>/.paperclip, not the root (cli worktree-lib.ts resolveWorktreeLocalPaths()
 * :212-213; setup-paperclip-worktree.sh :508-509, written at :590 and :639). `worktree init --no-seed`
 * (setup-paperclip-worktree.sh :174) writes nothing under the root. Seeding
 * then writes db/ and data/backups/seed/ (worktree.ts :1700, :1711), which are run data.
 * Directories are never content in themselves, at any depth: only what they hold
 * counts. A file is scaffold by NAME + CREATED SHAPE: secrets/master.key must be a
 * regular file (not a symlink) whose bytes the provider's own decoder accepts as a
 * 32-byte master key (local-encrypted-provider.ts isValidLocalEncryptedMasterKey()).
 */
export const WORKTREE_INSTANCE_SCAFFOLD_FILES: ReadonlyArray<string> = [path.join("secrets", "master.key")];
const MASTER_KEY_MAX_BYTES = 4096;

async function isScaffoldFile(full: string, relativePath: string, metadata: import("node:fs").Stats): Promise<boolean> {
  if (!WORKTREE_INSTANCE_SCAFFOLD_FILES.includes(relativePath)) return false;
  if (!metadata.isFile() || metadata.size > MASTER_KEY_MAX_BYTES) return false;
  return isValidLocalEncryptedMasterKey(await fs.readFile(full, "utf8"));
}

/**
 * The first path under the instance root that is NOT create-path scaffold, or
 * null when the root holds nothing but scaffold. The walk never follows a symlink
 * for deletion; a symlink counts BY ITS TARGET (realpath): a target inside the
 * root is covered by the direct walk; an outside directory target is walked (and
 * nothing there is scaffold); any other outside target is content; a dangling
 * link holds nothing. Any unexpected error is thrown, so the caller keeps the
 * instance (fail closed).
 */
export async function findNonScaffoldContent(instanceRoot: string): Promise<string | null> {
  const realRoot = await fs.realpath(instanceRoot);
  const visitedOutside = new Set<string>();
  const visit = async (directory: string, relative: string | null): Promise<string | null> => {
    for (const name of await fs.readdir(directory)) {
      const full = path.join(directory, name);
      const entryRelative = relative === null ? null : path.join(relative, name);
      const metadata = await fs.lstat(full);
      if (metadata.isSymbolicLink()) {
        const target = await realpathOrNull(full);
        if (target === null) continue;
        if (isSameOrChildPath(target, realRoot)) continue;
        if (!(await fs.stat(target)).isDirectory()) return full;
        if (visitedOutside.has(target)) continue;
        visitedOutside.add(target);
        if ((await visit(target, null)) !== null) return full;
        continue;
      }
      if (metadata.isDirectory()) {
        const found = await visit(full, entryRelative);
        if (found !== null) return found;
        continue;
      }
      if (entryRelative !== null && (await isScaffoldFile(full, entryRelative, metadata))) continue;
      return full;
    }
    return null;
  };
  return visit(realRoot, "");
}

/**
 * Whether a path holds content, resolved by REALPATH: a symlinked directory
 * counts by its target's entries (in or out of the root), a non-directory
 * counts as content (fail closed), an absent path or a dangling symlink holds
 * none. Any other error is thrown, so the caller keeps the instance.
 */
async function holdsContent(candidate: string): Promise<boolean> {
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  const metadata = await fs.stat(real);
  if (!metadata.isDirectory()) return true;
  return (await fs.readdir(real)).length > 0;
}

async function traceEntryExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function isSameOrChildPath(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || isStrictChildPath(candidatePath, rootPath);
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  const real = await realpathOrNull(directory);
  if (!real) return [];
  if (!(await fs.stat(real)).isDirectory()) return [];
  return fs.readdir(real);
}

/**
 * Why this instance may have recorded a run. The reaper removes an instance
 * ONLY when this is empty, i.e. when it is PROVEN never to have recorded a run
 * (rf-3's flipped rule): no run marker, AND db/ absent or empty, AND no content
 * in any named trace dir or provider home, each resolved by realpath. A trace
 * dir's ABSOLUTE env override is honoured when it lands in the root. A RELATIVE
 * one cannot be pinned to one base: its producers resolve it against their
 * PROCESS CWD (native-setup-evidence.ts createNativeSetupRuntime() and
 * native-harness-backup-stamp.ts nativeHarnessStateBase() path.resolve();
 * provider-trace-store.ts and run-log-store.ts pass it to fs as is). So it is
 * resolved against the instance root AND every base in relativeBases, and ANY
 * resolved path that holds content keeps the instance. Otherwise the whole
 * instance is kept (R-keep-all-traces, never-OK).
 */
export async function findWorktreeInstanceRawTraces(
  instanceRoot: string,
  instanceEnv: Record<string, string | undefined> | ReadonlyArray<Record<string, string | undefined>> = {},
  rootAliases: ReadonlyArray<string> = [],
  relativeBases: ReadonlyArray<string> = [],
): Promise<string[]> {
  const found: string[] = [];
  const envs = Array.isArray(instanceEnv) ? instanceEnv : [instanceEnv as Record<string, string | undefined>];
  const canonicalRoot = (await realpathOrNull(instanceRoot)) ?? path.resolve(instanceRoot);
  const roots = [...new Set([path.resolve(instanceRoot), canonicalRoot, ...rootAliases.map((alias) => path.resolve(alias))])];
  const inRoot = async (candidate: string) => {
    if (roots.some((root) => isSameOrChildPath(candidate, root))) return true;
    const real = await realpathOrNull(candidate);
    return real !== null && isSameOrChildPath(real, canonicalRoot);
  };
  // A default path plus its env override: absolute as is, RELATIVE against the
  // instance root and every base in relativeBases.
  const overrideCandidates = (defaultPath: string, envOverride: string) => {
    const out: Array<{ raw: string; resolved: string }> = [{ raw: defaultPath, resolved: defaultPath }];
    for (const env of envs) {
      const override = env[envOverride]?.trim();
      if (!override) continue;
      const expanded = expandHomePrefix(override);
      if (path.isAbsolute(expanded)) out.push({ raw: expanded, resolved: path.resolve(expanded) });
      else for (const base of [instanceRoot, ...relativeBases]) out.push({ raw: expanded, resolved: path.resolve(base, expanded) });
    }
    return out;
  };

  // 1. The run marker (instance-run-marker.ts).
  const marker = path.join(instanceRoot, INSTANCE_HEARTBEAT_RUN_MARKER);
  if (await traceEntryExists(marker)) found.push(marker);
  // 2. The embedded DB: run rows and run events. Non-empty without the marker is
  //    kept too: a failed marker write must fail closed.
  const embeddedDb = path.join(instanceRoot, "db");
  if (await holdsContent(embeddedDb)) found.push(embeddedDb);
  // 2b. A root-local secrets master key (home-paths resolveDefaultSecretsKeyFilePath()
  //     <root>/secrets/master.key, or its PAPERCLIP_SECRETS_MASTER_KEY_FILE override)
  //     when the instance's DB is NOT its embedded <root>/db: the key wraps the
  //     material that decrypts rows kept in that external DB, e.g. the per-backup
  //     key of encrypted .pchn native-harness backups in object storage
  //     (native-harness-backup-storage.ts :250 write, :391 read). With the embedded
  //     DB, everything the key wraps is in db/, which keeps the instance itself.
  if (!(await usesEmbeddedDb(instanceRoot, envs))) {
    for (const candidate of overrideCandidates(path.join(instanceRoot, "secrets"), "PAPERCLIP_SECRETS_MASTER_KEY_FILE")) {
      if (path.isAbsolute(candidate.raw) && !(await inRoot(candidate.resolved))) continue;
      if (await holdsContent(candidate.resolved)) found.push(candidate.resolved);
    }
  }
  // 3. The named trace dirs, at their defaults and their in-root overrides.
  for (const { relativePath, envOverride } of WORKTREE_INSTANCE_RAW_TRACE_DIRECTORIES) {
    const candidates = new Set([path.join(instanceRoot, relativePath)]);
    for (const env of envs) {
      const override = env[envOverride]?.trim();
      if (!override) continue;
      const expanded = expandHomePrefix(override);
      if (path.isAbsolute(expanded)) {
        const resolved = path.resolve(expanded);
        if (await inRoot(resolved)) candidates.add(resolved);
        continue;
      }
      for (const base of [instanceRoot, ...relativeBases]) candidates.add(path.resolve(base, expanded));
    }
    for (const candidate of candidates) if (await holdsContent(candidate)) found.push(candidate);
  }
  // 4. Provider homes under the instance.
  const providerHomes = WORKTREE_INSTANCE_PROVIDER_HOME_NAMES.map((name) => path.join(instanceRoot, name));
  const companiesDir = path.join(instanceRoot, "companies");
  for (const companyId of await listDirectoryNames(companiesDir)) {
    const companyDir = path.join(companiesDir, companyId);
    for (const name of WORKTREE_INSTANCE_COMPANY_PROVIDER_STATE_NAMES) providerHomes.push(path.join(companyDir, name));
    for (const agentId of await listDirectoryNames(path.join(companyDir, "agents"))) {
      for (const name of WORKTREE_INSTANCE_AGENT_PROVIDER_HOME_NAMES) providerHomes.push(path.join(companyDir, "agents", agentId, name));
    }
  }
  for (const home of providerHomes) if (await holdsContent(home)) found.push(home);
  // Steps 1-4 stay as a FAST keep (and 2b and the out-of-root override candidates
  // keep what the allow-list cannot see). 5. The ALLOW-LIST: anything under the
  // root but the create-path scaffold keeps the whole instance.
  if (found.length === 0) {
    const content = await findNonScaffoldContent(instanceRoot);
    if (content !== null) found.push(content);
  }
  return found;
}

/**
 * Whether the instance provably runs on its embedded <root>/db: no DATABASE_URL
 * in its env files and its config.json database.mode is (or defaults to)
 * embedded-postgres (server/src/config.ts :161, :182; config-schema.ts :31).
 * An unreadable config fails closed (not embedded).
 */
async function usesEmbeddedDb(instanceRoot: string, envs: ReadonlyArray<Record<string, string | undefined>>): Promise<boolean> {
  if (envs.some((env) => env.DATABASE_URL?.trim())) return false;
  // The config the guest actually loads: PAPERCLIP_CONFIG from its pointer (every
  // worktree create path writes it: cli worktree-lib.ts buildWorktreeEnvEntries() :322;
  // setup-paperclip-worktree.sh :616), plus <root>/config.json when present or when
  // no PAPERCLIP_CONFIG is set. Every one must say embedded; any unreadable one, or a
  // relative PAPERCLIP_CONFIG, fails closed (not embedded).
  const configPaths: string[] = [];
  for (const env of envs) {
    const configured = env.PAPERCLIP_CONFIG?.trim();
    if (!configured) continue;
    const expanded = expandHomePrefix(configured);
    if (!path.isAbsolute(expanded)) return false;
    configPaths.push(path.resolve(expanded));
  }
  const rootConfig = path.join(instanceRoot, "config.json");
  if (configPaths.length === 0 || (await traceEntryExists(rootConfig))) configPaths.push(rootConfig);
  try {
    for (const configPath of configPaths) {
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as { database?: { mode?: unknown } };
      const mode = config?.database?.mode ?? "embedded-postgres";
      if (mode !== "embedded-postgres") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Every process cwd a guest instance's producer can have, for resolving a
 * RELATIVE trace-dir override (the instance root itself is always a base too):
 * - <worktree>/server: `pnpm dev` -> scripts/dev-runner.ts spawns
 *   `pnpm --filter @paperclipai/server dev`, which runs in the server package dir
 *   (also `pnpm dev:server`)
 * - <worktree>: the CLI worktree init/reseed process.chdir(worktree root)
 *   (cli/src/commands/worktree.ts) and `paperclipai run` from the checkout
 * - this process's own cwd: a producer running in the same process as the reaper
 */
function worktreeInstanceProcessCwds(workspacePath: string): string[] {
  const worktree = path.resolve(workspacePath);
  return [...new Set([path.join(worktree, "server"), worktree, process.cwd()])];
}

/** The instance root's own .env (resolvePaperclipEnvPath() beside its config.json), if any. */
async function readInstanceRootEnv(instanceRoot: string): Promise<Record<string, string>> {
  try {
    return parseEnvContents(await fs.readFile(path.join(instanceRoot, ".env"), "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw error;
  }
}

function isStrictChildPath(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function pathExists(value: string): Promise<boolean> {
  return fs.lstat(value).then(() => true).catch(() => false);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readVerifiedPostgresCommand(pid: number, dataDir: string): Promise<string | null> {
  if (process.platform === "linux") {
    const commandLinePath = `/proc/${pid}/cmdline`;
    let commandLine: string;
    try {
      commandLine = await fs.readFile(commandLinePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const args = commandLine.split("\0").filter(Boolean);
    const executable = path.basename(args[0] ?? "");
    const dataDirFlagIndex = args.indexOf("-D");
    const configuredDataDir = dataDirFlagIndex >= 0 ? args[dataDirFlagIndex + 1] : null;
    if (!executable.includes("postgres") || !configuredDataDir) {
      throw new Error(`Refusing to signal process ${pid}: it is not the expected embedded PostgreSQL process.`);
    }
    const canonicalConfiguredDataDir = await fs.realpath(configuredDataDir).catch(() => path.resolve(configuredDataDir));
    if (canonicalConfiguredDataDir !== dataDir) {
      throw new Error(`Refusing to signal process ${pid}: its PostgreSQL data directory does not match ${dataDir}.`);
    }
    return args.join(" ");
  }

  if (process.platform === "win32") {
    throw new Error(`Refusing to signal process ${pid}: safe PostgreSQL process verification is unavailable on Windows.`);
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const command = stdout.trim();
    if (!command) return null;
    if (!/(?:^|\/)postgres(?:\s|$)/.test(command) || !command.includes(dataDir)) {
      throw new Error(`Refusing to signal process ${pid}: it is not the expected embedded PostgreSQL process.`);
    }
    return command;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
}

export async function stopEmbeddedPostgresIfRunning(
  dataDir: string,
  dependencies: EmbeddedPostgresStopDependencies = defaultPostgresStopDependencies,
): Promise<boolean> {
  const postmasterPidPath = path.join(dataDir, "postmaster.pid");
  if (!await pathExists(postmasterPidPath)) return false;

  const canonicalDataDir = await fs.realpath(dataDir);
  const pidContents = await fs.readFile(postmasterPidPath, "utf8");
  const pidLines = pidContents.split(/\r?\n/);
  const pid = Number(pidLines[0]?.trim());
  const recordedDataDir = pidLines[1]?.trim();
  if (!Number.isInteger(pid) || pid <= 0 || !recordedDataDir) {
    throw new Error(`Refusing to remove ${dataDir}: its postmaster.pid is malformed.`);
  }

  const canonicalRecordedDataDir = await fs.realpath(recordedDataDir).catch(() => path.resolve(recordedDataDir));
  if (canonicalRecordedDataDir !== canonicalDataDir) {
    throw new Error(`Refusing to remove ${dataDir}: postmaster.pid points at a different PostgreSQL data directory.`);
  }
  if (!dependencies.processIsAlive(pid)) return false;
  if (await dependencies.readVerifiedPostgresCommand(pid, canonicalDataDir) === null) return false;

  try {
    dependencies.signalProcess(pid, "SIGINT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  const deadline = Date.now() + POSTGRES_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!dependencies.processIsAlive(pid)) return true;
    await dependencies.wait(100);
  }
  throw new Error(`Embedded PostgreSQL process ${pid} did not stop within ${POSTGRES_STOP_TIMEOUT_MS}ms.`);
}

export async function readWorktreeInstancePointer(workspacePath: string): Promise<WorktreeInstancePointer | null> {
  const envPath = path.join(workspacePath, ".paperclip", ".env");
  try {
    return {
      envPath,
      envContents: await fs.readFile(envPath, "utf8"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveConfiguredInstanceRoot(pointer: WorktreeInstancePointer, expectedInstanceId?: string):
  | { instanceRoot: string; instanceId: string }
  | { warning: string; instanceRoot: string | null; refusalReason: string | null } {
  const env = parseEnvContents(pointer.envContents);
  const configuredHome = env.PAPERCLIP_HOME?.trim();
  const instanceId = env.PAPERCLIP_INSTANCE_ID?.trim();
  if (!configuredHome || !instanceId) {
    return { warning: "", instanceRoot: null, refusalReason: null };
  }
  if (!INSTANCE_ID_RE.test(instanceId)) {
    return {
      instanceRoot: null,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_INSTANCE_ID is not a safe path segment.`,
      refusalReason: "unsafe_instance_id",
    };
  }

  const expandedHome = expandHomePrefix(configuredHome);
  if (!path.isAbsolute(expandedHome)) {
    return {
      instanceRoot: null,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_HOME is not absolute.`,
      refusalReason: "non_absolute_home",
    };
  }
  const instanceRoot = path.resolve(expandedHome, "instances", instanceId);
  if (expectedInstanceId && instanceId !== expectedInstanceId) {
    return {
      instanceRoot,
      warning: `Refusing worktree instance cleanup from ${pointer.envPath}: PAPERCLIP_INSTANCE_ID "${instanceId}" does not match the expected workspace instance "${expectedInstanceId}".`,
      refusalReason: "instance_id_mismatch",
    };
  }
  return { instanceRoot, instanceId };
}

function resolveManagedInstancesDir(worktreesDir?: string): string {
  const managedWorktreesDir = path.resolve(
    expandHomePrefix(
      worktreesDir?.trim()
      || process.env.PAPERCLIP_WORKTREES_DIR?.trim()
      || path.join(os.homedir(), ".paperclip-worktrees"),
    ),
  );
  return path.join(managedWorktreesDir, "instances");
}

export async function readManagedWorktreeInstanceOwnership(
  workspacePath: string,
  worktreesDir?: string,
): Promise<{ instanceRoot: string; instanceId: string } | null> {
  const pointer = await readWorktreeInstancePointer(workspacePath);
  if (!pointer) return null;
  const configured = resolveConfiguredInstanceRoot(pointer);
  if ("warning" in configured) {
    if (!configured.warning) return null;
    throw new Error(configured.warning);
  }
  const managedInstancesDir = resolveManagedInstancesDir(worktreesDir);
  if (!isStrictChildPath(configured.instanceRoot, managedInstancesDir)) {
    throw new Error(
      `Refusing to record worktree instance ownership for "${configured.instanceRoot}" because it is outside "${managedInstancesDir}".`,
    );
  }
  return configured;
}

export async function cleanupWorktreeInstanceArtifacts(input: {
  pointer: WorktreeInstancePointer;
  workspaceId: string;
  workspacePath: string;
  expectedInstanceId: string;
  expectedInstanceRoot: string | null;
  recorder?: WorkspaceOperationRecorder | null;
  worktreesDir?: string;
  dependencies?: WorktreeInstanceCleanupDependencies;
}): Promise<WorktreeInstanceCleanupResult> {
  const configured = resolveConfiguredInstanceRoot(input.pointer, input.expectedInstanceId);
  if ("warning" in configured && !configured.warning) return { status: "not_configured" };

  const managedInstancesDir = resolveManagedInstancesDir(input.worktreesDir);
  const managedWorktreesDir = path.dirname(managedInstancesDir);
  const configuredInstanceRoot = configured.instanceRoot;
  let warning = "warning" in configured ? configured.warning : "";
  const recordRefusal = async (
    metadata: Record<string, unknown>,
    refusalWarning = warning,
  ) => {
    if (!input.recorder) return;
    await input.recorder.recordOperation({
      phase: "workspace_teardown",
      cwd: input.workspacePath,
      metadata: {
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        instanceRoot: configuredInstanceRoot,
        managedInstancesDir,
        cleanupAction: "remove_worktree_instance",
        ...metadata,
      },
      run: async () => ({ status: "skipped", system: `${refusalWarning}\n` }),
    });
  };

  if ("warning" in configured) {
    await recordRefusal({ refusalReason: configured.refusalReason }, configured.warning);
    return { status: "refused", instanceRoot: configured.instanceRoot, warning: configured.warning };
  }

  if (!configuredInstanceRoot || !isStrictChildPath(configuredInstanceRoot, managedInstancesDir)) {
    warning ||= `Refusing to remove instance directory "${configuredInstanceRoot ?? "unknown"}" because it is outside "${managedInstancesDir}".`;
    await recordRefusal({ refusalReason: "outside_managed_instances_dir" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  const expectedInstanceRoot = input.expectedInstanceRoot ? path.resolve(input.expectedInstanceRoot) : null;
  if (!expectedInstanceRoot) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because execution workspace ${input.workspaceId} has no persisted instance root.`;
    await recordRefusal({ refusalReason: "persisted_instance_root_missing" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }
  if (expectedInstanceRoot && configuredInstanceRoot !== expectedInstanceRoot) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because it does not match execution workspace ${input.workspaceId}'s persisted instance root "${expectedInstanceRoot}".`;
    await recordRefusal({
      expectedInstanceRoot,
      refusalReason: "instance_root_workspace_mismatch",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (!await pathExists(configuredInstanceRoot)) {
    return { status: "already_absent", instanceRoot: configuredInstanceRoot };
  }

  let canonicalManagedWorktreesDir: string;
  let canonicalManagedInstancesDir: string;
  let canonicalInstanceRoot: string;
  try {
    [canonicalManagedWorktreesDir, canonicalManagedInstancesDir, canonicalInstanceRoot] = await Promise.all([
      fs.realpath(managedWorktreesDir),
      fs.realpath(managedInstancesDir),
      fs.realpath(configuredInstanceRoot),
    ]);
  } catch (error) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path could not be verified: ${error instanceof Error ? error.message : String(error)}`;
    await recordRefusal({ refusalReason: "canonical_path_unavailable" });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (canonicalManagedInstancesDir !== path.join(canonicalManagedWorktreesDir, "instances")) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because the managed instances directory resolves outside "${canonicalManagedWorktreesDir}".`;
    await recordRefusal({
      canonicalInstanceRoot,
      canonicalManagedInstancesDir,
      refusalReason: "managed_instances_dir_symlink",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  if (!isStrictChildPath(canonicalInstanceRoot, canonicalManagedInstancesDir)) {
    warning = `Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path "${canonicalInstanceRoot}" is outside "${canonicalManagedInstancesDir}".`;
    await recordRefusal({
      canonicalInstanceRoot,
      canonicalManagedInstancesDir,
      refusalReason: "canonical_path_outside_managed_instances_dir",
    });
    return { status: "refused", instanceRoot: configuredInstanceRoot, warning };
  }

  const dependencies = input.dependencies ?? defaultCleanupDependencies;
  let postgresStopped = false;
  let keptRawTraces: string[] = [];
  const keptWarning = () => `Kept worktree instance directory "${canonicalInstanceRoot}" because it holds raw traces `
    + `or may have recorded a run (${keptRawTraces.join(", ")}); the reaper removes only an instance proven never to have recorded a run.`;
  const cleanup = async () => {
    postgresStopped = await dependencies.stopEmbeddedPostgres(path.join(canonicalInstanceRoot, "db"));
    const [currentManagedInstancesDir, currentInstanceRoot] = await Promise.all([
      fs.realpath(managedInstancesDir),
      fs.realpath(configuredInstanceRoot),
    ]);
    if (
      currentManagedInstancesDir !== canonicalManagedInstancesDir
      || currentInstanceRoot !== canonicalInstanceRoot
      || !isStrictChildPath(currentInstanceRoot, currentManagedInstancesDir)
    ) {
      throw new Error(`Refusing to remove instance directory "${configuredInstanceRoot}" because its canonical path changed during cleanup.`);
    }
    // R-keep-all-traces (never-OK): remove ONLY an instance proven never to
    // have recorded a run; otherwise keep it whole. Checked last, immediately
    // before the removal. fs.rm never follows a symlink out of the root.
    keptRawTraces = await findWorktreeInstanceRawTraces(
      currentInstanceRoot,
      [parseEnvContents(input.pointer.envContents), await readInstanceRootEnv(currentInstanceRoot)],
      [configuredInstanceRoot],
      worktreeInstanceProcessCwds(input.workspacePath),
    );
    if (keptRawTraces.length > 0) return;
    await dependencies.removeInstanceRoot(currentInstanceRoot);
  };

  if (input.recorder) {
    await input.recorder.recordOperation({
      phase: "workspace_teardown",
      cwd: input.workspacePath,
      metadata: {
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        instanceRoot: canonicalInstanceRoot,
        managedInstancesDir: canonicalManagedInstancesDir,
        cleanupAction: "remove_worktree_instance",
      },
      run: async () => {
        await cleanup();
        if (keptRawTraces.length > 0) {
          return {
            status: "skipped",
            system: `${keptWarning()}\n`,
            metadata: { postgresStopped, refusalReason: "raw_traces_kept", rawTraceDirectories: keptRawTraces },
          };
        }
        return {
          status: "succeeded",
          system: `Removed worktree instance directory ${canonicalInstanceRoot}\n`,
          metadata: { postgresStopped },
        };
      },
    });
  } else {
    await cleanup();
  }

  if (keptRawTraces.length > 0) return { status: "refused", instanceRoot: canonicalInstanceRoot, warning: keptWarning() };
  return { status: "removed", instanceRoot: canonicalInstanceRoot, postgresStopped };
}
