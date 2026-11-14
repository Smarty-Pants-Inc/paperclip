// A fresh process, reading only this test's local ephemeral database.
import { and, eq } from "drizzle-orm";
import { createDb, issueComments, nativeRunResults } from "@paperclipai/db";
import { recordNativeFinalizationFailure } from "../services/native-runtime/native-run-finalizer.js";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
const [companyId, issueId, runId] = process.argv.slice(2);
const db = createDb(process.env.RFL_TEST_DATABASE_URL!);
try {
  const worker = nativeWorkspaceFinalizationWork(db, { onWorkspaceSettled: async () => {} });
  const entries = await worker.load({ companyId, runId });
  for (let i = 0; i < 2; i++) await recordNativeFinalizationFailure({ db, runId,
    error: new Error("native_workspace_sync_out_failed"), projectRunStatus: true, failureScope: "workspace" });
  const notices = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.issueId, issueId), eq(issueComments.createdByRunId, runId), eq(issueComments.authorType, "system")));
  const accepted = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
  console.log("RFL2_FRESH_PROCESS " + JSON.stringify({ pendingCount: entries.length, noticeIds: notices.map(n => n.id), acceptedIds: accepted.map(r => r.id) }));
} finally { await db.$client.end({ timeout: 1 }); }
