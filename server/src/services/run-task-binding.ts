import { sql } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { heartbeatRuns } from "@paperclipai/db";

export const runTaskContextColumn = sql<Record<string, unknown>>`jsonb_build_object(
  'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
  'taskId', ${heartbeatRuns.contextSnapshot}->'taskId'
)`;

type RunTaskBinding = {
  nativeIssueId?: string | null;
  issueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

/** Credential authority must never choose the first of conflicting stored bindings. */
export function assertBoundRunIssueId(run: RunTaskBinding): void {
  const values = [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId]
    .filter(value => value !== undefined && value !== null);
  if (values.some(value => typeof value !== "string" || !isUuidLike(value)) || new Set(values).size > 1) {
    throw forbidden("Run task identity is invalid", { code: "project_connection_run_context_invalid" });
  }
}

export function boundRunIssueId(run: RunTaskBinding): string | null {
  const values = [run.nativeIssueId, run.issueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId];
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
}

export function boundRunIssueIdSql() {
  return sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
    case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'issueId') = 'string'
      then nullif(btrim(${heartbeatRuns.contextSnapshot}->>'issueId'), '') end,
    case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'taskId') = 'string'
      then nullif(btrim(${heartbeatRuns.contextSnapshot}->>'taskId'), '') end)`;
}
