import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, issues, executionWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { withSkillVersionCacheLock } from "./skill-version-cache.js";
import { withWorkspaceMoveLocks } from "./isolated-repository-rehome.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`keepalive5 lock-loss tests require Postgres: ${support.reason}`);

/**
 * pl/keepalive5: the five other withWorkspaceLockKeepalive callers. A failed
 * keepalive ping (the lock session was terminated) must abort the guarded
 * work: no host write after the loss, and the caller sees a typed failure.
 */
describePostgres("keepalive6 judges: an outer or own lock-session loss stops every nested host write", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let host: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("keepalive6-");
    db = createDb(database.connectionString);
    const [{ name }] = await db.execute(sql`select current_database() as name`) as unknown as Array<{ name: string }>;
    // New sessions only: the lock sessions ping every 1 s, so the timeout itself never cuts them here.
    await db.execute(sql.raw(`alter database "${name}" set idle_in_transaction_session_timeout = '3s'`));
  }, 120_000);

  afterAll(async () => {
    try { await db?.$client.end({ timeout: 1 }); } finally { await database?.cleanup(); }
  });

  /** Runs `start(work)` with a held guarded work, kills the session holding `key`, lets a second owner write, releases. */
  async function lockLoss(key: string, start: (work: (signal?: AbortSignal) => Promise<string>) => Promise<string>) {
    host = await mkdtemp(join(tmpdir(), "keepalive5-host-"));
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let finished!: () => void;
    let workError: unknown = null;
    // The work itself, not only the caller's promise: a dead connection can reject the caller early while the work runs on.
    const workEnded = new Promise<void>(resolve => { finished = resolve; });
    const op = start(async (signal) => {
      try {
        entered();
        await gate;
        // A guarded host write after a lock wait re-checks the lock-loss signal.
        signal?.throwIfAborted();
        await writeFile(join(host, "late.txt"), "the first owner's late write\n");
        return "done";
      } catch (error) {
        workError = error;
        throw error;
      } finally { finished(); }
    }).then(value => ({ value }), (error: unknown) => ({ error }));
    await Promise.race([inside, op.then(result => { throw new Error(`op settled before entering: ${JSON.stringify(result)}`); })]);
    const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
      and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
      and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)`) as unknown as Array<{ pid: number }>;
    expect(lockers).toHaveLength(1);
    await db.execute(sql`select pg_terminate_backend(${lockers[0].pid})`);
    let second = false;
    for (let attempt = 0; attempt < 50 && !second; attempt += 1) {
      second = await db.transaction(async tx => {
        const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
        const acquired = rows[0]?.acquired === true;
        if (acquired) await writeFile(join(host, "next.txt"), "the next owner's write\n");
        return acquired;
      });
      if (!second) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(second).toBe(true);
    // The keepalive pings every second (3 s / 3): let it see the dead session, then release the held work.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    release();
    const result = await op;
    await workEnded;
    const late = existsSync(join(host, "late.txt"));
    const next = existsSync(join(host, "next.txt"));
    await rm(host, { recursive: true, force: true });
    console.log("JUDGE_LOCK_LOSS", JSON.stringify({key, late, next, workError: (workError as Error | null)?.name ?? null, callerFailed: "error" in result}));
    return { result, late, next, workError };
  }

  function expectStopped(outcome: Awaited<ReturnType<typeof lockLoss>>, errorName: string) {
    expect(outcome.next).toBe(true);
    expect(outcome.late).toBe(false);
    // The work stopped with the typed lost-lock error, and its caller saw a failure (never a success).
    expect((outcome.workError as Error | null)?.name).toBe(errorName);
    expect("error" in outcome.result ? "failed" : `resolved ${JSON.stringify(outcome.result)}`).toBe("failed");
  }

  // ---- RFL's judge-keepalive.test.ts: the nested-loss rows + the long-step row (unchanged) ----
  it("JUDGE: source-session loss aborts the nested lifecycle writer, not just the outer promise", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "judge nested source lock", issuePrefix: companyId.slice(0,8) });
    await db.insert(issues).values({ id: issueId, companyId, title: "nested lifecycle" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated", strategyType: "directory", name: "nested", providerType: "local_fs" });
    const outcome = await lockLoss(`isolated_repository_source:${companyId}:${issueId}`,
      work => withExecutionWorkspaceLifecycleLock(db, workspaceId, (_tx, signal) => work(signal)));
    expect(outcome.next).toBe(true);
    expect(outcome.late).toBe(false);
  }, 60_000);

  it("JUDGE: source-session loss aborts the nested rehome writer, not just the outer promise", async () => {
    const workspace = { id: randomUUID(), companyId: randomUUID(), sourceIssueId: randomUUID(), projectId: null,
      cwd: null, providerRef: null } as never as Parameters<typeof withWorkspaceMoveLocks>[1];
    const outcome = await lockLoss(`isolated_repository_source:${workspace.companyId}:${workspace.sourceIssueId}`,
      work => withWorkspaceMoveLocks(db, workspace, (_tx, signal) => work(signal)));
    expect(outcome.next).toBe(true);
    expect(outcome.late).toBe(false);
  }, 60_000);

  it("JUDGE: a long cache step survives a live 3s idle-tx setting (120s scaled by 40)", async () => {
    const companyId = randomUUID();
    const started = Date.now();
    const value = await withSkillVersionCacheLock(db, companyId, async (signal) => {
      const held = await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted
        and classid::bigint=((hashtextextended(${`skill_version_cache:${companyId}`},0)>>32)&4294967295)
        and objid::bigint=(hashtextextended(${`skill_version_cache:${companyId}`},0)&4294967295)`);
      expect(held).toHaveLength(1);
      const [setting] = await db.execute(sql`select setting from pg_settings where name='idle_in_transaction_session_timeout'`);
      // The main pool predates ALTER DATABASE; verify on the actual lock session by observing its continued ownership.
      await new Promise(resolve => setTimeout(resolve, 9500));
      signal?.throwIfAborted();
      const still = await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted and pid=${held[0].pid}`);
      expect(still.length).toBeGreaterThan(0);
      console.log("JUDGE_LONG_STEP", JSON.stringify({elapsedMs:Date.now()-started, lockPid:held[0].pid, stillHeld:true, lockSessionTimeoutMs:3000}));
      return "survived";
    });
    expect(value).toBe("survived");
  }, 60_000);

  // ---- rf-4's cf5ka-keepalive5 boundary fragments (unchanged, except TASK_OUT falls back to tmpdir) ----
  it('INDEPENDENT move must stop when its OUTER source-lock session dies', async () => {
    const workspace = { id: randomUUID(), companyId: randomUUID(), sourceIssueId: randomUUID(), projectId: null,
      cwd: null, providerRef: null } as never as Parameters<typeof withWorkspaceMoveLocks>[1];
    const outcome = await lockLoss(`isolated_repository_source:${workspace.companyId}:${workspace.sourceIssueId}`,
      work => withWorkspaceMoveLocks(db, workspace, (_tx, signal?: AbortSignal) => work(signal)));
    console.log('INDEPENDENT_OUTER_SOURCE_LOSS', JSON.stringify({ late: outcome.late, next: outcome.next,
      workError: String(outcome.workError), result: outcome.result }));
    expectStopped(outcome, 'WorkspaceSourceLockLostError');
  }, 45_000);

  it('INDEPENDENT actual skill-cache mkdir helper cannot create directories after lock loss', async () => {
    const { promises: fs } = await import('node:fs');
    const { vi } = await import('vitest');
    const { touchSkillVersionCache, skillVersionCachePaths } = await import('./skill-version-cache.js');
    const { dirname } = await import('node:path');
    const companyId = randomUUID(), skillId = randomUUID(), versionId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'keepalive5-real-skill-'));
    vi.stubEnv('PAPERCLIP_HOME', root);
    vi.stubEnv('PAPERCLIP_INSTANCE_ID', 'independent-skill');
    const paths = skillVersionCachePaths(companyId, skillId, versionId);
    let release!: () => void, reached!: () => void, finished!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const ended = new Promise<void>(resolve => { finished = resolve; });
    const original = fs.mkdir.bind(fs);
    let first = true, signal: AbortSignal | undefined;
    const spy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (first) { first = false; reached(); await gate; }
      return original(...args);
    });
    const op = withSkillVersionCacheLock(db, companyId, async lost => {
      signal = lost;
      try { await touchSkillVersionCache(companyId, skillId, versionId); return 'done'; }
      finally { finished(); }
    }).then(value => ({ value }), error => ({ error: String(error) }));
    try {
      await entered;
      const key = `skill_version_cache:${companyId}`;
      const lockers = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
        and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
        and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)`) as unknown as Array<{ pid: number }>;
      expect(lockers).toHaveLength(1);
      await db.execute(sql`select pg_terminate_backend(${lockers[0].pid})`);
      const second = await db.transaction(async tx => {
        const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`);
        if (rows[0]?.acquired === true) await writeFile(join(root, 'next.txt'), 'next owner');
        return rows[0]?.acquired;
      });
      expect(second).toBe(true);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 5_000 });
      release(); await ended;
      const result = await op;
      const lateDirectory = existsSync(dirname(paths.access));
      const proof = { lateDirectory, accessWritten: existsSync(paths.access), nextOwner: existsSync(join(root, 'next.txt')), result };
      console.log('INDEPENDENT_REAL_SKILL_DIRECTORY_LOSS', JSON.stringify(proof));
      await writeFile(join(process.env.TASK_OUT ?? tmpdir(), 'b-real-skill-loss-result.json'), JSON.stringify(proof, null, 2));
      expect(lateDirectory).toBe(false);
    } finally {
      release(); await ended; await op; spy.mockRestore(); vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  // ---- rf-4's cf5ka-keepalive5 independent fragment (unchanged) ----
  it.each(['source', 'lifecycle', 'skill', 'move'] as const)('INDEPENDENT healthy keepalive %s survives a 5s hold with 3s timeout', async (caller) => {
    const companyId = randomUUID(), id = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'keepalive5-healthy-'));
    const action = async (_txOrSignal?: unknown, signal?: AbortSignal) => {
      const effective = _txOrSignal instanceof AbortSignal ? _txOrSignal : signal;
      await new Promise(resolve => setTimeout(resolve, 5_000));
      effective?.throwIfAborted();
      await writeFile(join(root, 'healthy.txt'), 'healthy owner');
      return 'done';
    };
    try {
      const result = caller === 'source'
        ? await withWorkspaceSourceLocks(db, { companyId, issueIds: [id] }, action)
        : caller === 'lifecycle' ? await withExecutionWorkspaceLifecycleLock(db, id, action)
        : caller === 'skill' ? await withSkillVersionCacheLock(db, companyId, action)
        : await withWorkspaceMoveLocks(db, { id, companyId, sourceIssueId: randomUUID(), projectId: null, cwd: null, providerRef: null } as never, action);
      expect(result).toBe('done');
      expect(existsSync(join(root, 'healthy.txt'))).toBe(true);
      console.log('INDEPENDENT_HEALTHY_KEEPALIVE', caller, result);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);

  // ---- keepalive6: an outer loss drains the inner in-flight host call BEFORE the inner lock is released ----
  it("KEEPALIVE6 DRAIN: after the outer source lock is lost, the nested lifecycle lock is held until its in-flight host call returns; new host calls are refused", async () => {
    const { hostMutation } = await import("@paperclipai/adapter-utils/host-mutation-drain");
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "keepalive6 drain", issuePrefix: companyId.slice(0, 8) });
    await db.insert(issues).values({ id: issueId, companyId, title: "drain" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated", strategyType: "directory", name: "drain", providerType: "local_fs" });
    const dir = await mkdtemp(join(tmpdir(), "keepalive6-drain-"));
    const sourceKey = `isolated_repository_source:${companyId}:${issueId}`;
    const lifecycleKey = `execution_workspace_lifecycle:${workspaceId}`;
    let writing!: () => void, finishWrite!: () => void;
    const inWrite = new Promise<void>(resolve => { writing = resolve; });
    const writeGate = new Promise<void>(resolve => { finishWrite = resolve; });
    let refused: unknown = null;
    let settled = false;
    const op = withExecutionWorkspaceLifecycleLock(db, workspaceId, async (_tx, signal) => {
      // One host call in flight when the loss comes; the work itself stops at the loss (it does not await the call).
      const inFlight = hostMutation(async () => { writing(); await writeGate; await writeFile(join(dir, "in-flight.txt"), "started before the loss\n"); });
      inFlight.catch(() => undefined);
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }).catch(async (error) => {
        await hostMutation(() => writeFile(join(dir, "after-loss.txt"), "must be refused\n")).catch((cause: unknown) => { refused = cause; });
        throw error;
      });
      return "unreachable";
    }).then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    await inWrite;
    const pidOf = async (key: string) => (await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and granted
      and classid::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
      and objid::bigint = (hashtextextended(${key}, 0) & 4294967295)`) as unknown as Array<{ pid: number }>);
    const tryLock = (key: string) => db.transaction(async tx => (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`))[0]?.acquired === true);
    const [source] = await pidOf(sourceKey);
    expect(source).toBeTruthy();
    await db.execute(sql`select pg_terminate_backend(${source.pid})`);
    // The keepalive (1 s) sees the dead outer session; the inner work stops, its in-flight call is still held.
    await new Promise(resolve => setTimeout(resolve, 2_500));
    // (The caller's promise may already have failed: its outer source connection is dead. The inner lock must not be free.)
    const whileInFlight = { lifecycleAcquiredByNext: await tryLock(lifecycleKey), inFlightLanded: existsSync(join(dir, "in-flight.txt")) };
    await new Promise(resolve => setTimeout(resolve, 500));
    const stillInFlight = { lifecycleAcquiredByNext: await tryLock(lifecycleKey) };
    const settledEarly = settled;
    finishWrite();
    const result = await op;
    let afterDrain = { lifecycleAcquiredByNext: false, afterMs: 0 };
    const released = Date.now();
    while (!afterDrain.lifecycleAcquiredByNext && Date.now() - released < 10_000) {
      afterDrain = { lifecycleAcquiredByNext: await tryLock(lifecycleKey), afterMs: Date.now() - released };
      if (!afterDrain.lifecycleAcquiredByNext) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const proof = { whileInFlight, stillInFlight, afterDrain, callerSettledBeforeWriteReturned: settledEarly, inFlightLanded: existsSync(join(dir, "in-flight.txt")),
      afterLossWritten: existsSync(join(dir, "after-loss.txt")), refused: (refused as { code?: string } | null)?.code ?? null,
      callerFailed: "error" in result };
    console.log("KEEPALIVE6_DRAIN", JSON.stringify(proof));
    await writeFile(join(process.env.TASK_OUT ?? tmpdir(), "keepalive6-drain-result.json"), JSON.stringify(proof, null, 2));
    await rm(dir, { recursive: true, force: true });
    expect(proof.whileInFlight).toEqual({ lifecycleAcquiredByNext: false, inFlightLanded: false });
    expect(proof.stillInFlight.lifecycleAcquiredByNext).toBe(false);
    expect(proof.afterDrain.lifecycleAcquiredByNext).toBe(true);
    expect(proof.afterLossWritten).toBe(false);
    expect(proof.refused).toBe("HOST_MUTATION_REFUSED");
    expect(proof.callerFailed).toBe(true);
  }, 60_000);
});
