import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noStoppedTurnProcessRemains, type StoppedTurnBox } from "./stopped-turn-process-gone.js";

/**
 * adopt-stopu-rpcspoof (rf-4 Part A, CUT BLOCKER 1): in RETAINED mode the
 * process-gone proof must not be spoofable by command-line text. rf-4's shape:
 * a current-run escaped (setsid) writer whose argv contains `--mode rpc`,
 * writing F. The retained Pi RPC process is spared ONLY by the identity the
 * runner hands over (pid + /proc start ticks); with no identity, nothing is
 * spared or killed and any candidate fails the proof (no export).
 */
const box = (remoteCwd: string): StoppedTurnBox => ({ remoteCwd, runner: {
  execute: input => new Promise(resolve => {
    const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, timeout: input.timeoutMs }, (error, stdout, stderr) =>
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
        timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
  }),
} });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const startTicks = async (pid: number) => (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ").pop()!.split(" ")[19]!;
const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
/** An ESCAPED process (setsid; own session/group, re-parented away from the runner), exec'd with argv0 'pi' and the given args. */
async function escaped(cwd: string, script: string, args: string, env: Record<string, string>, pidFile: string) {
  const child = spawn("sh", ["-c", `setsid sh -c '${script.replace(/'/g, `'\\''`)}' pi ${args} >/dev/null 2>&1 < /dev/null & echo $! > ${pidFile}`],
    { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  await new Promise(resolve => child.on("exit", resolve));
  for (let i = 0; i < 50; i++) { try { const pid = Number((await readFile(pidFile, "utf8")).trim()); if (pid) { pids.push(pid); return pid; } } catch { /* not yet */ } await sleep(20); }
  throw new Error("escaped process did not start");
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "stopu-rpcspoof-"));
  roots.push(root);
  const ws = join(root, "ws");
  await mkdir(ws);
  await writeFile(join(ws, "F"), "base\n");
  const runId = randomUUID();
  const turnStartedAt = new Date();
  await sleep(1_100);
  const turn = { PAPERCLIP_RUN_ID: runId };
  // The retained Pi RPC session: started in this turn, in the workspace, the run's id (a first-turn warm session).
  const pi = await escaped(ws, `exec perl -e "sleep 300" -- --mode rpc --session s`, "", turn, join(root, "pi.pid"));
  // rf-4's spoof: a current-run escaped writer whose argv carries '--mode rpc', writing F.
  const spoof = await escaped(ws, "while :; do echo spoof >> F; sleep 0.05; done", "--mode rpc", turn, join(root, "spoof.pid"));
  await sleep(300);
  const cmdline = (await readFile(`/proc/${spoof}/cmdline`, "utf8")).replace(/\0/g, " ");
  expect(cmdline).toContain("--mode rpc");
  return { ws, runId, turnStartedAt, pi, spoof };
}
async function lateWrites(ws: string) {
  const f1 = await readFile(join(ws, "F"), "utf8"); await sleep(400);
  return (await readFile(join(ws, "F"), "utf8")) !== f1;
}

for (const mode of ["local box (scoped)", "whole box"] as const) {
  describe(`rf-4 retained-rpc-name-spoof, ${mode}`, () => {
    const wholeBox = mode === "whole box";
    it("with the runner's identity: the spoof is killed, the real retained Pi survives, F is stable", async () => {
      const { ws, runId, turnStartedAt, pi, spoof } = await setup();
      const proof = await noStoppedTurnProcessRemains(box(ws), turnStartedAt, { runId, wholeBox, retainedSession: true,
        retainedProcess: { pid: pi, startTicks: await startTicks(pi) }, timeoutMs: 15_000 });
      await sleep(200);
      const state = { proof, spoofAlive: alive(spoof), piAlive: alive(pi), lateWrites: await lateWrites(ws) };
      console.info(`[stopu-rpcspoof] ${mode} identity ${JSON.stringify(state)}`);
      expect(proof).toMatchObject({ proven: true });
      expect(proof.proven && proof.killed).toContain(String(spoof));
      expect(state).toMatchObject({ spoofAlive: false, piAlive: true, lateWrites: false });
    }, 60_000);
    it("a wrong identity (right pid, other start time) spares nothing: the pid's process is the turn's", async () => {
      const { ws, runId, turnStartedAt, pi, spoof } = await setup();
      const proof = await noStoppedTurnProcessRemains(box(ws), turnStartedAt, { runId, wholeBox, retainedSession: true,
        retainedProcess: { pid: pi, startTicks: String(Number(await startTicks(pi)) + 1) }, timeoutMs: 15_000 });
      await sleep(200);
      expect(proof).toMatchObject({ proven: true });
      expect({ spoofAlive: alive(spoof), piAlive: alive(pi), lateWrites: await lateWrites(ws) })
        .toEqual({ spoofAlive: false, piAlive: false, lateWrites: false });
    }, 60_000);
    it("no identity handed over: NOT proven (no export), nothing spared by text", async () => {
      const { ws, runId, turnStartedAt, pi, spoof } = await setup();
      const proof = await noStoppedTurnProcessRemains(box(ws), turnStartedAt, { runId, wholeBox, retainedSession: true, timeoutMs: 15_000 });
      console.info(`[stopu-rpcspoof] ${mode} no-identity ${JSON.stringify({ proof, spoofAlive: alive(spoof), piAlive: alive(pi) })}`);
      expect(proof).toMatchObject({ proven: false, detail: "retained_session_process_unidentified" });
      expect(!proof.proven && proof.remaining).toEqual(expect.arrayContaining([String(spoof), String(pi)]));
    }, 60_000);
  });
}
