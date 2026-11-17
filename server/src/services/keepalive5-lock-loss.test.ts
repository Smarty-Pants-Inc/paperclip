import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
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
describePostgres("keepalive5: a lock-session loss stops the guarded host writes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let host: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("keepalive5-");
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
    return { result, late, next, workError };
  }

  function expectStopped(outcome: Awaited<ReturnType<typeof lockLoss>>, errorName: string) {
    expect(outcome.next).toBe(true);
    expect(outcome.late).toBe(false);
    // The work stopped with the typed lost-lock error, and its caller saw a failure (never a success).
    expect((outcome.workError as Error | null)?.name).toBe(errorName);
    expect("error" in outcome.result ? "failed" : `resolved ${JSON.stringify(outcome.result)}`).toBe("failed");
  }

  it("(caller 5) workspace-source-lock: action(transaction) stops; the caller sees WorkspaceSourceLockLostError", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    const outcome = await lockLoss(`isolated_repository_source:${companyId}:${issueId}`,
      work => withWorkspaceSourceLocks(db, { companyId, issueIds: [issueId] },
        (_transaction, signal?: AbortSignal) => work(signal)));
    expectStopped(outcome, "WorkspaceSourceLockLostError");
  }, 60_000);

  it("(caller 2) execution-workspace-lifecycle-lock: work(tx) stops; the caller sees ExecutionWorkspaceLifecycleLockLostError", async () => {
    const workspaceId = randomUUID();
    const outcome = await lockLoss(`execution_workspace_lifecycle:${workspaceId}`,
      work => withExecutionWorkspaceLifecycleLock(db as never, workspaceId, (_tx, signal?: AbortSignal) => work(signal)));
    expectStopped(outcome, "ExecutionWorkspaceLifecycleLockLostError");
  }, 60_000);

  it("(caller 4) skill-version-cache: the cache action stops; the caller sees SkillVersionCacheLockLostError", async () => {
    const companyId = randomUUID();
    const outcome = await lockLoss(`skill_version_cache:${companyId}`,
      work => withSkillVersionCacheLock(db as never, companyId, (signal?: AbortSignal) => work(signal)));
    expectStopped(outcome, "SkillVersionCacheLockLostError");
  }, 60_000);

  it("(caller 3) isolated-repository-rehome: the move work stops; the caller sees WorkspaceMoveLockLostError", async () => {
    const workspace = { id: randomUUID(), companyId: randomUUID(), sourceIssueId: randomUUID(), projectId: null,
      cwd: null, providerRef: null } as never as Parameters<typeof withWorkspaceMoveLocks>[1];
    // Only the move's own lifecycle lock session is killed (the outer source lock session lives on).
    const outcome = await lockLoss(`execution_workspace_lifecycle:${workspace.id}`,
      work => withWorkspaceMoveLocks(db as never, workspace, (_tx, signal?: AbortSignal) => work(signal)));
    expectStopped(outcome, "WorkspaceMoveLockLostError");
  }, 60_000);
});
