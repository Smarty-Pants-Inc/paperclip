import { randomUUID } from "node:crypto";
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
/** Lease metadata map: collecting copy key -> pin token, set while a stopped collection is in flight. */
export const AGENT_FILE_COLLECTION_PINS_KEY = "agentFileCollectionPins";

/**
 * Shared exclusion between the save-hold write, the collection pin and every
 * destroy path. Locks the lease row FOR UPDATE, refuses while a collection pin
 * is present (a collection is in flight or its outcome is unknown), re-checks
 * the hold in a fresh statement (so a hold committed by a writer that held the
 * lock is visible), and only then records a durable destroy claim whose value
 * is a random token. A hold write and a collection pin take the same row lock
 * and are refused once a claim exists, so the hold check, the collection and
 * the destroy authority can never interleave.
 * Returns the claim token, or null when pinned/held (or the lease vanished):
 * never destroy then. Release only with releaseLeaseDestroyClaim(token).
 */
export async function claimLeaseForDestroyUnlessHeld(db: Db, lease: HoldLease): Promise<string | null> {
  if (typeof (db as Db).transaction !== "function") return (await agentFileSaveHeldOnLease(db, lease)) ? null : randomUUID();
  return await db.transaction(async tx => {
    const locked = await (tx as unknown as Db).execute(sql`select coalesce(metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text, '{}'::jsonb) <> '{}'::jsonb as pinned
      from environment_leases where id = ${lease.id} for update`);
    if (!Array.isArray(locked) || locked.length === 0) return null;
    if ((locked[0] as { pinned?: unknown }).pinned === true) return null;
    if (await agentFileSaveHeldOnLease(tx as unknown as Db, lease)) return null;
    const token = randomUUID();
    await (tx as unknown as Db).execute(sql`update environment_leases set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(${AGENT_FILE_DESTROY_CLAIM_KEY}::text, ${token}::text) where id = ${lease.id}`);
    return token;
  });
}

/**
 * Clears the destroy claim once the destroy attempt settled (either way), only
 * when the stored claim is still the one this destroy took (one conditional
 * statement): an old cleanup never clears a newer destroy's claim.
 */
export async function releaseLeaseDestroyClaim(db: Db, leaseId: string, token: string): Promise<void> {
  if (typeof (db as Db).execute !== "function") return;
  await (db as Db).execute(sql`update environment_leases set metadata = metadata - ${AGENT_FILE_DESTROY_CLAIM_KEY}::text
    where id = ${leaseId} and metadata->>${AGENT_FILE_DESTROY_CLAIM_KEY}::text = ${token}::text`);
}

/**
 * Pins the lease for a stopped collection, under the lease row lock, unless a
 * destroy is already claimed (one conditional UPDATE: a concurrent claim
 * commits first and the WHERE is re-checked against it).
 * Returns the pin token; "unbound" when the lease row does not exist (nothing
 * can claim it); null when a destroy holds the claim (collection refused).
 * The pin is keyed by the collecting copy, so a retry after a collection whose
 * outcome is unknown (thrown or crashed) replaces its own stale pin.
 */
export async function pinLeaseForCollection(db: Db, leaseId: string, copyKey: string): Promise<string | "unbound" | null> {
  if (typeof (db as Db).execute !== "function") return "unbound";
  const token = randomUUID();
  const [result] = await (db as Db).execute(sql`with pinned as (
      update environment_leases set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), array[${AGENT_FILE_COLLECTION_PINS_KEY}::text],
        coalesce(metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text, '{}'::jsonb) || jsonb_build_object(${copyKey}::text, ${token}::text))
      where id = ${leaseId} and not (coalesce(metadata, '{}'::jsonb) ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text)
      returning id)
    select (select count(*) from pinned)::int as pinned, (select count(*) from environment_leases where id = ${leaseId})::int as present`) as Array<{ pinned: number; present: number }>;
  if (result?.pinned === 1) return token;
  return result?.present === 0 ? "unbound" : null;
}

/** Drops this collection's pin (only its own token) once the collection settled. */
export async function unpinLeaseForCollection(db: Db, leaseId: string, copyKey: string, token: string): Promise<void> {
  if (typeof (db as Db).execute !== "function") return;
  await (db as Db).execute(sql`update environment_leases set metadata = case
      when (metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text) - ${copyKey}::text = '{}'::jsonb then metadata - ${AGENT_FILE_COLLECTION_PINS_KEY}::text
      else jsonb_set(metadata, array[${AGENT_FILE_COLLECTION_PINS_KEY}::text], (metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text) - ${copyKey}::text) end
    where id = ${leaseId} and metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text->>${copyKey}::text = ${token}::text`);
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
