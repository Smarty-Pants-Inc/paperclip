import { type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

/**
 * Serialize queued/running run insertion with agent settlement. The run's FK
 * takes only KEY SHARE, which does not conflict with settlement's NO KEY UPDATE.
 * Use admission's stronger FOR UPDATE lock, in the INSERT's transaction.
 *
 * Lock order: issue row(s), if any, then agent row, then wake/run inserts. Take
 * this before inserting a wake too: upgrading two FK KEY SHARE locks to UPDATE
 * concurrently would deadlock. Resolve network/provider work before entering
 * this database-only critical section. A scheduled_retry is not active admission.
 */
export async function lockAgentForRunAdmission(tx: Pick<Db, "execute">, input: { companyId: string; agentId: string }) {
  await tx.execute(sql`select id from agents where id = ${input.agentId} and company_id = ${input.companyId} for update`);
}
