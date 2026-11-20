import { agentWakeupRequests } from "@paperclipai/db";
import { sql } from "drizzle-orm";

/** Maintenance owns updated_at (retry/backoff, scans, receipt repair), not the
 * person's quiet-time clock. Older receipts without a coalesce marker start at
 * requested_at; never rewrite requested_at, which also orders the saved input. */
export const deferredPersonWakeQuietAtSql = sql<Date>`greatest(
  ${agentWakeupRequests.requestedAt},
  (${agentWakeupRequests.payload}->>'_paperclipLastCoalescedAt')::timestamptz
)`.mapWith(agentWakeupRequests.requestedAt);
