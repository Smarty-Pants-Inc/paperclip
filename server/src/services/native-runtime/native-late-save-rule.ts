import { and, eq, gte, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { readReplyFileLine } from "@paperclipai/shared";

/**
 * Where a LATE save of an ended run's files may land (RFL 11-19, K15).
 *
 * A late save is any save that finishes after the run ended: the retained-
 * workspace recovery worker, the startup reconciler, Retry export, a late
 * copy-back. It never changes the run (K12). Its bytes go:
 *  - `workspace` (K15a): into the task's workspace, and the reply's file line
 *    moves once (KEPT -> saved), only while the line does not read LOST and no
 *    newer run exists on the task;
 *  - `aside` (K15b, K15c): the line already reads LOST, or a newer run exists.
 *    Nothing is written into the task's workspace and nothing is published as
 *    this run's. The bytes are kept aside (a separate stored snapshot, or the
 *    retained box). They are never discarded.
 */
export type LateSaveRule = { target: "workspace" } | { target: "aside"; reason: "line_lost" | "newer_run" };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The person was told this reply's files could not be saved. */
export function replyFileLineReadsLost(resultJson: unknown): boolean {
  return readReplyFileLine(record(record(resultJson).presentationDecision).fileLine)?.state === "lost";
}

export async function readLateSaveRule(db: Db, input: { companyId: string; issueId: string; runId: string }): Promise<LateSaveRule> {
  const [run] = await db.select({ createdAt: heartbeatRuns.createdAt,
    fileLine: sql<unknown>`${heartbeatRuns.resultJson} #> '{presentationDecision,fileLine}'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run) return { target: "workspace" };
  if (readReplyFileLine(run.fileLine)?.state === "lost") return { target: "aside", reason: "line_lost" };
  // The same newer-run fact as the preserved-result guard (preserved-result-finalization.ts).
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
    gte(heartbeatRuns.createdAt, run.createdAt),
  )).limit(1);
  return newer ? { target: "aside", reason: "newer_run" } : { target: "workspace" };
}
