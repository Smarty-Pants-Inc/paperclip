import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Db } from "@paperclipai/db";

/**
 * #20805 R3 (RFL 06:42Z 11-16 + joint addendum 06:43Z): an in-flight per-agent
 * runtime writer as production now holds it: the agent row, then the SHARED
 * company connector-runtime hold (migration 0489, rows-then-lock; the same key as
 * server/src/services/agent-runtime-lock.ts). A company-wide fanout takes that
 * lock EXCLUSIVE, so it waits for this writer to commit.
 */
export async function holdAgentRowThenCompanyRuntimeShared(tx: Pick<Db, "execute">, companyId: string, agentId: string) {
  await tx.execute(sql`SELECT id FROM agents WHERE id = ${agentId} FOR NO KEY UPDATE`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('paperclip.connector_runtime:' || ${companyId}::uuid::text, 0))`);
}

/** The backend `pid` is blocked on the company runtime lock (an advisory lock). */
export async function expectWaitsOnCompanyRuntimeHold(db: Pick<Db, "execute">, pid: number) {
  const [activity] = await db.execute(sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`);
  expect(activity!.wait_event_type).toBe("Lock");
  const waiting = await db.execute(sql`SELECT locktype FROM pg_locks WHERE pid = ${pid} AND NOT granted`);
  expect(waiting.map(row => row.locktype)).toEqual(["advisory"]);
}
