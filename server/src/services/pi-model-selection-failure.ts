import { and, eq, isNull } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { PI_MODEL_PROVIDER_REQUIRED } from "../adapters/pi-model-selection.js";
import type { issueService } from "./issues.js";

type FailedSelectionRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "status" | "errorCode" | "error" | "contextSnapshot">;

/** Repairable, run-keyed notice; the issue lock fences concurrent finalizers/recovery. */
export async function ensurePiModelSelectionFailureNotice(
  db: Db,
  run: FailedSelectionRun,
  addComment: ReturnType<typeof issueService>["addComment"],
) {
  if (run.status !== "failed" || run.errorCode !== PI_MODEL_PROVIDER_REQUIRED) return;
  const issueId = run.contextSnapshot?.issueId;
  if (typeof issueId !== "string" || !issueId) return;
  await db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).for("update");
    if (!issue) return;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.createdByRunId, run.id), eq(issueComments.authorType, "system"),
      eq(issueComments.origin, "comment"), isNull(issueComments.deletedAt),
    )).limit(1);
    if (existing) return;
    await addComment(issueId, run.error ?? "Pi requires a provider/model selection before this message can run.",
      { runId: run.id }, { authorType: "system" }, tx);
  });
}
