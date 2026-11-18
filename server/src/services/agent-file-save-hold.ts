import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { directorySnapshotSha256 } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { HttpError, conflict, notFound } from "../errors.js";
import { inspectAgentDirectory } from "./agent-file-store.js";
import { notifyInstructionCollection } from "./instruction-collection-notifications.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { notifyEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { instructionCopyRetryAt } from "./instruction-copy-retry.js";

export const AGENT_FILES_SAVE_PENDING_INSTRUCTION = "Agent-file changes are not saved. The original source is retained; retry collection before discarding or releasing this sandbox.";
export const AGENT_FILES_RETIREMENT_COLLECTION_TIMEOUT = "AGENT_FILES_RETIREMENT_COLLECTION_TIMEOUT";

type HoldLease = { id: string; companyId: string; providerLeaseId?: string | null };

/**
 * A held save whose store.apply refusal can never succeed against its pinned
 * bytes. store.apply (agent-file-store.ts) refuses those bytes with 422
 * (unprocessable): a reserved name (:82), links or special files (:139, :190),
 * a deleted configured instruction entry (:380, :427, :430). Everything else
 * stays transient and keeps the timed retry: storage limits
 * (AgentFileLimitError), 409 conflicts, 429, 5xx and network errors.
 */
export const AGENT_FILE_PERMANENT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([422]);
export function permanentAgentFileRefusalStatus(error: unknown): number | null {
  return error instanceof HttpError && AGENT_FILE_PERMANENT_REFUSAL_STATUSES.has(error.status) ? error.status : null;
}
/** The sandbox plugin's LEASE-GONE refusal (source unavailable, not a refusal of the bytes). */
export function agentFileSourceLeaseGone(error: unknown): boolean {
  return error instanceof Error && /sandbox lease is no longer active/i.test(error.message);
}
/** savePending.retryOn for a LEASE-GONE hold: retried by the resume event, never by the timer. */
export const AGENT_FILE_HOLD_RETRY_ON_LEASE_ACTIVE = "lease_active";
/** A permanent hold stops blocking its box's destroy this long after it became
 * permanent, and only once every held file is proven byte-equal in the mirror. */
export const AGENT_FILE_PERMANENT_HOLD_DESTROY_BOUND_MS = 24 * 60 * 60_000;
/** A hold no timer retries: permanent, or waiting for its lease to be active again. */
export function agentFileHoldParked(savePending: unknown): boolean {
  const pending = savePending as { permanent?: unknown; retryOn?: unknown } | null | undefined;
  return pending?.permanent === true || pending?.retryOn === AGENT_FILE_HOLD_RETRY_ON_LEASE_ACTIVE;
}
export type AgentFileHeldFile = { path: string; sha256: string };
export type AgentFileDurableCheck = { durable: boolean; checkedAt: string; files: number; changed: string[]; missing: string[]; detail?: string;
  mirrorHash?: string | null; observedHash?: string | null; empty?: boolean };
/**
 * B2 (rf-3 items 2-3): the held bytes are durable only as the DURABLE copy the
 * hold pinned, i.e. the controller mirror whose whole-tree snapshot hash is
 * savePending.mirrorHash (the same proof collectStopped retries from). Every
 * held file is also re-read (path + sha256) to name what changed or is missing.
 * A hold with no pinned mirror proves nothing (a warm hold now pins one when it
 * is held). An EMPTY hold (the candidate tree holds no file: nothing is left to
 * keep, e.g. the sole configured entry was deleted) needs no copy.
 */
export async function verifyHeldMirrorDurable(root: string, pending: { mirrorHash?: unknown; heldFiles?: unknown }): Promise<AgentFileDurableCheck> {
  const checkedAt = new Date().toISOString();
  const mirrorHash = typeof pending.mirrorHash === "string" ? pending.mirrorHash : null;
  const heldFiles = Array.isArray(pending.heldFiles) ? pending.heldFiles as AgentFileHeldFile[] : null;
  if (heldFiles && heldFiles.length === 0) return { durable: true, checkedAt, files: 0, changed: [], missing: [], empty: true, mirrorHash,
    detail: "Empty hold: the held candidate contains no file, so nothing is left to keep" };
  if (!mirrorHash || !heldFiles) return { durable: false, checkedAt, files: heldFiles?.length ?? 0, changed: [], missing: [], mirrorHash,
    detail: "The hold has no pinned durable mirror (mirrorHash + held-file manifest)" };
  const changed: string[] = [], missing: string[] = [];
  for (const file of heldFiles) {
    const bytes = await fs.readFile(path.join(root, file.path)).catch(() => null);
    if (bytes === null) missing.push(file.path);
    else if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) changed.push(file.path);
  }
  let observedHash: string | null = null;
  try { observedHash = directorySnapshotSha256((await inspectAgentDirectory(root)).snapshot); } catch { observedHash = null; }
  const durable = observedHash === mirrorHash && changed.length === 0 && missing.length === 0;
  return { durable, checkedAt, files: heldFiles.length, changed, missing, mirrorHash, observedHash,
    ...(durable || changed.length || missing.length ? {} : { detail: "The mirror tree no longer matches the pinned mirrorHash" }) };
}
/** B3 outbox: a permanent hold's owner notice is pending until delivered. */
export function agentFileHoldNoticePending(savePending: unknown): boolean {
  const pending = savePending as { permanent?: unknown; noticeDelivered?: unknown } | null | undefined;
  return pending?.permanent === true && pending.noticeDelivered === false;
}
type HeldCopyRow = { company_id: string; run_id: string; local_root: string; receipt: Record<string, unknown> | null };
/**
 * B2: a permanent hold past AGENT_FILE_PERMANENT_HOLD_DESTROY_BOUND_MS no
 * longer blocks its box's destroy, but only while every held file is byte-equal
 * in the controller mirror the hold points at (savePending.heldFiles, path +
 * sha256). The check is written to the hold (savePending.durableCheck).
 */
async function permanentHoldReleasedForDestroy(db: Pick<Db, "execute">, row: HeldCopyRow): Promise<boolean> {
  const pending = row.receipt?.savePending as { permanent?: unknown; permanentAt?: unknown; since?: unknown; heldFiles?: unknown; mirrorHash?: unknown } | undefined;
  if (pending?.permanent !== true) return false;
  const permanentAt = Date.parse(String(pending.permanentAt ?? pending.since ?? ""));
  if (!Number.isFinite(permanentAt) || Date.now() - permanentAt < AGENT_FILE_PERMANENT_HOLD_DESTROY_BOUND_MS) return false;
  const check = await verifyHeldMirrorDurable(row.local_root, pending);
  await (db as Db).execute(sql`update agent_instruction_working_copies
    set receipt = jsonb_set(receipt, '{savePending,durableCheck}', ${JSON.stringify(check)}::jsonb)
    where company_id = ${row.company_id} and run_id::text = ${row.run_id}::text and receipt ? 'savePending'`);
  return check.durable;
}

/**
 * B0b: the box's lease is active again (a resume). Every LEASE-GONE hold bound
 * to it (or its run) is re-armed for collection now; nothing else polls them.
 */
export async function rearmAgentFileHoldsOnLeaseActive(db: Db, lease: HoldLease & { heartbeatRunId?: string | null }): Promise<string[]> {
  return db.transaction(async tx => {
    const rows = await (tx as unknown as Db).execute(sql`update agent_instruction_working_copies held_copy
      set receipt = held_copy.receipt #- '{savePending,retryOn}', next_attempt_at = now(), updated_at = now()
      where held_copy.company_id = ${lease.companyId}
        and held_copy.receipt->>'schema' = 'paperclip.agent-files.v1'
        and held_copy.receipt->'savePending'->>'retryOn' = ${AGENT_FILE_HOLD_RETRY_ON_LEASE_ACTIVE}
        and (held_copy.run_id::text = ${lease.heartbeatRunId ?? null}::text
          or held_copy.receipt->'cleanup'->>'leaseId' = ${lease.id}::text
          or (${lease.providerLeaseId ?? null}::text is not null and exists (select 1 from environment_leases bound
            where bound.company_id = held_copy.company_id and bound.id::text = held_copy.receipt->'cleanup'->>'leaseId'
              and bound.provider_lease_id = ${lease.providerLeaseId ?? null}::text)))
      returning held_copy.run_id::text as run_id`) as Array<{ run_id: string }>;
    for (const row of rows) await notifyInstructionCollection(tx, { companyId: lease.companyId, runId: row.run_id });
    return rows.map(row => row.run_id);
  });
}

/**
 * True while a stopped agent-file save on this lease (or the same provider
 * resource) is unverified. The held tree is the only copy of those changes, so
 * no destroy, expiry or teardown may run until the save verifies or a loss is
 * proven. This hold is durable: it is the copy row itself, not process memory.
 */
export async function agentFileSaveHeldOnLease(db: Pick<Db, "execute">, lease: HoldLease): Promise<boolean> {
  if (typeof (db as Db).execute !== "function") return false;
  const rows = await (db as Db).execute(sql`select held_copy.company_id::text as company_id, held_copy.run_id::text as run_id,
      held_copy.local_root, held_copy.receipt from agent_instruction_working_copies held_copy
    join environment_leases held_lease on held_lease.company_id = held_copy.company_id
      and held_lease.id::text = held_copy.receipt->'cleanup'->>'leaseId'
    where held_copy.company_id = ${lease.companyId}
      and held_copy.receipt->>'schema' = 'paperclip.agent-files.v1'
      and held_copy.receipt ? 'savePending'
      and held_copy.state not in ('saved', 'unchanged', 'resolved')
      and (held_lease.id = ${lease.id}
        or (${lease.providerLeaseId ?? null}::text is not null and held_lease.provider_lease_id = ${lease.providerLeaseId ?? null}::text))`);
  if (!Array.isArray(rows)) return false;
  for (const row of rows as unknown as HeldCopyRow[]) if (!await permanentHoldReleasedForDestroy(db, row)) return true;
  return false;
}

export const AGENT_FILE_DESTROY_CLAIM_KEY = "agentFileDestroyClaim";
/** Lease metadata map: collecting copy key -> pin token, set while a stopped collection is in flight. */
export const AGENT_FILE_COLLECTION_PINS_KEY = "agentFileCollectionPins";
/** The lease's pending-cleanup attempt the claim was taken under (JSON null when none). */
export const AGENT_FILE_DESTROY_CLAIM_ATTEMPT_KEY = "agentFileDestroyClaimAttempt";
export const AGENT_FILE_DESTROY_REFUSED_MESSAGE = "Agent-file changes are not saved. The original source is retained; retry collection before discarding or releasing this sandbox.";

/**
 * A destroy claim is live unless the lease's fenced cleanup ownership moved
 * on: a newer pending-cleanup attempt (the sweep proved the old owner dead or
 * its in-flight deadline passed) supersedes a claim taken under another
 * attempt, so a crashed destroy cannot block the retry forever. Any other
 * destroy is refused while the claim is live.
 */
export const liveDestroyClaimSql = (metadata: SQL) => sql`(coalesce(${metadata}, '{}'::jsonb) ? ${AGENT_FILE_DESTROY_CLAIM_KEY}::text
  and not coalesce(jsonb_typeof(${metadata}->'pendingCleanupAttemptId') = 'string'
    and ${metadata}->'pendingCleanupAttemptId' is distinct from ${metadata}->${AGENT_FILE_DESTROY_CLAIM_ATTEMPT_KEY}::text, false))`;

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
        ${liveDestroyClaimSql(sql`alloc.metadata`)} as claimed,
        coalesce(alloc.metadata->${AGENT_FILE_COLLECTION_PINS_KEY}::text, '{}'::jsonb) <> '{}'::jsonb as pinned
      from (${allocationRows(sql`${lease.id}`)}) alloc`) as Array<{ id: string; claimed?: unknown; pinned?: unknown }>;
    if (!Array.isArray(locked) || !locked.some(row => row.id === lease.id)) return null;
    if (locked.some(row => row.claimed === true || row.pinned === true)) return null;
    if (await agentFileSaveHeldOnLease(tx as unknown as Db, lease)) return null;
    const token = randomUUID();
    await (tx as unknown as Db).execute(sql`update environment_leases set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(${AGENT_FILE_DESTROY_CLAIM_KEY}::text, ${token}::text,
        ${AGENT_FILE_DESTROY_CLAIM_ATTEMPT_KEY}::text, coalesce(metadata->'pendingCleanupAttemptId', 'null'::jsonb)) where id = ${lease.id}`);
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
  await (db as Db).execute(sql`update environment_leases set metadata = metadata - ${AGENT_FILE_DESTROY_CLAIM_KEY}::text - ${AGENT_FILE_DESTROY_CLAIM_ATTEMPT_KEY}::text
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
        and not exists (select 1 from alloc where ${liveDestroyClaimSql(sql`alloc.metadata`)})
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

/** Instance-operator recovery after independently confirming the collector is
 * stopped. Match one token under the lease lock; never clear another pin or a
 * replacement collector. This grants no save/discard authority over a copy. */
export async function clearLeaseCollectionPin(db: Db, input: {
  companyId: string; leaseId: string; copyKey: string; token: string; actorId: string; reason: string;
}): Promise<void> {
  const { publication } = await db.transaction(async tx => {
    const rows = await tx.execute(sql`select metadata from environment_leases
      where id = ${input.leaseId} and company_id = ${input.companyId} for update`);
    if (!rows.length) throw notFound("Environment lease not found");
    const metadata = rows[0]!.metadata as Record<string, unknown> | null;
    const pins = metadata?.[AGENT_FILE_COLLECTION_PINS_KEY] as Record<string, unknown> | undefined;
    if (!pins || pins[input.copyKey] !== input.token) throw conflict("The collection pin changed or no longer exists");
    await unpinLeaseForCollection(tx as unknown as Db, input.leaseId, input.copyKey, input.token);
    await notifyEnvironmentCleanup(tx, { companyId: input.companyId, leaseId: input.leaseId });
    return persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "agent_files.collection_pin_cleared", entityType: "environment_lease", entityId: input.leaseId,
      details: { copyKey: input.copyKey, reason: input.reason, collectorStopped: true, clearedAt: new Date().toISOString() } });
  });
  publishActivity(publication);
}

/**
 * Condition for the copy-row UPDATE that writes a save hold: takes the row
 * locks of every lease row of the bound provider allocation (id order; waits
 * for an in-flight destroy claim to commit) and refuses the write when a
 * destroy is claimed on any of them. No bound lease: no condition.
 */
export const agentFileHoldWriteCondition = sql`(select bool_or(${liveDestroyClaimSql(sql`held_lock.metadata`)})
    from (${allocationRows(sql`agent_instruction_working_copies.receipt->'cleanup'->>'leaseId'`)}) held_lock) is not true`;

/** A copy needs no retirement collection: verified save/unchanged, handed off,
 * or settled without a held save after recorded stop (proven loss/prepare failure). */
export function agentFileCopyRetirementSettled(row: { state: string; receipt?: Record<string, unknown> | null; processStoppedAt?: Date | null }): boolean {
  if (["saved", "unchanged", "resolved"].includes(row.state)) return true;
  if (row.receipt?.savePending != null) return false;
  return row.state === "superseded" || Boolean(row.receipt?.retainedByRunId)
    || row.state === "unavailable" && row.processStoppedAt != null;
}

/**
 * Agent-file copies whose only unsaved bytes may be on this box: the lease's
 * own run's copy, or any copy bound to this lease, without a settled receipt
 * (agentFileCopyRetirementSettled). A retirement (CR6) collects these through
 * the Stop collector before it stops or destroys the box.
 */
export async function agentFileCopiesToCollectOnLease(db: Pick<Db, "execute">, lease: HoldLease & { heartbeatRunId?: string | null }): Promise<string[]> {
  if (typeof (db as Db).execute !== "function") return [];
  const rows = await (db as Db).execute(sql`select company_id::text as company_id, run_id::text as run_id, local_root, receipt from agent_instruction_working_copies
    where company_id = ${lease.companyId}
      and receipt->>'schema' = 'paperclip.agent-files.v1'
      and (run_id::text = ${lease.heartbeatRunId ?? null}::text or receipt->'cleanup'->>'leaseId' = ${lease.id}::text)
      and not (state in ('saved', 'unchanged', 'resolved')
        or (not (receipt ? 'savePending') and (state = 'superseded' or coalesce(receipt->>'retainedByRunId', '') <> ''
          or (state = 'unavailable' and process_stopped_at is not null))))`);
  if (!Array.isArray(rows)) return [];
  const collect: string[] = [];
  // A permanent hold released for destroy (B2) needs no collection: its bytes are verified in the mirror.
  for (const row of rows as unknown as HeldCopyRow[]) if (!await permanentHoldReleasedForDestroy(db, row)) collect.push(String(row.run_id));
  return collect;
}

/**
 * rf-4 A2: the retirement collection ran out of its aggregate deadline, so the
 * box is stopped and kept WITHOUT collection. Its unsaved agent files are on
 * the kept disk: write the same durable hold a failed stopped save writes
 * (receipt.savePending), so no destroy or expiry claims that disk until a
 * verified save or an explicit discard. An existing hold stays as it is; a
 * copy the still-running collector already settled is not touched. SQL only
 * (no provider call in this transaction), with bounded lock/statement waits.
 */
export async function holdUncollectedAgentFileCopy(db: Db, input: { companyId: string; runId: string; reason: string }): Promise<boolean> {
  const since = new Date();
  const savePending = { since: since.toISOString(), code: AGENT_FILES_RETIREMENT_COLLECTION_TIMEOUT, reason: input.reason.slice(0, 500), failures: 1 };
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`set local statement_timeout = '10s'`);
    const rows = await tx.execute(sql`update agent_instruction_working_copies
      set state = 'unavailable', process_stopped_at = coalesce(process_stopped_at, now()),
        error_code = ${AGENT_FILES_RETIREMENT_COLLECTION_TIMEOUT}, error_message = ${AGENT_FILES_SAVE_PENDING_INSTRUCTION},
        next_attempt_at = ${instructionCopyRetryAt(since).toISOString()}::timestamptz,
        receipt = coalesce(receipt, '{}'::jsonb) || jsonb_build_object('savePending', ${JSON.stringify(savePending)}::jsonb),
        updated_at = now()
      where company_id = ${input.companyId} and run_id::text = ${input.runId}::text
        and receipt->>'schema' = 'paperclip.agent-files.v1'
        and not (receipt ? 'savePending')
        and state not in ('saved', 'unchanged', 'resolved', 'superseded')
        and coalesce(receipt->>'retainedByRunId', '') = ''
        and ${agentFileHoldWriteCondition}
      returning run_id`);
    return Array.isArray(rows) && rows.length > 0;
  });
}
