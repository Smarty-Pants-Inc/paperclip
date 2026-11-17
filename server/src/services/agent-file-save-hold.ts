import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
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
export const AGENT_FILE_DESTROY_REFUSED_MESSAGE = "Agent-file changes are not saved. The original source is retained; retry collection before discarding or releasing this sandbox.";

/**
 * Every lease row of one provider ALLOCATION (the same company and provider
 * lease id as the given lease row, or the row alone without a provider lease
 * id), locked FOR UPDATE in id order so concurrent lockers never deadlock.
 * Pins and claims are checked across this whole set: a pin on one alias row
 * protects the allocation from a destroy through any other alias row.
 */
const allocationRows = (leaseId: SQL) => sql`select alloc_lease.id, alloc_lease.metadata
    from environment_leases alloc_lease
    join environment_leases alloc_target on alloc_target.id::text = ${leaseId}
    where alloc_lease.company_id = alloc_target.company_id
      and (alloc_lease.id = alloc_target.id
        or (alloc_target.provider_lease_id is not null and alloc_lease.provider_lease_id = alloc_target.provider_lease_id))
    order by alloc_lease.id
    for update of alloc_lease`;

/**
 * Shared exclusion between the save-hold write, the collection pin and every
 * destroy path. Locks every lease row of the provider allocation FOR UPDATE
 * (stable id order), refuses while any of them carries a collection pin (a
 * collection is in flight or its outcome is unknown) or a live destroy claim
 * (one live claim per allocation: a second destroy never replaces or later
 * releases the first one's claim), re-checks the hold in a fresh statement
 * (so a hold committed by a writer that held the lock is visible), and only
 * then records a durable destroy claim whose value is a random token.
 * A hold write and a collection pin take the same row locks and are refused
 * once a claim exists, so the hold check, the collection and the destroy
 * authority can never interleave.
 * Returns the claim token, or null when claimed/pinned/held (or the lease
 * vanished): never destroy then. Release only with the token.
 */
export async function claimLeaseForDestroyUnlessHeld(db: Db, lease: HoldLease): Promise<string | null> {
  if (typeof (db as Db).transaction !== "function") return (await agentFileSaveHeldOnLease(db, lease)) ? null : randomUUID();
  return await db.transaction(async tx => {
    const locked = await (tx as unknown as Db).execute(sql`select alloc.id,
        coalesce(alloc.metadata, '{}'::jsonb) ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text as claimed,
        coalesce(alloc.metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text, '{}'::jsonb) <> '{}'::jsonb as pinned
      from (${allocationRows(sql`${lease.id}`)}) alloc`) as Array<{ id: string; claimed?: unknown; pinned?: unknown }>;
    if (!Array.isArray(locked) || !locked.some(row => row.id === lease.id)) return null;
    if (locked.some(row => row.claimed === true || row.pinned === true)) return null;
    if (await agentFileSaveHeldOnLease(tx as unknown as Db, lease)) return null;
    const token = randomUUID();
    await (tx as unknown as Db).execute(sql`update environment_leases set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(${AGENT_FILE_DESTROY_CLAIM_KEY}::text, ${token}::text) where id = ${lease.id}`);
    return token;
  });
}

/**
 * Clears the destroy claim once the destroy attempt settled without its own
 * settlement clearing it (releaseLease with destroyClaim does that
 * atomically). One conditional statement: only the claim's own token clears
 * it, and only while no other writer settled a different provider receipt on
 * the lease since this destroy read it (`readReceipt`): a lease another
 * writer settled stays exactly as that settlement wrote it.
 */
export async function releaseLeaseDestroyClaim(db: Db, leaseId: string, token: string, readReceipt?: unknown): Promise<void> {
  if (typeof (db as Db).execute !== "function") return;
  await (db as Db).execute(sql`update environment_leases set metadata = metadata - ${AGENT_FILE_DESTROY_CLAIM_KEY}::text
    where id = ${leaseId} and metadata->>${AGENT_FILE_DESTROY_CLAIM_KEY}::text = ${token}::text
      and metadata->'remoteExecutionTermination' is not distinct from ${readReceipt === undefined || readReceipt === null ? null : JSON.stringify(readReceipt)}::jsonb`);
}

/**
 * Runs one provider destroy under the allocation's destroy claim; refuses
 * (throws, before any provider IO) while a save hold, a collection pin or
 * another destroy's claim protects the allocation.
 */
export async function withLeaseDestroyClaim<T>(db: Db, lease: HoldLease & { metadata?: Record<string, unknown> | null },
  run: (claim: string) => Promise<T>): Promise<T> {
  const claim = await claimLeaseForDestroyUnlessHeld(db, lease);
  if (!claim) throw new Error(AGENT_FILE_DESTROY_REFUSED_MESSAGE);
  try {
    return await run(claim);
  } finally {
    await releaseLeaseDestroyClaim(db, lease.id, claim, lease.metadata?.remoteExecutionTermination).catch(() => undefined);
  }
}

/**
 * Pins the lease for a stopped collection unless a destroy is claimed on any
 * lease row of the same provider allocation (one statement that locks the
 * allocation rows in id order first: a concurrent claim commits first and is
 * seen).
 * Returns the pin token; "unbound" when the lease row does not exist (nothing
 * can claim it); null when a destroy holds the claim (collection refused).
 * The pin is keyed by the collecting copy, so a retry after a collection whose
 * outcome is unknown (thrown or crashed) replaces its own stale pin.
 */
export async function pinLeaseForCollection(db: Db, leaseId: string, copyKey: string): Promise<string | "unbound" | null> {
  if (typeof (db as Db).execute !== "function") return "unbound";
  const token = randomUUID();
  const [result] = await (db as Db).execute(sql`with alloc as materialized (${allocationRows(sql`${leaseId}`)}),
    pinned as (
      update environment_leases set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), array[${AGENT_FILE_COLLECTION_PINS_KEY}::text],
        coalesce(metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text, '{}'::jsonb) || jsonb_build_object(${copyKey}::text, ${token}::text))
      where id = ${leaseId} and (select count(*) from alloc) > 0
        and not exists (select 1 from alloc where coalesce(alloc.metadata, '{}'::jsonb) ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text)
      returning id)
    select (select count(*) from pinned)::int as pinned, (select count(*) from alloc where alloc.id::text = ${leaseId})::int as present`) as Array<{ pinned: number; present: number }>;
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
 * Condition for the copy-row UPDATE that writes a save hold: takes the row
 * locks of every lease row of the bound provider allocation (id order; waits
 * for an in-flight destroy claim to commit) and refuses the write when a
 * destroy is claimed on any of them. No bound lease: no condition.
 */
export const agentFileHoldWriteCondition = sql`(select bool_or(coalesce(held_lock.metadata, '{}'::jsonb) ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text)
    from (${allocationRows(sql`agent_instruction_working_copies.receipt->'cleanup'->>'leaseId'`)}) held_lock) is not true`;
