import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

type HoldLease = { id: string; companyId: string; providerLeaseId?: string | null };

/**
 * True while a stopped agent-file save on this lease (or the same provider
 * resource) is unverified. The held tree is the only copy of those changes, so
 * no destroy, expiry or teardown may run until the save verifies or a loss is
 * proven. This hold is durable: it is the copy row itself, not process memory.
 */
export async function agentFileSaveHeldOnLease(db: Pick<Db, "execute">, lease: HoldLease): Promise<boolean> {
  if (typeof (db as Db).execute !== "function") return false;
  const rows = await (db as Db).execute(sql`select 1 from agent_instruction_working_copies held_copy
    join environment_leases held_lease on held_lease.company_id = held_copy.company_id
      and held_lease.id::text = held_copy.receipt->'cleanup'->>'leaseId'
    where held_copy.company_id = ${lease.companyId}
      and held_copy.receipt->>'schema' = 'paperclip.agent-files.v1'
      and held_copy.receipt ? 'savePending'
      and held_copy.state not in ('saved', 'unchanged', 'resolved')
      and (held_lease.id = ${lease.id}
        or (${lease.providerLeaseId ?? null}::text is not null and held_lease.provider_lease_id = ${lease.providerLeaseId ?? null}::text))
    limit 1`);
  return Array.isArray(rows) && rows.length > 0;
}
