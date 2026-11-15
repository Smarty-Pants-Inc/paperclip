import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { agents, authUsers, companies, companyMemberships, principalPermissionGrants, heartbeatRuns, environments, environmentLeases, createDb } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { agentInstructionWorkingCopyService } from "../../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../../services/native-runtime/runtime-context.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

// Exercise the runner's real stdin contract. Putting an RPC body in an env
// variable fails at Linux's per-string exec limit, long before the byte bound.
function execFile(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout?: number }, stdin?: string | null) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (code === 0) resolve(result); else reject(Object.assign(new Error("runner command failed"), result, { code, signal }));
    });
    child.stdin.on("error", () => {}); child.stdin.end(stdin ?? undefined);
  });
}

export async function warmAgentFilesRefreshFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "warm-agent-files-refresh-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = home;
  const database = await startEmbeddedPostgresTestDatabase("warm-agent-files-refresh-db-");
  const db = createDb(database.connectionString);
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), environmentId = randomUUID();
  const root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Warm agent", adapterConfig: {} });
  const agent = { id: agentId, companyId, name: "Warm agent", adapterType: "codex_local", adapterConfig: {
    instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md",
  } };
  await db.insert(companies).values({ id: companyId, name: "Warm refresh", issuePrefix: randomUUID().slice(0, 8) });
  await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(agents).values(agent);
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
    { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
  ]);
  await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
  await db.insert(environments).values({ id: environmentId, name: "Local command sandbox", driver: "sandbox" });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "AGENTS.md"), "# Loaded policy\n");
  await fs.mkdir(path.join(root, "skills", "reviewer"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "reviewer", "SKILL.md"), "# Review carefully\n");
  const runtimeConfig = { paperclipSkillSync: { desiredSkills: ["reviewer"] } };
  const runtimeSkillEntries = [{ key: "reviewer", runtimeName: "reviewer", source: path.join(root, "skills", "reviewer") }];
  const copies = agentInstructionWorkingCopyService(db);
  const runner: Extract<AdapterExecutionTarget, { transport: "sandbox" }>["runner"] = {
    execute: async input => {
      const startedAt = new Date().toISOString();
      const env = { ...process.env, ...input.env }, args = [...(input.args ?? [])];
      try {
        const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs }, input.stdin);
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
      } catch (error) {
        const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
        return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
      }
    },
  };
  async function prepare(name: string) {
    const runId = randomUUID(), leaseId = randomUUID(), remoteCwd = path.join(home, name);
    await fs.mkdir(remoteCwd, { recursive: true });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: "daytona", providerLeaseId: name });
    const target = { kind: "remote" as const, transport: "sandbox" as const, environmentId, leaseId, remoteCwd, runner,
      sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: name } };
    const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, target, warm: true }))!;
    const context = await buildNativeRuntimeContext({ db, agent, runId, runtimeConfig, runtimeSkillEntries,
      instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: copy.entryFile, kind: "agent_files" } });
    return { copy, target, context };
  }
  async function nextRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return runId;
  }
  async function cleanup() {
    await db.$client.end({ timeout: 1 });
    await database.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
  }
  return { home, db, companyId, agentId, root, agent, runtimeConfig, runtimeSkillEntries, copies, prepare, nextRun, cleanup };
}
