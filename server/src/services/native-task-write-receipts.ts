import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db, type issues } from "@paperclipai/db";
import { sanitizeRecord } from "../redaction.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { nativeTaskSnapshotFields, withNativeTaskRevisions, type NativeTaskField } from "./native-task-snapshot.js";

export type NativeTaskWrite = { key: NativeTaskField; from: string; to: string; value: unknown };

/** Caller holds the issue row lock and owns the mutation transaction. Hash RAW
 * before/after rows, not display/audit prose. A rollback rolls this back too.
 * The entire receipt is under fieldRevisions, the server-only projection key.
 */
export async function persistNativeTaskWriteReceipt(tx: Db, input: {
  actorAgentId?: string | null; actorRunId?: string | null;
  before: typeof issues.$inferSelect; after: typeof issues.$inferSelect;
}) {
  const { before, after, actorAgentId, actorRunId } = input;
  if (!actorAgentId || !actorRunId) return;
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, actorRunId), eq(heartbeatRuns.companyId, before.companyId),
    eq(heartbeatRuns.agentId, actorAgentId), eq(heartbeatRuns.status, "running"),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId') = ${before.id}`,
  )).for("update");
  if (!run) return;
  const project = (row: typeof issues.$inferSelect) => withNativeTaskRevisions({ ...row,
    description: row.conversationAgentId ? null : row.description });
  const from = project(before), to = project(after);
  if (!from?.fieldRevisions || !to?.fieldRevisions) return;
  const writes: NativeTaskWrite[] = nativeTaskSnapshotFields.flatMap(key =>
    from.fieldRevisions![key] === to.fieldRevisions![key] ? [] : [{ key,
      from: from.fieldRevisions![key], to: to.fieldRevisions![key],
      // Display values are never used for identity. Apply both stock prose
      // sanitisation and the issue's registered-secret redactor before storage.
      value: sanitizeRecord({ value: to[key] })?.value,
    }]);
  if (!writes.length) return;
  // Redact only display values: a short registered secret can coincidentally
  // occur inside a keyed hex digest, which must remain opaque and comparable.
  const values = await createRunSecretRedactionRegistry(tx).redactForIssue(before.companyId, before.id, writes.map(write => write.value));
  const safe = writes.map((write, i) => ({ ...write, value: values[i] }));
  await tx.update(heartbeatRuns).set({
    contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{paperclipTaskWrites}',
      jsonb_build_object('issueId', ${before.id}::text, 'fieldRevisions',
        coalesce(${heartbeatRuns.contextSnapshot} #> '{paperclipTaskWrites,fieldRevisions}', '[]'::jsonb) || ${JSON.stringify(safe)}::jsonb))`,
  }).where(eq(heartbeatRuns.id, run.id));
}

/** Fail closed on malformed/legacy evidence; never reconstruct identity from
 * activityLog.details, which is display-sanitised and may omit changed fields.
 */
export function readNativeTaskWrites(value: unknown, issueId: string): NativeTaskWrite[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  if (row.issueId !== issueId || !Array.isArray(row.fieldRevisions)) return [];
  return row.fieldRevisions.filter((entry): entry is NativeTaskWrite => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const write = entry as NativeTaskWrite;
    return nativeTaskSnapshotFields.includes(write.key) && [write.from, write.to].every(
      revision => typeof revision === "string" && /^hmac-sha256:v1:[a-f0-9]{64}$/.test(revision));
  });
}
