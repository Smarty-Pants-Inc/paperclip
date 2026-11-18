import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { retireSandboxRunnerPortHolders, sandboxSessionRunnerExited } from "./sandbox-runner-port-holders.js";

const HOLDER_SCRIPT = 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => process.stdout.write("ready\\n"));';
// A runnerd started by `nohup setsid` (native-session-executor's launch) leads its own process group; its agent
// children (here one, optionally ignoring TERM like a busy tool) live in that group, not as its pid.
const GROUP_HOLDER_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'const child = spawn(process.execPath, ["-e", (process.argv[2] === "ignores-term" ? "process.on(\\"SIGTERM\\", () => {});" : "") + "setInterval(() => {}, 1e6); process.stdout.write(\\"up\\\\n\\");"], { stdio: ["ignore", "pipe", "ignore"] });',
  'child.stdout.once("data", () => require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => process.stdout.write(`ready ${child.pid}\\n`)));',
].join("\n");

describeEmbeddedPostgres("a sandbox Runner port held by another session's Runner", () => {
  const environment = nativeRestartFixture();
  const holders: ChildProcess[] = [];
  const groupChildren: number[] = [];
  afterEach(() => {
    for (const holder of holders.splice(0)) if (holder.exitCode === null) holder.kill("SIGKILL");
    for (const pid of groupChildren.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  });

  const confinedCommands: string[][] = [];
  const confinedRunner = (base: string) => ({ execute: async (request: { command: string; args?: string[] }) => {
    const operands = (request.args ?? []).slice(2);
    confinedCommands.push(operands);
    if (operands.some(operand => operand.startsWith("/") && !operand.startsWith(`${base}/`))) {
      return { exitCode: 126, timedOut: false, stdout: "", stderr: "outside sandbox" };
    }
    const result = spawnSync(request.command, request.args ?? [], { encoding: "utf8", timeout: 20_000, cwd: base });
    return { exitCode: result.status, timedOut: result.error !== undefined, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } });

  async function freePort() {
    const probe = createServer();
    await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(done => probe.close(() => done()));
    return port;
  }

  async function bind(port: number): Promise<"bound" | string> {
    return new Promise(done => {
      const contender = createServer();
      contender.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
      contender.listen(port, "127.0.0.1", () => contender.close(() => done("bound")));
    });
  }

  async function startHolder(input: { runtimeRoot: string; session: string; runId: string; port: number;
    lifecycle?: string; outbox?: readonly unknown[]; pendingProviderCleanup?: unknown;
    group?: "plain" | "ignores-term" }) {
    const runnerInstanceId = `runner-${randomUUID()}`;
    const holder = input.group
      ? spawn(process.execPath, ["-e", GROUP_HOLDER_SCRIPT, String(input.port), input.group, "--runner-id", runnerInstanceId],
        { stdio: ["ignore", "pipe", "ignore"], detached: true })
      : spawn(process.execPath, ["-e", HOLDER_SCRIPT, String(input.port), "--runner-id", runnerInstanceId],
        { stdio: ["ignore", "pipe", "ignore"] });
    holders.push(holder);
    await new Promise<void>((done, fail) => {
      holder.stdout!.once("data", (chunk: Buffer) => {
        const child = /^ready (\d+)/.exec(chunk.toString())?.[1];
        if (child) groupChildren.push(Number(child));
        done();
      });
      holder.once("exit", code => fail(new Error(`holder exited ${code}`)));
    });
    const directory = join(input.runtimeRoot, "sessions", input.session, "runner");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "runner-process.identity"),
      `holdernonce\n${holder.pid}\n${new Date().toISOString()}\n${runnerInstanceId}\n${await processFingerprint(holder.pid!)}`);
    await writeFile(join(directory, "runner-state.json"), JSON.stringify({ runnerInstanceId, runId: input.runId,
      lifecycle: input.lifecycle ?? "ready", outbox: input.outbox ?? [], pendingTerminalDelivery: null,
      pendingProviderCleanup: input.pendingProviderCleanup ?? null, warmTransition: null }));
    // The session's durable trace: never-OK is losing it (rf-3/rf-4). The reaper deletes no file.
    await writeFile(join(directory, "journal.jsonl"), `{"seq":1,"runnerInstanceId":"${runnerInstanceId}"}\n`);
    await writeFile(join(input.runtimeRoot, "sessions", input.session, "session.json"), `{"runId":"${input.runId}"}\n`);
    return Object.assign(holder, { groupChild: input.group ? groupChildren.at(-1)! : null });
  }

  async function snapshot(directory: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[join(entry.parentPath, entry.name)] = (await readFile(join(entry.parentPath, entry.name))).toString("base64");
    }
    return files;
  }

  async function processGone(pid: number) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const state = await readFile(`/proc/${pid}/stat`, "utf8").then(stat => stat.slice(stat.lastIndexOf(") ") + 2)[0], () => null);
      if (state === null || state === "Z") return true;
      if (Date.now() >= deadline) return false;
      await new Promise(done => setTimeout(done, 100));
    }
  }

  async function processFingerprint(pid: number) {
    if (process.platform !== "linux") return "";
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return `linux:${boot}:${ticks}\n`;
  }

  async function exited(holder: ChildProcess) {
    if (holder.exitCode !== null || holder.signalCode !== null) return true;
    return new Promise<boolean>(done => {
      const timer = setTimeout(() => done(false), 5_000);
      holder.once("exit", () => { clearTimeout(timer); done(true); });
    });
  }

  async function scenario(label: string, holderStatus: "succeeded" | "running" | "cancelled" | null, state: { lifecycle?: string; outbox?: readonly unknown[]; pendingProviderCleanup?: unknown; group?: "plain" | "ignores-term"; session?: string } = {}) {
    const predecessor = await environment.seedRun(`PORT-HOLDER-PREV-${label}`);
    const current = await environment.seedRun(`PORT-HOLDER-NEXT-${label}`, predecessor.db);
    if (holderStatus) await predecessor.db.update(heartbeatRuns).set({ status: holderStatus }).where(eq(heartbeatRuns.id, predecessor.runId));
    const base = join(environment.current.runtimeRoot, `sandbox-${label}`);
    const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
    const port = await freePort();
    const holder = await startHolder({ runtimeRoot, session: state.session ?? "a".repeat(64), runId: holderStatus ? predecessor.runId : randomUUID(), port, ...state });
    const retire = () => retireSandboxRunnerPortHolders({ db: current.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: current.runId, runner: confinedRunner(base) as never, runtimeRoot,
      ownSessionRoot: join(runtimeRoot, "sessions", "b".repeat(64)), providerLeaseId: "sandbox-1",
      retireInProcess: async () => false, waitMs: 3_000, pollMs: 100 });
    return { predecessor, current, holder, port, retire, runtimeRoot };
  }

  it("stops a finished run's idle Runner that holds the port, so the next Runner binds", async () => {
    const { predecessor, current, holder, port, retire } = await scenario("finished", "succeeded");
    expect(await bind(port)).toBe("EADDRINUSE");
    await expect(retire()).resolves.toEqual([predecessor.runId]);
    expect(await exited(holder)).toBe(true);
    expect(await bind(port)).toBe("bound");
    expect(confinedCommands.flat().filter(operand => operand.startsWith("/")).every(operand => operand.startsWith(`${environment.current.runtimeRoot}/sandbox-finished/`))).toBe(true);
    const [activity] = await current.db.select().from(activityLog).where(and(
      eq(activityLog.runId, current.runId), eq(activityLog.action, "native.runner_port_holder_retired")));
    expect(activity?.details).toMatchObject({ holderRunId: predecessor.runId, holderStatus: "succeeded", providerLeaseId: "sandbox-1" });
  });

  it.each([
    ["a live run", "running", {}, "runner_port_holder_owner_not_settled"],
    ["a run with work in its outbox", "succeeded", { outbox: [{ seq: 1 }] }, "runner_port_holder_owner_not_settled"],
    ["a run whose provider cleanup is pending", "cancelled", { pendingProviderCleanup: { reason: "fixture" } }, "runner_port_holder_owner_not_settled"],
    ["no recorded run", null, {}, "runner_port_holder_unknown_owner"],
  ] as const)("never stops a holder owned by %s and sends the run to a fresh sandbox", async (_name, status, state, reason) => {
    const { holder, port, retire } = await scenario(`kept-${reason}-${status}`, status, state);
    const failure = await retire().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativePredecessorRetirementUnprovenError);
    expect(((failure as Error).cause as Error).message).toBe(reason);
    expect(holder.exitCode).toBeNull();
    expect(await bind(port)).toBe("EADDRINUSE");
  });

  it("stops only the named session's finished Runner and then proves it exited", async () => {
    const owner = await environment.seedRun("PORT-HOLDER-ONLY-OWNER");
    const other = await environment.seedRun("PORT-HOLDER-ONLY-OTHER", owner.db);
    await owner.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, owner.runId));
    await owner.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, other.runId));
    const base = join(environment.current.runtimeRoot, "sandbox-only");
    const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
    const own = await startHolder({ runtimeRoot, session: "e".repeat(64), runId: owner.runId, port: await freePort() });
    const neighbour = await startHolder({ runtimeRoot, session: "f".repeat(64), runId: other.runId, port: await freePort() });
    const exitedNow = () => sandboxSessionRunnerExited({ runner: confinedRunner(base) as never, runtimeRoot, sessionDirectory: "e".repeat(64) });
    expect(await exitedNow()).toBe(false);
    await expect(retireSandboxRunnerPortHolders({ db: owner.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: owner.runId, runner: confinedRunner(base) as never, runtimeRoot,
      ownSessionRoot: "", providerLeaseId: "sandbox-1", only: { sessionDirectory: "e".repeat(64), runId: owner.runId },
      retireInProcess: async () => false, waitMs: 3_000, pollMs: 100 })).resolves.toEqual([owner.runId]);
    expect(await exited(own)).toBe(true);
    expect(await exitedNow()).toBe(true);
    expect(neighbour.exitCode).toBeNull();
    expect(await sandboxSessionRunnerExited({ runner: confinedRunner(base) as never, runtimeRoot, sessionDirectory: "f".repeat(64) })).toBe(false);
    expect(await sandboxSessionRunnerExited({ runner: confinedRunner(base) as never, runtimeRoot, sessionDirectory: "0".repeat(64) })).toBe(false);
  });

  it("ignores this run's own session, moved-aside roots and holders that already exited", async () => {
    const current = await environment.seedRun("PORT-HOLDER-OWN");
    const base = join(environment.current.runtimeRoot, "sandbox-own");
    const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
    const own = await startHolder({ runtimeRoot, session: "b".repeat(64), runId: current.runId, port: await freePort() });
    const aside = await startHolder({ runtimeRoot, session: `${"c".repeat(64)}.bootstrap-restart-1`, runId: randomUUID(), port: await freePort() });
    const gone = await startHolder({ runtimeRoot, session: "d".repeat(64), runId: randomUUID(), port: await freePort() });
    gone.kill("SIGKILL");
    expect(await exited(gone)).toBe(true);
    await expect(retireSandboxRunnerPortHolders({ db: current.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: current.runId, runner: confinedRunner(base) as never, runtimeRoot,
      ownSessionRoot: join(runtimeRoot, "sessions", "b".repeat(64)), providerLeaseId: "sandbox-1",
      retireInProcess: async () => false })).resolves.toEqual([]);
    expect(own.exitCode).toBeNull();
    expect(aside.exitCode).toBeNull();
  });
  describe("B1 fence (b): the reaper retires the whole runner, wherever it sits, and keeps its trace", () => {
    it.each(["plain", "ignores-term"] as const)("R1/R5 kills a setsid runner's process group (child %s) and leaves its journal on disk", async (child) => {
      const { predecessor, holder, port, retire, runtimeRoot } = await scenario(`group-${child}`, "succeeded", { group: child });
      const session = join(runtimeRoot, "sessions", "a".repeat(64));
      const before = await snapshot(session);
      expect(Object.keys(before).map(file => file.slice(session.length + 1)).sort())
        .toEqual(["runner/journal.jsonl", "runner/runner-process.identity", "runner/runner-state.json", "session.json"]);
      expect(await processGone(holder.groupChild!)).toBe(false);
      await expect(retire()).resolves.toEqual([predecessor.runId]);
      expect(await exited(holder)).toBe(true);
      expect(await processGone(holder.groupChild!)).toBe(true);
      expect(await bind(port)).toBe("bound");
      expect(await snapshot(session)).toEqual(before);
    });

    it("R2/R5 reaps a finished run's stale runner left in this run's own session directory", async () => {
      const { predecessor, current, holder, port, retire, runtimeRoot } = await scenario("own-dir-stale", "succeeded", { session: "b".repeat(64), group: "plain" });
      const session = join(runtimeRoot, "sessions", "b".repeat(64));
      const before = await snapshot(session);
      await expect(retire()).resolves.toEqual([predecessor.runId]);
      expect(await exited(holder)).toBe(true);
      expect(await processGone(holder.groupChild!)).toBe(true);
      expect(await bind(port)).toBe("bound");
      expect(await snapshot(session)).toEqual(before);
      const [activity] = await current.db.select().from(activityLog).where(and(
        eq(activityLog.runId, current.runId), eq(activityLog.action, "native.runner_port_holder_retired")));
      expect(activity?.details).toMatchObject({ holderRunId: predecessor.runId, holderInOwnSession: true });
    });

    it("R3 never touches this run's own live runner in its own session directory", async () => {
      const current = await environment.seedRun("PORT-HOLDER-OWN-LIVE");
      const base = join(environment.current.runtimeRoot, "sandbox-own-live");
      const runtimeRoot = join(base, ".paperclip-runtime", "paperclip-runner");
      const port = await freePort();
      const own = await startHolder({ runtimeRoot, session: "b".repeat(64), runId: current.runId, port, group: "plain" });
      await expect(retireSandboxRunnerPortHolders({ db: current.db, companyId: environment.current.companyId,
        agentId: environment.current.agentId, runId: current.runId, runner: confinedRunner(base) as never, runtimeRoot,
        ownSessionRoot: join(runtimeRoot, "sessions", "b".repeat(64)), providerLeaseId: "sandbox-1",
        retireInProcess: async () => false, waitMs: 3_000, pollMs: 100 })).resolves.toEqual([]);
      expect(own.exitCode).toBeNull();
      expect(await processGone(own.groupChild!)).toBe(false);
      expect(await bind(port)).toBe("EADDRINUSE");
    });

    it.each([
      ["no recorded run", null, {}, "runner_port_holder_unknown_owner"],
      ["a live run", "running", {}, "runner_port_holder_owner_not_settled"],
    ] as const)("R4 an own-directory holder owned by %s still fails the run closed", async (_name, status, state, reason) => {
      const { holder, port, retire } = await scenario(`own-dir-kept-${status}`, status, { ...state, session: "b".repeat(64), group: "plain" });
      const failure = await retire().then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(NativePredecessorRetirementUnprovenError);
      expect(((failure as Error).cause as Error).message).toBe(reason);
      expect(holder.exitCode).toBeNull();
      expect(await processGone(holder.groupChild!)).toBe(false);
      expect(await bind(port)).toBe("EADDRINUSE");
    });
  });
});
