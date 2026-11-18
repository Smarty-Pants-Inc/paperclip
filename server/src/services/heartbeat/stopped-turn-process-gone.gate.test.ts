import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noStoppedTurnProcessRemains, type StoppedTurnBox } from "./stopped-turn-process-gone.js";

/**
 * adopt-stopu-round, GATE 1 (RFL 01:35Z (d) + rf-3's judge rows, RFL 01:40Z):
 * the ONE process-gone check (ugate2's noStoppedTurnProcessRemains) kills the
 * stopped turn's processes - a SIGTERM-ignoring writer, a respawning writer, an
 * escaped writer in its own session/process group - and spares everything
 * that is not the turn's: the runner's own processes (runnerd, the export's own
 * tar/sync, the provider) and a process an EARLIER turn started (a dev server).
 * Both scopes: the local box (same kernel, workspace-scoped) and the
 * whole-box mode a real sandbox uses.
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
const roots: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A process the runner (this test process: the check's ancestor) starts directly. */
function runnerChild(cwd: string, script: string, env: Record<string, string> = {}) {
  const child = spawn("sh", ["-c", script], { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  pids.push(child.pid!);
  return child.pid!;
}
/** An ESCAPED process (setsid + double fork: own session and group, re-parented away from the runner). Returns its pid. */
async function escaped(cwd: string, script: string, env: Record<string, string>, pidFile: string) {
  const child = spawn("sh", ["-c", `setsid sh -c '${script.replace(/'/g, `'\\''`)}' >/dev/null 2>&1 < /dev/null & echo $! > ${pidFile}`],
    { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  await new Promise(resolve => child.on("exit", resolve));
  for (let i = 0; i < 50; i++) { try { const pid = Number((await readFile(pidFile, "utf8")).trim()); if (pid) { pids.push(pid); return pid; } } catch { /* not yet */ } await sleep(20); }
  throw new Error("escaped process did not start");
}

for (const mode of ["local box (scoped)", "whole box"] as const) {
  describe(`GATE 1 (d) + rf-3 judge rows, ${mode}`, () => {
    const wholeBox = mode === "whole box";
    it("kills the turn's writers (SIGTERM-ignoring, respawning, escaped own-group) and spares the runner's own processes and an earlier turn's dev server", async () => {
      const root = await mkdtemp(join(tmpdir(), "stopu-round-gate1-"));
      roots.push(root);
      const ws = join(root, "ws");
      await (await import("node:fs/promises")).mkdir(ws);
      await writeFile(join(ws, "F"), "base\n");
      const runId = randomUUID(), earlierRunId = randomUUID();
      // An EARLIER turn's dev server (escaped, in the workspace, that turn's run id), started > slack before this turn.
      const devServer = await escaped(ws, "exec sleep 300", { PAPERCLIP_RUN_ID: earlierRunId }, join(root, "dev.pid"));
      await sleep(3_500);
      const turnStartedAt = new Date();
      await sleep(1_100);
      const turn = { PAPERCLIP_RUN_ID: runId };
      // The runner's own processes, started after the turn began: runnerd, the export's own tar (cwd in the workspace), the provider.
      const runnerd = runnerChild(root, "exec sleep 300");
      const exportTar = runnerChild(ws, "exec sleep 301");
      const provider = runnerChild(tmpdir(), "exec sleep 302");
      // The turn's: a foreground tool (runner child, marked), a SIGTERM-ignoring writer, a respawning writer, an escaped truncate writer.
      const foreground = runnerChild(ws, "exec sleep 303", turn);
      const ignoresTerm = await escaped(ws, "trap '' TERM; while :; do echo x > F; sleep 0.05; done", turn, join(root, "term.pid"));
      const respawner = await escaped(ws, "while :; do (while :; do echo r > F; sleep 0.05; done) & c=$!; wait $c; done", turn, join(root, "resp.pid"));
      const truncWriter = await escaped(root, `while :; do : > ${join(ws, "F")}; echo t >> ${join(ws, "F")}; done`, turn, join(root, "trunc.pid"));
      await sleep(300);
      const proof = await noStoppedTurnProcessRemains(box(ws), turnStartedAt, { runId, wholeBox, timeoutMs: 15_000 });
      await sleep(200);
      const state = { proof, devServer: alive(devServer), runnerd: alive(runnerd), exportTar: alive(exportTar), provider: alive(provider),
        foreground: alive(foreground), ignoresTerm: alive(ignoresTerm), respawner: alive(respawner), truncWriter: alive(truncWriter) };
      console.info(`[stopu-round-gate1] ${mode} ${JSON.stringify(state)}`);
      expect(proof.proven).toBe(true);
      // The turn's: none remain (escalation kills the SIGTERM-ignoring one; the respawner and its children are gone; the escaped own-group writer is gone).
      expect({ foreground: state.foreground, ignoresTerm: state.ignoresTerm, respawner: state.respawner, truncWriter: state.truncWriter })
        .toEqual({ foreground: false, ignoresTerm: false, respawner: false, truncWriter: false });
      // Not the turn's: they SURVIVE.
      // (The local box shares the controller's kernel, so it is scoped to the workspace: there a runner child
      // working IN the workspace counts. Whole-box mode, a real sandbox, spares the runner's own chain.)
      expect({ devServer: state.devServer, runnerd: state.runnerd, provider: state.provider, ...(wholeBox ? { exportTar: state.exportTar } : {}) })
        .toEqual({ devServer: true, runnerd: true, provider: true, ...(wholeBox ? { exportTar: true } : {}) });
      // Successor on the same box: no process of the stopped turn remains (a second check finds and kills nothing).
      const again = await noStoppedTurnProcessRemains(box(ws), turnStartedAt, { runId, wholeBox, timeoutMs: 15_000 });
      expect(again).toMatchObject({ proven: true, killed: [] });
      // F is stable after the kill (no writer left).
      const f1 = await readFile(join(ws, "F"), "utf8"); await sleep(300);
      expect(await readFile(join(ws, "F"), "utf8")).toBe(f1);
    }, 60_000);
  });
}
