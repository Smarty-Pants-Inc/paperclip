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

// Production default of createPluginJobScheduler, which createApp uses unchanged.
const JOB_TIMEOUT_MS = 5 * 60_000;
const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
const childScript = fileURLToPath(new URL("./helpers/plugin-real-loader-process.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/sleepy-job/", import.meta.url));

type Execution = { event: "start" | "end"; runId: string; scheduledAt?: string; trigger?: string; pid: number; at: string };

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until<T>(label: string, deadline: number, read: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`${label} timed out`);
}

/** A real server (createApp + production loader and scheduler) in its own OS process. */
async function startServer(databaseUrl: string, logFile: string, install: string) {
  const child = spawn(process.execPath, ["--import", "tsx", childScript], {
    cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, REAL_LOADER_DATABASE_URL: databaseUrl, REAL_LOADER_INSTALL: install },
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

// Keep reason: the RPC timeout settles the run row, but only the worker process
// knows whether the handler still runs. PLUGIN_SPEC §17 says the host prevents
// overlapping executions of one plugin job, so a timed-out run must not let the
// job start again while that worker is still running it. Real loader, real child
// worker, production timeout: a mocked worker cannot show the overlap.
it.skipIf(!support.supported)("does not start a job again while its timed-out execution's worker is still alive", async () => {
  const database = await startEmbeddedPostgresTestDatabase("plugin-job-timeout-overlap-");
  const db = createDb(database.connectionString);
  // Inside the server tree so the worker resolves @paperclipai/plugin-sdk.
  await mkdir(path.join(serverRoot, "node_modules/.cache"), { recursive: true });
  const pkg = await mkdtemp(path.join(serverRoot, "node_modules/.cache/plugin-job-timeout-overlap-"));
  const executionsFile = path.join(pkg, "runs.ndjson");
  const executions = async (): Promise<Execution[]> => (await readFile(executionsFile, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line) as Execution);
  let server: ChildProcess | undefined;
  try {
    await cp(fixture, pkg, { recursive: true });
    await writeFile(path.join(pkg, "sleep-ms"), String(60 * 60_000));
    const a = await startServer(database.connectionString, path.join(pkg, "server.log"), pkg);
    server = a.child;
    const first = await until("first scheduled execution", Date.now() + 90_000,
      async () => (await executions()).find(entry => entry.event === "start"));
    await writeFile(path.join(pkg, "sleep-ms"), "0");
    // The RPC times out at JOB_TIMEOUT_MS; the next minute's occurrence is then due.
    const next = await until("next execution", Date.parse(first.at) + JOB_TIMEOUT_MS + 60_000 + 15_000,
      async () => (await executions()).find(entry => entry.event === "start" && entry.runId !== first.runId));
    const firstEnded = (await executions()).some(entry => entry.event === "end" && entry.runId === first.runId);
    const firstWorkerAlive = alive(first.pid);
    const [firstRow] = await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, first.runId));
    console.log("PLUGIN_JOB_TIMEOUT_OVERLAP", JSON.stringify({ first, next, firstEnded, firstWorkerAlive,
      firstRow: { status: firstRow.status, error: firstRow.error } }));
    expect(firstRow.status).toBe("failed");
    // Either the first execution finished, or its worker was gone, before the next start.
    expect({ overlapped: !firstEnded && next.pid === first.pid }).toEqual({ overlapped: false });
    expect(firstWorkerAlive && !firstEnded).toBe(false);
  } finally {
    try { await stopServer(server); }
    finally {
      await db.$client.end({ timeout: 1 }); await database.cleanup();
      // Server log and runs.ndjson stay for inspection when asked.
      if (process.env.PLUGIN_JOB_TIMEOUT_OVERLAP_KEEP) console.log("PLUGIN_JOB_TIMEOUT_OVERLAP_ARTIFACTS", pkg);
      else await rm(pkg, { recursive: true, force: true });
    }
  }
}, 10 * 60_000);
