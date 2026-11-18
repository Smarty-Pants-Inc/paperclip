import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * The company connector-runtime lock (migration 0491). Company-wide runtime
 * invalidation (membership, grant and connector writes) holds it exclusively and
 * every per-agent runtime revision holds it shared, both until commit.
 *
 * Lock order: existing agent rows, then this lock. A transaction that will make
 * a company-wide write AND then writes an agent row (hire, hire approval, agent
 * permission change) takes it here, once, after its agent row locks and before
 * its first agent write, so it never upgrades a shared hold or waits for an agent
 * row while holding it. Same statement shape as the other company advisory locks.
 */
export async function lockCompanyAgentRuntime(tx: Pick<Db, "execute">, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('paperclip.connector_runtime:' || ${companyId}::uuid::text, 0))`);
}

/**
 * #20805 R3: the SHARED side of the same lock, for a production path that holds
 * an agent row and needs company-wide runtime changes (connector, grant and
 * membership writes) to wait until it commits. Take it RIGHT AFTER the agent row
 * lock (rows, then this lock; the order of migration 0491). `noWait` mirrors a
 * NOWAIT row lock: it returns false instead of waiting for an exclusive holder.
 */
export async function holdCompanyAgentRuntimeShared(tx: Pick<Db, "execute">, companyId: string, options: { noWait?: boolean } = {}) {
  if (!options.noWait) {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('paperclip.connector_runtime:' || ${companyId}::uuid::text, 0))`);
    return true;
  }
  const [row] = await tx.execute(sql`select pg_try_advisory_xact_lock_shared(hashtextextended('paperclip.connector_runtime:' || ${companyId}::uuid::text, 0)) as held`);
  return (row as { held?: boolean } | undefined)?.held === true;
}
