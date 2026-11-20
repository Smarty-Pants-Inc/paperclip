import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { isAcknowledgedNativeReassignmentStop, isAcknowledgedNativeStop, readPersonStoppedPreviousTurn } from "./acknowledged-native-stop.js";
const run = { id: "run", companyId: "company", nativeIssueId: "issue", status: "cancelled", resultJson: {
  cancelledByActorType: "user", cancelledByUserId: "board", nativeCancellation: {
    schema: "paperclip.native-cancellation.v1", runId: "run", companyId: "company", issueId: "issue",
    scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
    intentAuditId: "intent", acknowledgementAuditId: "ack",
  },
} };
it("recognizes the native receipt used by the Stop button", () => {
  expect(isAcknowledgedNativeStop(run)).toBe(true);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" }, { dispatched: false },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("refuses unrelated or incomplete receipts %j", change => {
  expect(isAcknowledgedNativeStop({ ...run, resultJson: { ...run.resultJson,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

it("recognizes an audited handoff without granting operator Stop semantics", () => {
  const handoff = { ...run, resultJson: { reassignmentStopRequested: true, nativeCancellation: run.resultJson.nativeCancellation } };
  expect(isAcknowledgedNativeReassignmentStop(handoff)).toBe(true);
  expect(isAcknowledgedNativeStop(handoff)).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop({ ...handoff, status: "running" })).toBe(false);
  expect(isAcknowledgedNativeReassignmentStop(run)).toBe(false);
});
it.each([{ runId: "other" }, { companyId: "other" }, { issueId: "other" }, { dispatchState: "pending" }, { dispatched: false },
  { scope: "subtree" }, { acknowledgementAuditId: undefined }])("requires an audited handoff receipt %j", change => {
  expect(isAcknowledgedNativeReassignmentStop({ ...run, resultJson: { reassignmentStopRequested: true,
    nativeCancellation: { ...run.resultJson.nativeCancellation, ...change } } })).toBe(false);
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("person Stop marker after a timed-out Interrupt cleanup", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("interrupt-stop-marker-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  it("keeps the queued Interrupt id across the cleanupTimedOut write and returns false for its successor", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), queueId = randomUUID();
    const stoppedRunId = randomUUID(), successorRunId = randomUUID();
    const createdAt = new Date("2026-11-20T00:00:00.000Z");
    await db.insert(companies).values({ id: companyId, name: "Interrupt marker boundary", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "sleep 600", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: stoppedRunId, companyId, agentId, nativeIssueId: issueId,
      status: "cancelled", runtimeMode: "native", createdAt, resultJson: {
        cancelledByActorType: "user", cancelledByUserId: "paul", queuedCommentInterruptQueueId: queueId,
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: stoppedRunId, companyId, issueId,
          scope: "run", reasonCode: "cancellation_run_only", dispatchState: "pending", dispatched: false,
          intentAuditId: randomUUID() },
      } });
    const acceptance = { schema: "paperclip.stop-acceptance.v1", kind: "interrupt", issueId, userId: "paul",
      acceptedAt: new Date(createdAt.getTime() + 100).toISOString() };
    const { row: accepted } = await appendHeartbeatRunEvent(db, { companyId, agentId, runId: stoppedRunId,
      eventType: "lifecycle", stream: "system", level: "info", message: "run.stop.accepted",
      payload: acceptance, keepRunUpdatedAt: true });

    // Persist A2's timeout acknowledgement shape at the reader's real DB boundary.
    // As in cancelNativeSession, lock/re-read current resultJson, then merge the acknowledgement.
    // This is a persisted-input test, not a provider cancellation/physical-stop test.
    await db.transaction(async tx => {
      const [locked] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stoppedRunId)).for("update");
      const resultJson = locked!.resultJson!;
      await tx.update(heartbeatRuns).set({ resultJson: { ...resultJson, nativeCancellation: {
        ...(resultJson.nativeCancellation as Record<string, unknown>), dispatchState: "acknowledged", dispatched: true,
        acknowledgementAuditId: randomUUID(), cleanupTimedOut: true,
      } } }).where(eq(heartbeatRuns.id, stoppedRunId));
    });
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, stoppedRunId));
    expect(stopped!.resultJson).toMatchObject({ queuedCommentInterruptQueueId: queueId,
      nativeCancellation: { cleanupTimedOut: true, dispatchState: "acknowledged" } });
    const [successor] = await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId,
      nativeIssueId: issueId, status: "queued", runtimeMode: "native", createdAt: new Date(createdAt.getTime() + 1000) }).returning();
    const read = () => readPersonStoppedPreviousTurn(db, { companyId, agentId, issueId,
      runId: successor!.id, runCreatedAt: successor!.createdAt });
    expect(await read(), "an Interrupt acceptance never grants Stop wording after a timeout").toBe(false);

    // Neither gate is a vacuous false: the queue marker excludes even a person_stop acceptance.
    await db.update(heartbeatRunEvents).set({ payload: { ...acceptance, kind: "person_stop" } })
      .where(eq(heartbeatRunEvents.id, accepted.id));
    expect(await read(), "the surviving queued interrupt id independently excludes Stop wording").toBe(false);
    const { queuedCommentInterruptQueueId: _queueId, ...withoutQueueId } = stopped!.resultJson!;
    await db.update(heartbeatRuns).set({ resultJson: withoutQueueId }).where(eq(heartbeatRuns.id, stoppedRunId));
    expect(await read(), "a genuine Stop with the same timeout does receive Stop wording").toBe(true);
    await db.update(heartbeatRunEvents).set({ payload: acceptance }).where(eq(heartbeatRunEvents.id, accepted.id));
    expect(await read(), "Interrupt acceptance alone excludes Stop wording even without the queue marker").toBe(false);

  });
});
