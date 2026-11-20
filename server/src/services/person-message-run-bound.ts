import { sql, type SQL } from "drizzle-orm";

/** Automatic delivery may admit still-owed person input only while it is under
 * 24 hours old. Process boot is deliberately NOT a boundary. A new message or
 * explicit Retry supplies its own authorization time; a sweep does not.
 * SQL and in-memory callers share this exact strict boundary (24 h is expired).
 * Whether the message is owed remains owned by answeredPersonMessageSql.
 */
export function personMessageWithinRunBound(createdAt: Date, now?: Date): boolean;
export function personMessageWithinRunBound(createdAt: SQL, now?: Date): SQL;
export function personMessageWithinRunBound(createdAt: Date | SQL, now = new Date()): boolean | SQL {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  return createdAt instanceof Date
    ? Number.isFinite(createdAt.getTime()) && createdAt > cutoff
    : sql`${createdAt} > ${cutoff.toISOString()}::timestamptz`;
}
