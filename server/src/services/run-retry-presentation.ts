import { sql } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { resolveSessionContinuity } from "./native-runtime/continued-session.js";

export function agentRetryStartsNewSession(config: Record<string, unknown> | null | undefined) {
  return resolveSessionContinuity(config?.provider, config?.sessionContinuity) !== "continuous";
}

// Mirror resolveSessionContinuity, including invalid/missing settings and the
// Pi-only continuous default. Tenant-scoped and evaluated on the current config.
const nonContinuousAgent = sql<boolean>`coalesce((select case
  when retry_agent.adapter_config->>'sessionContinuity' = 'continuous' then false
  when retry_agent.adapter_config->>'sessionContinuity' = 'paperclip' then true
  else coalesce(retry_agent.adapter_config->>'provider' <> 'pi_rpc', true) end
  from ${agents} retry_agent where retry_agent.company_id = ${heartbeatRuns.companyId}
    and retry_agent.id = ${heartbeatRuns.agentId}), true)`;

// Match JavaScript trim(), not PostgreSQL btrim()'s space-only default.
// Whole-character alternatives also preserve UTF-8 sequences on SQL_ASCII.
const trimWhitespace = ["[\\t-\\r ]", "\u00a0", "\u1680",
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"].join("|");
const retainedBindingRefusal = `^(?:${trimWhitespace})*native_controller_recovery_missing_evidence:retained_sandbox_binding(?:${trimWhitespace})*$`;

/** Agent continuity plus the closed cannot-resume cases. Compute BEFORE
 * redacting/summarizing resultJson so every Retry surface gets the same answer.
 * This is the consequence of a person's Retry, not permission to offer Retry. */
export const retryStartsNewSessionColumn = sql<boolean>`${nonContinuousAgent} or coalesce(
  ${heartbeatRuns.errorCode} = 'native_provider_state_incompatible'
  or (case when jsonb_typeof(${heartbeatRuns.resultJson}#>'{nativeExactResumeRefusal,refusal}') = 'string'
    then ${heartbeatRuns.resultJson}#>>'{nativeExactResumeRefusal,refusal}'
    else ${heartbeatRuns.error} end) ~ ${retainedBindingRefusal},
  false)`;
