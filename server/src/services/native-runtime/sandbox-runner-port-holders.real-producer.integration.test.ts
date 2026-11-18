// B1 fence (b), rf-4 shape: every row runs the REAL Rust producer. A Runner here is the
// production child-launch script (REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT: identity marker + exec)
// exec'ing `reaper_real_producer` (runner-core/examples), which writes runner-state.json with
// DurableStateStore, enables the process-lineage journal exactly as paperclip-runnerd does, and
// starts each provider with SupervisedProcess::spawn, in the provider's OWN process group.
// PLANTED (named): the owner run's terminal DB status, the deliberately partial trace file, and
// in R6 the corrupt journal / the removed writer marker. Nothing else is hand-written.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT } from "./native-session-executor.js";
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";
import { retireSandboxRunnerPortHolders, sandboxSessionRunnerExited } from "./sandbox-runner-port-holders.js";

const PRODUCER = process.env.PAPERCLIP_REAPER_REAL_PRODUCER ?? fileURLToPath(new URL(
  "../../../../packages/paperclip-runner/runner/target/debug/examples/reaper_real_producer", import.meta.url));
// A provider that dies on TERM (its sleep child is in its group too), and one that ignores TERM.
const TERM_HONOURING = "while :; do sleep 1; done";
const TERM_IGNORING = "trap '' TERM; exec sleep 100000";

type Proc = { pid: number; pgid: number; state: string };
async function proc(pid: number): Promise<Proc | null> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (stat === null) return null;
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  return { pid, pgid: Number(fields[2]), state: fields[0]! };
}
const gone = async (pid: number) => { const p = await proc(pid); return p === null || p.state === "Z"; };

describeEmbeddedPostgres.skipIf(process.platform !== "linux" || !existsSync(PRODUCER))(
  "B1 fence (b): reaping a Runner stops every process group it recorded (real producer)", () => {
  const environment = nativeRestartFixture();
  const launched: ChildProcess[] = [];
  const groups: number[] = [];
  afterEach(async () => {
    for (const group of groups.splice(0)) try { process.kill(-group, "SIGKILL"); } catch { /* gone */ }
    for (const child of launched.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => child.once("exit", () => done()));
    }
  });
  const runner = (base: string) => ({ execute: async (request: { command: string; args?: string[] }) => {
    if ((request.args ?? []).slice(2).some(operand => operand.startsWith("/") && !operand.startsWith(`${base}/`))) {
      return { exitCode: 126, timedOut: false, stdout: "", stderr: "outside sandbox" };
    }
    const result = spawnSync(request.command, request.args ?? [], { encoding: "utf8", timeout: 20_000 });
    return { exitCode: result.status, timedOut: result.error !== undefined, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } });

  /** Launches one Runner through the production launch script (setsid as production does when available). */
  async function launchRunner(input: { runtimeRoot: string; session: string; runId: string; providers: string[]; setsid?: boolean }) {
    const stateDir = join(input.runtimeRoot, "sessions", input.session, "runner");
    await mkdir(stateDir, { recursive: true });
    const instance = `runner-${randomUUID()}`;
    const args = ["sh", "-c", REMOTE_RUNNER_CHILD_LAUNCH_SCRIPT, "paperclip-runner-child", join(stateDir, "runner-process.identity"),
      `nonce${randomUUID().replaceAll("-", "")}`, instance, join(stateDir, "diagnostics"), PRODUCER,
      "--runner-id", instance, "--run-id", input.runId, "--state-dir", stateDir,
      ...input.providers.flatMap(script => ["--provider-script", script])];
    const child = input.setsid === false ? spawn(args[0]!, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("setsid", args, { stdio: ["ignore", "pipe", "pipe"] });
    launched.push(child);
    const providers = await new Promise<number[]>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stderr!.on("data", chunk => { stderr += chunk; });
      child.stdout!.on("data", chunk => {
        stdout += chunk;
        const ready = /ready ([\d ]+)\n/.exec(stdout);
        if (ready) resolve(ready[1]!.trim().split(" ").map(Number));
      });
      child.once("exit", code => reject(new Error(`real producer exited ${code}: ${stderr}`)));
    });
    groups.push(...providers);
    const runnerProc = (await proc(child.pid!))!;
    const providerProcs = await Promise.all(providers.map(async pid => (await proc(pid))!));
    // The F1 topology: each provider leads its own group, apart from runnerd's.
    for (const provider of providerProcs) {
      expect(provider.pgid).toBe(provider.pid);
      expect(provider.pgid).not.toBe(runnerProc.pgid);
    }
    return { child, runnerPid: child.pid!, runnerPgid: runnerProc.pgid, providers, stateDir };
  }

  async function seedOwners(label: string) {
    const owner = await environment.seedRun(`RP2-OWNER-${label}`);
    const current = await environment.seedRun(`RP2-NEXT-${label}`, owner.db);
    // PLANTED: the finished owner's terminal status (a producer row, not a person's Stop).
    await owner.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, owner.runId));
    const base = join(environment.current.runtimeRoot, `rp2-${label}-${randomUUID().slice(0, 8)}`);
    return { owner, current, base, runtimeRoot: join(base, ".paperclip-runtime", "paperclip-runner") };
  }

  type Owners = Awaited<ReturnType<typeof seedOwners>>;
  function retire(input: Owners & { ownSessionRoot?: string; retireInProcess?: (runId: string) => Promise<boolean> }) {
    return retireSandboxRunnerPortHolders({ db: input.current.db, companyId: environment.current.companyId,
      agentId: environment.current.agentId, runId: input.current.runId, runner: runner(input.base) as never,
      runtimeRoot: input.runtimeRoot, ownSessionRoot: input.ownSessionRoot ?? "", providerLeaseId: "rp2-box",
      retireInProcess: input.retireInProcess ?? (async () => false), waitMs: 1_500, pollMs: 50 });
  }

  async function outcomeOf(db: Owners["current"]["db"], runId: string) {
    const [activity] = await db.select().from(activityLog)
      .where(and(eq(activityLog.runId, runId), eq(activityLog.action, "native.runner_port_holder_retired")));
    return (activity?.details as { outcome?: string } | undefined)?.outcome;
  }

  async function snapshot(root: string) {
    const files: Record<string, string> = {};
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          let bytes = await readFile(path);
          // runnerd's own sampler advances only `sampled_through` while it is alive; that is the
          // Runner's write, not the reaper's. Every other byte of every file is compared.
          if (/process-lineage\/lineage-[^/]+\.json$/.test(path)) {
            const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
            delete record.sampled_through;
            bytes = Buffer.from(JSON.stringify(record));
          }
          files[relative(root, path)] = bytes.toString("base64");
        }
      }
    };
    await walk(root);
    return files;
  }

  it("R1: a reap stops runnerd AND its provider in its own group (TERM is enough)", async () => {
    const x = await seedOwners("r1");
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "a".repeat(64), runId: x.owner.runId, providers: [TERM_HONOURING] });
    await expect(retire(x)).resolves.toEqual([x.owner.runId]);
    expect(await gone(r.runnerPid)).toBe(true);
    expect(await gone(r.providers[0]!), "the provider's own group must be reaped too").toBe(true);
    expect(await outcomeOf(x.current.db, x.current.runId)).toBe("stopped");
  });

  it("R2: the server's own close (retireInProcess) of a Runner whose provider outlives runnerd stops and proves the provider gone", async () => {
    const x = await seedOwners("r2");
    const session = "a".repeat(64);
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session, runId: x.owner.runId, providers: [TERM_IGNORING] });
    let exitedWhileProviderLived: boolean | null = null;
    // The server's in-process close ends runnerd only; the provider's group lives on.
    const retireInProcess = async () => {
      process.kill(-r.runnerPgid, "SIGTERM");
      await new Promise<void>(done => r.child.exitCode !== null || r.child.signalCode !== null ? done() : r.child.once("exit", () => done()));
      expect(await gone(r.providers[0]!)).toBe(false);
      exitedWhileProviderLived = await sandboxSessionRunnerExited({ runner: runner(x.base) as never, runtimeRoot: x.runtimeRoot,
        sessionDirectory: session });
      return true;
    };
    await expect(retire({ ...x, retireInProcess })).resolves.toEqual([x.owner.runId]);
    expect(exitedWhileProviderLived, "a Runner is not exited while a group it recorded has a member").toBe(false);
    expect(await gone(r.providers[0]!), "the server's own close must stop the recorded provider group").toBe(true);
    expect(await sandboxSessionRunnerExited({ runner: runner(x.base) as never, runtimeRoot: x.runtimeRoot, sessionDirectory: session }))
      .toBe(true);
  });

  it("R3: a TERM-ignoring provider needs the KILL step; success only once it is gone", async () => {
    const x = await seedOwners("r3");
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "a".repeat(64), runId: x.owner.runId,
      providers: [TERM_IGNORING, TERM_HONOURING] });
    await expect(retire(x)).resolves.toEqual([x.owner.runId]);
    expect(await gone(r.runnerPid)).toBe(true);
    for (const provider of r.providers) expect(await gone(provider)).toBe(true);
    expect(await outcomeOf(x.current.db, x.current.runId)).toBe("killed");
  });

  it("R4: Q's own live runner (and its provider) is untouched; P's runner in Q's own session directory is reaped", async () => {
    const x = await seedOwners("r4");
    const own = join(x.runtimeRoot, "sessions", "b".repeat(64));
    // P (finished) left its Runner in the directory Q continues (G1); Q's own live Runner is elsewhere (adopted).
    const p = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "b".repeat(64), runId: x.owner.runId, providers: [TERM_IGNORING] });
    const q = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "c".repeat(64), runId: x.current.runId, providers: [TERM_IGNORING] });
    await expect(retire({ ...x, ownSessionRoot: own })).resolves.toEqual([x.owner.runId]);
    expect(await gone(p.runnerPid)).toBe(true);
    expect(await gone(p.providers[0]!)).toBe(true);
    expect(await gone(q.runnerPid)).toBe(false);
    expect(await gone(q.providers[0]!)).toBe(false);
  });

  it("R4b: a no-setsid runnerd shares a group with a protected process; only its own pid and recorded groups are signalled", async () => {
    const x = await seedOwners("r4b");
    const protectedProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    launched.push(protectedProcess);
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "a".repeat(64), runId: x.owner.runId, providers: [TERM_IGNORING],
      setsid: false });
    expect(r.runnerPgid).not.toBe(r.runnerPid);
    await expect(retire(x)).resolves.toEqual([x.owner.runId]);
    expect(await gone(r.runnerPid)).toBe(true);
    expect(await gone(r.providers[0]!)).toBe(true);
    expect(await gone(protectedProcess.pid!)).toBe(false);
  });

  it("R5: journals and session files are byte-identical after the reap; nothing is deleted", async () => {
    const x = await seedOwners("r5");
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "a".repeat(64), runId: x.owner.runId, providers: [TERM_IGNORING] });
    // PLANTED: a deliberately partial trace line next to the real producer's state.
    const trace = join(r.stateDir, "planted-partial-journal.jsonl");
    const partial = Buffer.from('{"seq":1}\n{"seq":2,"partial":');
    await writeFile(trace, partial);
    const lineage = (await readdir(join(r.stateDir, "process-lineage"))).sort();
    expect(lineage.some(name => name.startsWith("lineage-"))).toBe(true);
    const before = await snapshot(x.runtimeRoot);
    await expect(retire(x)).resolves.toEqual([x.owner.runId]);
    expect(await gone(r.providers[0]!)).toBe(true);
    expect(await snapshot(x.runtimeRoot)).toEqual(before);
    expect(await readFile(trace)).toEqual(partial);
    expect((await readdir(join(r.stateDir, "process-lineage"))).sort()).toEqual(lineage);
  });

  it.each([
    ["a corrupt lineage journal", async (stateDir: string, pid: number) => {
      // PLANTED: an unreadable journal may name live processes.
      await writeFile(join(stateDir, "process-lineage", `lineage-${pid}-99.json`), "{not json");
    }],
    ["a live runnerd whose journal writer marker is missing", async (stateDir: string, pid: number) => {
      // PLANTED: the marker's absence (runnerd keeps running when it cannot journal).
      await rm(join(stateDir, "process-lineage", `writer-${pid}.json`));
    }],
  ] as const)("R6: %s is unclassifiable: fail closed, nothing signalled", async (_name, plant) => {
    const x = await seedOwners(`r6-${_name.length}`);
    const r = await launchRunner({ runtimeRoot: x.runtimeRoot, session: "a".repeat(64), runId: x.owner.runId, providers: [TERM_HONOURING] });
    await plant(r.stateDir, r.runnerPid);
    const failure = await retire(x).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NativePredecessorRetirementUnprovenError);
    expect(await gone(r.runnerPid)).toBe(false);
    expect(await gone(r.providers[0]!)).toBe(false);
  });
});
