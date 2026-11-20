import { environmentLeases } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

/** Shared terminal-workspace custody fence. A stopped process is not a saved
 * workspace. Apply at the write that ends custody, not only at orphan listing
 * or destructive cleanup. Older descriptor versions keep the same obligation.
 * A lease handoff is separate: the allocation remains owned by its adopter. */
export function nativeWorkspaceReleaseAllowedCondition() {
  return sql`not exists (select 1 from heartbeat_runs workspace_source
    where workspace_source.company_id = ${environmentLeases.companyId}
      and workspace_source.id = ${environmentLeases.heartbeatRunId}
      and workspace_source.runtime_mode = 'native'
      and workspace_source.runner_profile_json#>>'{nativeWorkspaceSync,state}' = 'prepared'
      and workspace_source.runner_profile_json#>>'{nativeWorkspaceSync,leaseId}' = ${environmentLeases.id}::text
      and workspace_source.runner_profile_json#>>'{nativeWorkspaceSync,providerLeaseId}' = ${environmentLeases.providerLeaseId}
      -- Existing recovery can preserve an exact allocation in verified object
      -- storage when its original host/merge descriptor no longer exists. Its
      -- operation is succeeded only AFTER archive and manifest SHA read-back.
      and not exists (select 1 from workspace_operations saved_copy
        where saved_copy.company_id = workspace_source.company_id
          and saved_copy.heartbeat_run_id = workspace_source.id
          and saved_copy.phase = 'workspace_recovery_snapshot' and saved_copy.status = 'succeeded'
          and saved_copy.metadata->>'schema' = 'paperclip.workspace-recovery-snapshot.v1'
          and saved_copy.metadata->>'leaseId' = ${environmentLeases.id}::text
          and saved_copy.metadata->>'providerLeaseId' = ${environmentLeases.providerLeaseId}
          and saved_copy.metadata#>>'{archive,sha256}' ~ '^[a-f0-9]{64}$'
          and saved_copy.metadata#>>'{manifest,sha256}' ~ '^[a-f0-9]{64}$'
          and saved_copy.metadata#>>'{archive,byteSize}' ~ '^[1-9][0-9]*$'
          and saved_copy.metadata#>>'{manifest,byteSize}' ~ '^[1-9][0-9]*$'
          and saved_copy.metadata#>>'{archive,objectKey}' = workspace_source.company_id::text || '/workspace-recovery/' || workspace_source.id::text || '/' || ${environmentLeases.id}::text || '/' || (saved_copy.metadata#>>'{archive,sha256}') || '.tar'
          and saved_copy.metadata#>>'{manifest,objectKey}' = workspace_source.company_id::text || '/workspace-recovery/' || workspace_source.id::text || '/' || ${environmentLeases.id}::text || '/' || (saved_copy.metadata#>>'{manifest,sha256}') || '.jsonl'))`;
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
