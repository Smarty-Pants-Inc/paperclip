import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

// Match JavaScript trim(), not PostgreSQL btrim()'s space-only default.
// Whole-character alternatives also preserve UTF-8 sequences on SQL_ASCII.
const trimWhitespace = ["[\\t-\\r ]", "\u00a0", "\u1680",
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"].join("|");
const retainedBindingRefusal = `^(?:${trimWhitespace})*native_controller_recovery_missing_evidence:retained_sandbox_binding(?:${trimWhitespace})*$`;

/** Same closed cannot-resume cases as sessionCannotContinue. Compute BEFORE
 * redacting/summarizing resultJson so every Retry surface gets the same answer.
 * This is the consequence of a person's Retry, not permission to offer Retry. */
export const retryStartsNewSessionColumn = sql<boolean>`coalesce(
  ${heartbeatRuns.errorCode} = 'native_provider_state_incompatible'
  or (case when jsonb_typeof(${heartbeatRuns.resultJson}#>'{nativeExactResumeRefusal,refusal}') = 'string'
    then ${heartbeatRuns.resultJson}#>>'{nativeExactResumeRefusal,refusal}'
    else ${heartbeatRuns.error} end) ~ ${retainedBindingRefusal},
  false)`;
