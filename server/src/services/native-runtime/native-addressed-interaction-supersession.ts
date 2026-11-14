import { issueComments, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isCurrentNotice } from "@paperclipai/shared";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Called only after a successful authorized acceptance, with issue and card
 * locked by acceptRequestConfirmation. This records history, never authority. */
export async function supersedeNativeAddressedInteractionFailureNotices(
  tx: DbTransaction,
  accepted: { id: string; companyId: string; issueId: string },
): Promise<void> {
  const cardKey = `native-addressed-failure:${accepted.id}`;
  const legacyRunKey = `^${cardKey}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`;
  const sameCardFailure = and(
    eq(issueComments.companyId, accepted.companyId),
    eq(issueComments.issueId, accepted.issueId),
    eq(issueComments.authorType, "system"),
    isNull(issueComments.deletedAt),
    or(
      sql`starts_with(${issueComments.clientRequestId}, ${`${cardKey}:reason:`})`,
      sql`${issueComments.clientRequestId} ~* ${legacyRunKey}`,
    ),
  );
  const candidates = await tx.select({ id: issueComments.id, metadata: issueComments.metadata })
    .from(issueComments).where(sameCardFailure).for("update");
  const currentIds = candidates.filter(row => isCurrentNotice(row.metadata)).map(row => row.id);
  if (currentIds.length === 0) return;
  await tx.update(issueComments).set({
    metadata: sql`coalesce(${issueComments.metadata}, '{}'::jsonb)
      || jsonb_build_object('supersededByInteractionId', ${accepted.id}::text)`,
    updatedAt: new Date(),
  }).where(and(sameCardFailure, inArray(issueComments.id, currentIds)));
}
