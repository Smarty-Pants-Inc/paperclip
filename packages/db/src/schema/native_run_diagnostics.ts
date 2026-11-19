import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Crash custody for content-free run-log spans, not execution authority.
 * Insertions never allocate a run-event seq or UPDATE the run. */
export const nativeRunDiagnostics = pgTable("native_run_diagnostics", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  runId: uuid("run_id").notNull(),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  // Null means delivery is unconfirmed, not that the receipt is absent.
  lossReason: text("loss_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  run: foreignKey({ columns: [table.companyId, table.issueId, table.runId],
    foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id] }).onDelete("cascade"),
  runIdx: index("native_run_diagnostics_run_idx").on(table.companyId, table.runId),
}));
