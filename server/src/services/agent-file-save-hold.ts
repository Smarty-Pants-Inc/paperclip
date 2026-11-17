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

export const AGENT_FILE_DESTROY_CLAIM_KEY = "agentFileDestroyClaim";

/**
 * Shared exclusion between the save-hold write and every destroy path.
 * Locks the lease row FOR UPDATE, re-checks the hold in a fresh statement
 * (so a hold committed by a writer that held the lock is visible), and only
 * then records a durable destroy claim. A hold write takes the same row lock
 * (agentFileHoldWriteCondition) and is refused once the claim exists, so the
 * hold check and the destroy authority can never interleave.
 * Returns false when held (or the lease vanished): never destroy then.
 */
export async function claimLeaseForDestroyUnlessHeld(db: Db, lease: HoldLease): Promise<boolean> {
  if (typeof (db as Db).transaction !== "function") return !(await agentFileSaveHeldOnLease(db, lease));
  return await db.transaction(async tx => {
    const locked = await (tx as unknown as Db).execute(sql`select id from environment_leases where id = ${lease.id} for update`);
    if (!Array.isArray(locked) || locked.length === 0) return false;
    if (await agentFileSaveHeldOnLease(tx as unknown as Db, lease)) return false;
    await (tx as unknown as Db).execute(sql`update environment_leases set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(${AGENT_FILE_DESTROY_CLAIM_KEY}::text, ${new Date().toISOString()}::text) where id = ${lease.id}`);
    return true;
  });
}

/** Clears the destroy claim once the destroy attempt settled (either way). */
export async function releaseLeaseDestroyClaim(db: Db, leaseId: string): Promise<void> {
  if (typeof (db as Db).execute !== "function") return;
  await (db as Db).execute(sql`update environment_leases set metadata = metadata - ${AGENT_FILE_DESTROY_CLAIM_KEY}::text
    where id = ${leaseId} and metadata ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text`);
}

/**
 * Condition for the copy-row UPDATE that writes a save hold: takes the bound
 * lease row lock (waits for an in-flight destroy claim to commit) and refuses
 * the write when a destroy is already claimed. No bound lease: no condition.
 */
export const agentFileHoldWriteCondition = sql`(select held_lock.metadata ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text
    from environment_leases held_lock
    where held_lock.id::text = agent_instruction_working_copies.receipt->'cleanup'->>'leaseId'
    for update) is not true`;
