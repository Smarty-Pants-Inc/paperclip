import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDb, pluginJobRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Production defaults of createPluginJobScheduler, which createApp uses unchanged.
const JOB_TIMEOUT_MS = 5 * 60_000;
const TICK_INTERVAL_MS = 30_000;
const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const childScript = fileURLToPath(new URL("./helpers/plugin-real-loader-process.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/sleepy-job/", import.meta.url));

type Execution = { event: "start" | "end"; runId: string; scheduledAt?: string; trigger?: string; pid: number; at: string };

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until<T>(label: string, deadline: number, read: () => Promise<T | undefined>): Promise<T> {
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (last !== undefined) return last;
    await delay(250);
  }
  throw new Error(`${label} timed out`);
}

/** A real server (createApp + production loader and scheduler) in its own OS process. */
async function startServer(databaseUrl: string, logFile: string, install?: string) {
  const child = spawn(process.execPath, ["--import", "tsx", childScript], {
    cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, REAL_LOADER_DATABASE_URL: databaseUrl, ...(install ? { REAL_LOADER_INSTALL: install } : {}) },
  });
  const log = createWriteStream(logFile, { flags: "a" });
  child.stderr!.pipe(log, { end: false });
  const ready = new Promise<{ pid: number; pluginId: string | null }>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on("line", line => {
      log.write(`${line}\n`);
      if (line.startsWith("REAL_LOADER_READY ")) resolve(JSON.parse(line.slice("REAL_LOADER_READY ".length)));
    });
    child.once("exit", (code, signal) => reject(new Error(`server exited before ready: ${code ?? signal}; see ${logFile}`)));
  });
  const timeout = delay(180_000).then(() => { throw new Error(`server start timed out; see ${logFile}`); });
  return { child, ...(await Promise.race([ready, timeout])) };
}

async function stopServer(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(30_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await exited;
}

const support = await getEmbeddedPostgresTestSupport();
// Keep reason: crash recovery across a real process boundary. A killed server
// cannot settle its run row; only a restarted server on the same database can.
it.skipIf(!support.supported)("reruns a due job once after its server is killed mid-job and restarted on the same database", async () => {
  const database = await startEmbeddedPostgresTestDatabase("plugin-job-server-kill-");
  const db = createDb(database.connectionString);
  // Inside the server tree so the worker resolves @paperclipai/plugin-sdk.
  await mkdir(path.join(serverRoot, "node_modules/.cache"), { recursive: true });
  const pkg = await mkdtemp(path.join(serverRoot, "node_modules/.cache/plugin-job-server-kill-"));
  const executionsFile = path.join(pkg, "runs.ndjson");
  const executions = async (): Promise<Execution[]> => (await readFile(executionsFile, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line) as Execution);
  let first: ChildProcess | undefined, second: ChildProcess | undefined;
  try {
    await cp(fixture, pkg, { recursive: true });
    await writeFile(path.join(pkg, "sleep-ms"), String(60 * 60_000));
    const a = await startServer(database.connectionString, path.join(pkg, "server-a.log"), pkg);
    first = a.child;
    const pluginId = a.pluginId!;

    // The cron job fires within a minute and sleeps: the run is mid-job.
    const orphanStart = await until("first scheduled execution", Date.now() + 90_000,
      async () => (await executions()).find(entry => entry.event === "start"));
    const orphan = await until("running run row", Date.now() + 10_000, async () => {
      const [row] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, orphanStart.runId));
      return row?.status === "running" ? row : undefined;
    });
    console.log("CJOB3_MID_JOB", JSON.stringify({ serverPid: a.pid, workerPid: orphanStart.pid, run: orphan.id,
      status: orphan.status, startedAt: orphan.startedAt, scheduledAt: orphanStart.scheduledAt }));

    // Kill the SERVER process mid-job. Its worker loses stdin and exits with it.
    const killed = new Promise(resolve => first!.once("exit", resolve));
    first.kill("SIGKILL");
    await killed;
    await until("orphaned worker exit", Date.now() + 15_000, async () => alive(orphanStart.pid) ? undefined : true);
    const [afterKill] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, orphan.id));
    console.log("CJOB3_KILLED", JSON.stringify({ serverPid: a.pid, workerAlive: alive(orphanStart.pid), runStatus: afterKill.status }));
    expect(afterKill.status).toBe("running");

    // Restart on the SAME database. Later executions finish at once.
    await writeFile(path.join(pkg, "sleep-ms"), "0");
    const b = await startServer(database.connectionString, path.join(pkg, "server-b.log"));
    second = b.child;
    const restartedAt = Date.now();
    console.log("CJOB3_RESTARTED", JSON.stringify({ serverPid: b.pid, pluginId }));

    // The owed occurrence runs again within worker timeout + one scheduler
    // interval of the orphaned run's start (plus 15s for dispatch and startup).
    const deadline = orphan.startedAt!.getTime() + JOB_TIMEOUT_MS + TICK_INTERVAL_MS + 15_000;
    let rerun: Execution | undefined;
    try {
      rerun = await until("rerun of the owed occurrence", deadline,
        async () => (await executions()).find(entry => entry.event === "start" && entry.runId !== orphan.id));
    } catch { /* asserted below with the evidence */ }
    const [orphanAfter] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, orphan.id));
    console.log("CJOB3_RERUN", JSON.stringify({ rerun: rerun ?? null, secondsAfterOrphanStart: rerun
      ? (Date.parse(rerun.at) - orphan.startedAt!.getTime()) / 1000 : null,
    secondsAfterRestart: (Date.now() - restartedAt) / 1000, orphanStatus: orphanAfter.status, orphanError: orphanAfter.error }));
    expect(rerun, "the due job never ran again after the server restart").toBeDefined();
    expect(rerun!.scheduledAt).toBe(orphanStart.scheduledAt);
    expect(rerun!.pid).not.toBe(orphanStart.pid);
    expect(orphanAfter.status).not.toBe("running");

    // ...and NOT twice: that occurrence starts exactly once after the restart,
    // never while the orphaned execution's worker was alive.
    const rerunRow = await until("rerun settlement", Date.now() + 30_000, async () => {
      const [row] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, rerun!.runId));
      return row && !["pending", "queued", "running"].includes(row.status) ? row : undefined;
    });
    await delay(5_000);
    const owed = (await executions()).filter(entry => entry.event === "start" && entry.scheduledAt === orphanStart.scheduledAt);
    console.log("CJOB3_ONCE", JSON.stringify({ owed, rerunStatus: rerunRow.status }));
    expect(owed.map(entry => entry.runId)).toEqual([orphan.id, rerun!.runId]);
    expect(rerunRow.status).toBe("succeeded");
  } finally {
    try { await stopServer(second); await stopServer(first); }
    finally {
      await db.$client.end({ timeout: 1 }); await database.cleanup();
      // Server logs and runs.ndjson stay for inspection when asked.
      if (process.env.PLUGIN_JOB_SERVER_KILL_KEEP) console.log("CJOB3_ARTIFACTS", pkg);
      else await rm(pkg, { recursive: true, force: true });
    }
  }
}, 10 * 60_000);
