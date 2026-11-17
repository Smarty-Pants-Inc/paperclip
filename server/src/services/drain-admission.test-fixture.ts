import { promises as fs } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { createDb, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { currentHostMutationDrain, type HostMutationDrain } from "@paperclipai/adapter-utils/host-mutation-drain";
import { finishCancelledWarmWorkspaceExport } from "./heartbeat/cancelled-warm-workspace-export.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";

type Sync = NonNullable<Parameters<typeof finishCancelledWarmWorkspaceExport>[0]["nativeWorkspaceSync"]>;
type Fixture = { host: string; box: string; runId: string; companyId: string; sync: Sync };
export type DrainAdmissionBranch = "parent-mkdir" | "publish-rename" | "symlink-parent-mkdir";
export type DrainAdmissionCause = "deadline" | "lock-session-kill";

async function until(check: () => boolean | Promise<boolean>, message: string, ms = 25_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/** KEEP: the rf-4 never-OK overwrite guards, replaced under RFL
 * SUPERSEDE-U-DRAIN-ADMISSION-1117. Real ownership + local fs + embedded PG.
 * Spy on every promise-fs mutation, not only the held operation, and on writable
 * FileHandle methods. Async-local drain identity separates the old export from
 * the successor/test evidence writes. Record dispatch AND completion: a delayed
 * syscall completing after the drain is just as forbidden as a new dispatch.
 */
export async function assertDrainAdmissionReplacement(input: {
  db: Db; connectionString: string; f: Fixture; branch: DrainAdmissionBranch; cause: DrainAdmissionCause;
}) {
  const { db, f, branch, cause } = input;
  if (branch === "symlink-parent-mkdir") {
    await fs.rm(join(f.box, "task.txt"));
    await fs.symlink("zzz-stopped-target", join(f.box, "task.txt"));
    await fs.writeFile(join(f.box, "zzz-stopped-target"), "edited on the box by the stopped turn\n");
  }
  let drain: HostMutationDrain | undefined;
  let drainCompleted = false;
  let successorStarted = false;
  let closedAt = 0;
  let release!: () => void;
  let arrived = false;
  let heldReturned = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  type Mutation = { method: string; path: string; phase: "dispatch" | "complete"; afterDrain: boolean; afterSuccessor: boolean; ms: number };
  const mutations: Mutation[] = [];
  const started = Date.now();
  const record = (method: string, path: unknown, phase: Mutation["phase"]) => {
    if (drain && currentHostMutationDrain() === drain) mutations.push({ method, path: String(path), phase,
      afterDrain: drainCompleted, afterSuccessor: successorStarted, ms: Date.now() - started });
  };
  // All mutating fs.promises APIs, including operations not used by today's
  // branch. Read-only open is excluded, but its handle is still instrumented.
  const methods = ["appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link", "lutimes",
    "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile"] as const;
  const spies: Array<{ mockRestore(): void }> = [];
  for (const method of methods) {
    const target = fs as unknown as Record<string, (...args: any[]) => Promise<any>>;
    if (typeof target[method] !== "function") continue;
    const original = target[method].bind(fs);
    spies.push(vi.spyOn(target, method).mockImplementation(async (...args: any[]) => {
      const path = method === "rename" || method === "copyFile" || method === "cp" || method === "link" || method === "symlink" ? args[1] : args[0];
      const matches = branch === "publish-rename"
        ? method === "rename" && String(args[1]) === join(f.host, "task.txt")
        : method === "mkdir" && String(args[0]) === f.host;
      record(method, path, "dispatch");
      if (matches) { arrived = true; await held; }
      try { return await original(...args); }
      finally {
        if (matches) heldReturned = true;
        record(method, path, "complete");
      }
    }));
  }
  const originalOpen = fs.open.bind(fs);
  spies.push(vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const writable = args[1] !== "r" && args[1] !== undefined;
    if (writable) record("open", args[0], "dispatch");
    const handle = await originalOpen(...args);
    if (writable) record("open", args[0], "complete");
    const target = handle as unknown as Record<string, (...args: any[]) => Promise<any>>;
    for (const method of ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes"]) {
      const original = target[method].bind(handle);
      spies.push(vi.spyOn(target, method).mockImplementation(async (...values: any[]) => {
        record(`FileHandle.${method}`, args[0], "dispatch");
        try { return await original(...values); }
        finally { record(`FileHandle.${method}`, args[0], "complete"); }
      }));
    }
    return handle;
  }));
  let exportPromise: Promise<void> | undefined;
  const restore = f.sync.restoreWorkspace.bind(f.sync);
  spies.push(vi.spyOn(f.sync, "restoreWorkspace").mockImplementation((...args) => {
    drain = currentHostMutationDrain();
    expect(drain).toBeDefined();
    const close = drain!.close.bind(drain);
    spies.push(vi.spyOn(drain!, "close").mockImplementation(reason => {
      if (!closedAt) closedAt = Date.now();
      close(reason);
    }));
    const closeAndDrain = drain!.closeAndDrain.bind(drain);
    spies.push(vi.spyOn(drain!, "closeAndDrain").mockImplementation(async (...values) => {
      const result = await closeAndDrain(...values);
      if (result.drained) drainCompleted = true;
      return result;
    }));
    const drained = drain!.drained.bind(drain);
    spies.push(vi.spyOn(drain!, "drained").mockImplementation(async () => {
      await drained();
      drainCompleted = true;
    }));
    return exportPromise = restore(...args);
  }));
  const profile = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].runnerProfileJson;
  let admitted = 0;
  const nextOwner = (connection = db) => withNativeWorkspaceFinalizationOwnership({ db: connection, companyId: f.companyId, runId: f.runId }, async () => {
    admitted += 1;
    successorStarted = true;
    await fs.writeFile(join(f.host, "task.txt"), "NEXT OWNER");
    return "next owner wrote";
  });
  let work: ReturnType<typeof finishCancelledWarmWorkspaceExport> | undefined;
  let otherDb: Db | undefined;
  let resetDatabase: string | undefined;
  try {
    if (cause === "lock-session-kill") {
      const [row] = await db.execute(sql`select current_database() as name`);
      resetDatabase = String(row.name);
      await db.execute(sql.raw(`alter database "${resetDatabase}" set idle_in_transaction_session_timeout = '3s'`));
    }
    work = finishCancelledWarmWorkspaceExport({ db, runId: f.runId, companyId: f.companyId,
      nativeWorkspaceSync: f.sync, timeoutMs: cause === "deadline" ? 3_000 : 30_000 });
    work.catch(() => undefined);
    await until(() => arrived, `never reached ${branch}`, 15_000);
    const ownerBefore = (await profile())?.nativeWorkspaceFinalizationOwner as { token: string };
    expect(ownerBefore.token).toEqual(expect.any(String));
    let lockFree: number | undefined;
    if (cause === "lock-session-kill") {
      const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted and pid <> pg_backend_pid()`);
      expect(lockers).toHaveLength(1);
      await db.execute(sql`select pg_terminate_backend(${Number(lockers[0].pid)})`);
      await until(() => drain!.closed, "lock loss never closed the drain");
      const [row] = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted and pid <> pg_backend_pid()`);
      lockFree = Number(row.n);
      expect(lockFree).toBe(0);
      // A distinct pool has no same-Db shortcut: it takes the now-free physical
      // lock and reads the durable token before refusing the still-active owner.
      otherDb = createDb(input.connectionString);
      expect(await nextOwner(otherDb)).toEqual({ acquired: false, reason: "busy" });
      expect((await profile())?.nativeWorkspaceFinalizationOwner).toEqual(ownerBefore);
    } else {
      expect(await work).toEqual({ outcome: "unproven", reason: "timed_out" });
    }
    const whileHeld = await nextOwner();
    expect(whileHeld).toEqual({ acquired: false, reason: "owner_active" });
    expect(admitted).toBe(0);
    let notice: typeof heartbeatRunEvents.$inferSelect | undefined;
    await until(async () => {
      const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      notice = rows.find(row => (row.payload as { prpEvent?: { payload?: { category?: string } } } | null)?.prpEvent?.payload?.category === "workspace_host_write_draining");
      return Boolean(notice);
    }, "no true 10 s drain-cap line");
    const lineAfterCloseMs = Date.now() - closedAt;
    expect(lineAfterCloseMs).toBeGreaterThanOrEqual(10_000 - 100);
    expect(notice).toMatchObject({ eventType: "provider.notice.recorded", level: "warn",
      message: "A file write on this host from this run's workspace export has not finished after 10 s. The workspace stays held, so nothing else writes to it until that write ends." });
    expect(heldReturned).toBe(false);
    expect(drainCompleted).toBe(false);
    expect(await nextOwner()).toEqual({ acquired: false, reason: "owner_active" });
    expect((await profile())?.nativeWorkspaceFinalizationOwner).toEqual(ownerBefore);
    release();
    const exportError = await exportPromise!.then(() => null, error => String(error));
    expect(heldReturned).toBe(true);
    await until(async () => !(await profile())?.nativeWorkspaceFinalizationOwner, "durable owner never released after drain");
    expect(drainCompleted).toBe(true);
    const next = await nextOwner();
    expect(next).toMatchObject({ acquired: true, value: "next owner wrote" });
    expect(admitted).toBe(1);
    const outcome = await work;
    expect(outcome).toEqual({ outcome: "unproven", reason: cause === "deadline" ? "timed_out" : "ownership_lost" });
    await new Promise(resolve => setTimeout(resolve, 250));
    const actual = await fs.readFile(join(f.host, "task.txt"), "utf8");
    expect((await fs.lstat(join(f.host, "task.txt"))).isSymbolicLink()).toBe(false);
    const afterDrain = mutations.filter(row => row.afterDrain);
    const proof = { branch, cause, whileHeld, lockFree, durableToken: ownerBefore.token, lineAfterCloseMs,
      notice: { message: notice!.message, payload: notice!.payload }, next, admitted, exportError, outcome, actual,
      mutations, afterDrain, afterSuccessor: mutations.filter(row => row.afterSuccessor) };
    await fs.writeFile(join(process.env.TASK_OUT!, `replacement-${branch}-${cause}.json`), JSON.stringify(proof, null, 2));
    console.log("DRAIN_ADMISSION_REPLACEMENT", JSON.stringify({ ...proof, mutations: mutations.length }));
    expect(mutations.some(row => row.method === (branch === "publish-rename" ? "rename" : "mkdir") && row.phase === "complete")).toBe(true);
    expect(actual).toBe("NEXT OWNER");
    expect(proof.afterSuccessor).toEqual([]);
    // Deliberately literal: the brief says ZERO fs mutations after the drain.
    // Keep private cleanup visible rather than silently narrowing that promise.
    expect(afterDrain).toEqual([]);
  } finally {
    release();
    await exportPromise?.catch(() => undefined);
    await work?.catch(() => undefined);
    if (otherDb) await otherDb.$client.end();
    if (resetDatabase) await db.execute(sql.raw(`alter database "${resetDatabase}" reset idle_in_transaction_session_timeout`));
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}
