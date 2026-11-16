import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * The company connector-runtime lock (migration 0489). Company-wide runtime
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
