import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { NativeTurnPromptExceedsCommandBoundError, nativeInputRevision } from "./native-runtime/native-turn-budget.js";

type Scope = { companyId: string; issueId: string };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
export function isNativeInputSizeRefusal(code: string | null | undefined): boolean {
  return code === "native_turn_prompt_exceeds_command_bound" || code === "command_payload_too_large";
}
async function currentInputRevision(db: Db, scope: Scope) {
  const [issue] = await db.select({ title: issues.title, description: issues.description }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
  if (!issue) return null;
  const messages = await db.select({ id: issueComments.id, authorType: issueComments.authorType,
    authorUserId: issueComments.authorUserId, createdByRunId: issueComments.createdByRunId,
    updatedAt: issueComments.updatedAt, deletedAt: issueComments.deletedAt }).from(issueComments)
    .where(and(eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId)))
    .orderBy(asc(issueComments.id));
  return nativeInputRevision(issue, messages.map(message => ({ ...message,
    authorType: message.authorType ?? (message.authorUserId ? "user" : "system"),
    updatedAt: message.updatedAt.toISOString(), deleted: message.deletedAt !== null })));
}
/** Persist the builder's exact refused revisions. Late command guards have no
 * builder error; take their failure-time source revision instead. */
export async function nativeInputRefusalEvidence(db: Db, run: { companyId: string; issueId?: string | null;
  nativeIssueId?: string | null; contextSnapshot: unknown }, error: unknown, code: string) {
  if (!isNativeInputSizeRefusal(code)) return {};
  const issueId = run.nativeIssueId ?? run.issueId ?? object(run.contextSnapshot).issueId;
  const revision = error instanceof NativeTurnPromptExceedsCommandBoundError && error.inputRevision
    ? error.inputRevision : typeof issueId === "string" ? await currentInputRevision(db, { companyId: run.companyId, issueId }) : null;
  return revision ? { nativeTurnPromptRefusalInput: revision } : {};
}
/** All automatic admissions consult the same durable source revision. User
 * wakes bypass this check: an edit/new request is an explicit attempt. Old
 * refusals without revision evidence fail closed until that person acts. */
export async function hasUnchangedNativeInputRefusal(db: Db, scope: Scope): Promise<boolean> {
  const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
    resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, scope.companyId),
    // A queued wake must not hide the refusal that still governs its input.
    inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "interrupted", "cancelled"]),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${scope.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!run || run.status !== "failed" || !isNativeInputSizeRefusal(run.errorCode)) return false;
  const saved = object(object(run.resultJson).nativeTurnPromptRefusalInput).fingerprint;
  if (typeof saved !== "string" || !/^[a-f0-9]{64}$/.test(saved)) return true;
  const current = await currentInputRevision(db, scope);
  return current === null || current.fingerprint === saved;
}
