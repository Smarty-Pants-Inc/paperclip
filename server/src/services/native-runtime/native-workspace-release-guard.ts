import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

/** One custody predicate for physical plugin release and every lease-table
 * release writer. Any prepared reference naming this box holds it, including a
 * partial/old reference and another run's lease on the same allocation. A
 * stopped process or an archive-shaped operation row is not verified copyback.
 * Only the exporter advancing the reference out of prepared clears the hold. */
function unexportedPreparedWorkCondition(box: { companyId: string | SQL; providerLeaseId: string | SQL; leaseId?: string | SQL }) {
  const reference = sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'`;
  return sql`${heartbeatRuns.companyId} = ${box.companyId}
    and ${reference}->>'state' = 'prepared'
    and (${reference}->>'providerLeaseId' = ${box.providerLeaseId}
      or ${box.leaseId ? sql`${reference}->>'leaseId' = ${box.leaseId}` : sql`false`}
      or ${reference}->>'leaseId' in (select box_lease.id::text from environment_leases box_lease
        where box_lease.company_id = ${box.companyId} and box_lease.provider_lease_id = ${box.providerLeaseId}))`;
}

export async function boxHasUnexportedPreparedWork(db: Db, box: { companyId: string; providerLeaseId: string }):
  Promise<{ held: boolean; runIds: string[] }> {
  const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(unexportedPreparedWorkCondition(box));
  return { held: rows.length > 0, runIds: rows.map(row => row.id).sort() };
}

export function nativeWorkspaceReleaseAllowedCondition() {
  return sql`not exists (select 1 from ${heartbeatRuns} where ${unexportedPreparedWorkCondition({
    companyId: sql`${environmentLeases.companyId}`, providerLeaseId: sql`${environmentLeases.providerLeaseId}`,
    leaseId: sql`${environmentLeases.id}::text`,
  })})`;
}

/** This names a custody state, not permission to release or adopt a box. */
export function isNativeWorkspaceExportReleaseHold(lease: {
  status: string; cleanupStatus: string | null; failureReason: string | null; releasedAt: unknown;
}) {
  return lease.status === "retained" && lease.cleanupStatus === "failed"
    && lease.failureReason === "workspace_export_pending" && !lease.releasedAt;
}

/** Keep a physical-stop receipt while refusing the custody transition. Callers
 * must not count the returned retained row as a completed release. */
export function guardedNativeWorkspaceReleasePatch(input: {
  status: string; cleanupStatus: string | null; releasedAt: Date | SQL | null; failureReason: string | null;
}) {
  const allowed = nativeWorkspaceReleaseAllowedCondition();
  const releasedAt = input.releasedAt instanceof Date ? input.releasedAt.toISOString() : input.releasedAt;
  return {
    status: sql`case when ${allowed} then ${input.status} else 'retained' end`,
    cleanupStatus: sql`case when ${allowed} then ${input.cleanupStatus} else 'failed' end`,
    releasedAt: sql`case when ${allowed} then ${releasedAt}::timestamptz else null end`,
    failureReason: sql`case when ${allowed} then ${input.failureReason} else 'workspace_export_pending' end`,
  };
}
