import { executionWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { workspaceSourceIdentities, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { localWorkspaceSourcePaths } from "./execution-workspace-source-roots.js";
import { currentHostMutationDrain, withHeldLockHostDrain } from "./native-runtime/held-lock-host-drain.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** pl/keepalive5: the lifecycle-lock session died (failed keepalive ping); another owner may hold the lock. */
export class ExecutionWorkspaceLifecycleLockLostError extends Error {
  override name = "ExecutionWorkspaceLifecycleLockLostError";
  constructor(cause?: unknown) { super("execution_workspace_lifecycle_lock_lost", { cause }); }
}

export async function acquireExecutionWorkspaceLifecycleLock(
  tx: Transaction,
  workspaceId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`,
  );
}

export async function withExecutionWorkspaceLifecycleLock<T>(
  db: Db,
  workspaceId: string,
  work: (tx: Transaction, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  // pl/keepalive6: an enclosing held lock's gate (e.g. a caller's source lock), captured before any connection opens.
  const callerGate = currentHostMutationDrain();
  const [source] = await db.select({ companyId: executionWorkspaces.companyId, projectId: executionWorkspaces.projectId,
    providerType: executionWorkspaces.providerType, sourceIssueId: executionWorkspaces.sourceIssueId, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
  const sourceRoots = source ? await Promise.all(localWorkspaceSourcePaths(source)
    .map(cwd => workspaceSourceIdentities(source.companyId, cwd))) : [];
  const projectIds = [...new Set([...sourceRoots.flatMap(root => root.projectIds),
    source && ["local_fs", "git_worktree"].includes(source.providerType) ? source.projectId : null,
  ].filter((id): id is string => Boolean(id)))].sort();
  const issueIds = [...new Set([...sourceRoots.flatMap(root => root.issueIds),
    source && ["local_fs", "git_worktree"].includes(source.providerType) ? source.sourceIssueId : null,
  ].filter((id): id is string => Boolean(id)))].sort();
  // Inside this function's own source scope, the parent is that scope's gate (itself joined to callerGate).
  const workWithLifecycle = (parentGate = callerGate) => withDedicatedDbConnection(db, (connection) =>
    connection.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
      if ((projectIds.length || issueIds.length) && source) {
        const [fresh] = await tx.select({ companyId: executionWorkspaces.companyId, projectId: executionWorkspaces.projectId,
          providerType: executionWorkspaces.providerType, sourceIssueId: executionWorkspaces.sourceIssueId, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
        const freshRoots = fresh ? await Promise.all(localWorkspaceSourcePaths(fresh)
          .map(cwd => workspaceSourceIdentities(fresh.companyId, cwd))) : [];
        if (!fresh || fresh.companyId !== source.companyId || fresh.projectId !== source.projectId
          || fresh.providerType !== source.providerType || fresh.sourceIssueId !== source.sourceIssueId || !isDeepStrictEqual(freshRoots, sourceRoots)) {
          throw new Error("workspace_source_scope_changed");
        }
      }
      const rows = await tx.execute(
        sql`select setting::bigint as idle_timeout_ms from pg_settings where name = 'idle_in_transaction_session_timeout'`,
      );
      // pl/keepalive6: a failed ping closes the lifecycle gate; it is JOINED to the outer source lock's gate,
      // so losing either lock stops work's host writes; in-flight ones drain before the lock is released.
      return withHeldLockHostDrain({ lock: tx, idleTimeoutMs: Number(rows[0]?.idle_timeout_ms), parent: parentGate,
        label: "execution workspace lifecycle lock", lostError: cause => new ExecutionWorkspaceLifecycleLockLostError(cause) },
      (signal) => work(tx, signal));
    }),
  );
  return (projectIds.length || issueIds.length) && source
    ? withWorkspaceSourceLocks(db, { companyId: source.companyId, projectIds, issueIds },
      () => workWithLifecycle(currentHostMutationDrain() ?? callerGate))
    : workWithLifecycle();
}

export async function tryAcquireExecutionWorkspaceLifecycleLock(tx: Transaction, workspaceId: string) {
  const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0)) as acquired`);
  return rows[0]?.acquired === true;
}
