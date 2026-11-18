// Independent database reader proof; does not copy the classifier SQL.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, agentWakeupRequests, issueComments, runIdentityContexts, type Db, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { readFailedPreparationSettlement } from "../services/failed-preparation-settlement.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { createNativeRunLogExporter } from "../services/native-runtime/native-run-log-export.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { callbacks } from "../services/heartbeat/__tests__/run-control-fixtures.js";
import { readTaskRetryBoardMessageOrigin } from "../services/task-retry.js";
import { activityService } from "../services/activity.js";

describe("rf4 exact reader and real classifier", () => {
 let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
 beforeAll(async () => { postgres = await startEmbeddedPostgresTestDatabase("rf4-readers-"); db = createDb(postgres.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
 afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });
 async function seed() {
  const [company] = await db.insert(companies).values({ name: "rf4", issuePrefix: `T${randomUUID().slice(0,6)}` }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "worker", adapterType: "paperclip_runner" }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "No work", status: "in_progress", assigneeAgentId: agent.id }).returning();
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
   status: "failed", error: "prep failed", errorCode: "setup_failed", finishedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
  return run;
 }
 async function append(run: typeof heartbeatRuns.$inferSelect, message: string | null, eventType = "lifecycle", payload: any = null, level = "info") {
  return appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId, eventType, stream: "system", level: level as any, message, payload });
 }
 async function prep(run: typeof heartbeatRuns.$inferSelect) {
  await append(run, "prep failed", "error", null, "error");
  await append(run, "task.run.measured", "lifecycle", { phase: "task.run.measured", outcome: "failed", durationMs: 5, durableSettlement: true });
 }
 async function stop(run: typeof heartbeatRuns.$inferSelect) {
  await append(run, "run.stop.accepted", "lifecycle", { schema: "paperclip.stop-acceptance.v1", kind: "person_stop", issueId: run.issueId, userId: "owner", acceptedAt: new Date().toISOString() });
 }
 it("no row: ordinary exact preparation evidence still settles", async () => {
  const run = await seed(); await prep(run);
  expect(await readFailedPreparationSettlement(db, run)).toEqual({ unsupportedHarnessWarning: null });
 });
 it("with row before preparation failure: same settlement as B without row", async () => {
  const run = await seed(); await stop(run); await prep(run);
  expect(await readFailedPreparationSettlement(db, run)).toEqual({ unsupportedHarnessWarning: null });
 });
 it("NO stop row: NULL-message lifecycle must still refuse exact settlement (B result)", async () => {
  const run = await seed(); await prep(run); await append(run, null);
  const result = await readFailedPreparationSettlement(db, run);
  console.log("RF4_NULL_MESSAGE", JSON.stringify({ runId: run.id, events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)), result }));
  expect(result).toBeNull();
 });
 it.each(["without", "with", "null_tail"] as const)("real task Retry origin %s obeys B exact evidence", async mode => {
  let run = await seed();
  const actorId = "rf4-owner", at = new Date();
  const [comment] = await db.insert(issueComments).values({ companyId: run.companyId, issueId: run.issueId!, authorType: "user",
    authorUserId: actorId, body: "Continue my saved task", createdAt: at, updatedAt: at }).returning();
  const [identity] = await db.insert(runIdentityContexts).values({ companyId: run.companyId, runId: run.id, revision: 1,
    responsibleUserId: actorId, messageId: comment.id, cause: "issue_comment", correlationId: randomUUID(), status: "accepted" }).returning();
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: run.companyId, agentId: run.agentId, runId: run.id,
    source: "assignment", reason: "issue_reopened_via_comment", status: "failed", requestedByActorType: "user", requestedByActorId: actorId,
    payload: { issueId: run.issueId, commentId: comment.id } }).returning();
  [run] = await db.update(heartbeatRuns).set({ responsibleUserId: actorId, runtimeMode: "legacy", wakeupRequestId: wake.id,
    activeIdentityContextId: identity.id, runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "adapter_failed" },
    contextSnapshot: { issueId: run.issueId, source: "issue.comment.reopen", wakeCommentId: comment.id, wakeCommentIds: [comment.id] },
  }).where(eq(heartbeatRuns.id, run.id)).returning();
  if (mode === "with") await stop(run); await prep(run);
  if (mode === "null_tail") await append(run, null);
  const origin = await readTaskRetryBoardMessageOrigin(db, { companyId: run.companyId, issueId: run.issueId!, agentId: run.agentId, sourceRunId: run.id, actorId });
  console.log("RF4_TASK_RETRY_ORIGIN", JSON.stringify({ mode, runId: run.id, origin }));
  if (mode === "null_tail") expect(origin, "no Stop row: extra NULL-message lifecycle is still disqualifying at B").toBeNull();
  else expect(origin).toEqual({ commentId: comment.id, identityContextId: identity.id });
 });
 it("real native exporter recover and real lifecycle classifier ignore acceptance as work; events API shows it truthfully", async () => {
  const initial = await seed();
  const [run] = await db.update(heartbeatRuns).set({ status: "succeeded", error: null, errorCode: null }).where(eq(heartbeatRuns.id, initial.id)).returning();
  const lifecycle = callbacks(db);
  const before = await lifecycle.classifyAndPersistRunLiveness(run);
  await stop(run);
  const after = await lifecycle.classifyAndPersistRunLiveness(run);
  const fields = (r: any) => ({ livenessState: r.livenessState, livenessReason: r.livenessReason, lastUsefulActionAt: r.lastUsefulActionAt, nextAction: r.nextAction });
  console.log("RF4_CLASSIFIER", JSON.stringify({ runId: run.id, before: fields(before), after: fields(after) }));
  expect(fields(after)).toEqual(fields(before)); expect(after!.livenessState).not.toBe("advanced");
  await db.update(heartbeatRuns).set({ livenessState: null }).where(eq(heartbeatRuns.id, run.id));
  await activityService(db).runsForIssue(run.companyId, run.issueId!);
  let backfilled: typeof heartbeatRuns.$inferSelect | undefined;
  const deadline = Date.now() + 5_000;
  do {
    [backfilled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    if (backfilled.livenessState !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  console.log("RF4_ACTIVITY_BACKFILL", JSON.stringify({ runId: run.id, result: fields(backfilled) }));
  expect(fields(backfilled)).toEqual(fields(before));
  const chunks: string[] = [];
  const exporter = createNativeRunLogExporter({ db, companyId: run.companyId, runId: run.id, afterCursor: 0, enqueue: async (_cursor, chunk) => { chunks.push(chunk); }, flush: async () => {} });
  await exporter.recover(); expect(chunks).toEqual([]);
  const events = await createHeartbeatRunState(db).listEvents(run.id);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "lifecycle", stream: "system", message: "run.stop.accepted" })]));
  expect(await createHeartbeatRunState(db).listEvents(run.id, 0, 200, true)).toEqual([]);
 });
});
