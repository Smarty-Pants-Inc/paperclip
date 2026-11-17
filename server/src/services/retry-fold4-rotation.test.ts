import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { recordRetryFreshProviderThread } from "./fresh-continuation-fallback.js";

// retry-fold4 G4 + addendum R4. recordRetryFreshProviderThread is what Retry
// admission calls (explicit-native-continuation.ts recordRetryFreshProviderThread
// call; fresh-workspace-continuation.ts at preparation).
// G4: only a run a HOLD cancelled before it started (execution_reconciliation_
// required) stands in for its native predecessor. Upstream paperclipai 3b03ac10
// fresh-continuation-fallback.ts:421/:477/:801 counts exactly that shape as a
// dispatch refusal; a never-started run a PERSON cancelled is the person's own
// act, so a Retry naming it rotates nothing.
// R4: a rotation keeps the conversation (person comments), the trace (the
// source run and its provider session id) and records that no files are applied.
describe("retry fold 4: rotation guards (G4) and what a rotation keeps (R4)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("retry-fold4-rotation-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(cancelled: { errorCode: string; resultJson: Record<string, unknown> }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), nativeRunId = randomUUID(), neverStartedId = randomUUID();
    const sessionId = randomUUID();
    const now = Date.now();
    await db.insert(companies).values({ id: companyId, name: "Rotation", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: nativeRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      errorCode: "native_session_interrupted", nativeSessionId: sessionId, contextSnapshot: { issueId },
      createdAt: new Date(now - 600_000), startedAt: new Date(now - 590_000), finishedAt: new Date(now - 500_000), resultJson: {} });
    await db.insert(heartbeatRuns).values({ id: neverStartedId, companyId, agentId, status: "cancelled", invocationSource: "on_demand",
      contextSnapshot: { issueId }, createdAt: new Date(now - 400_000), finishedAt: new Date(now - 390_000), ...cancelled });
    await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "board", body: "Please finish the report." });
    return { companyId, agentId, issueId, nativeRunId, neverStartedId, sessionId };
  }
  const rotate = (f: Awaited<ReturnType<typeof seed>>) => db.transaction(tx => recordRetryFreshProviderThread(tx as unknown as Db, {
    companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, sourceRunId: f.neverStartedId, successorRunId: randomUUID(),
    trigger: "person_retry" }));

  it("G4: a Retry naming a never-started run a PERSON cancelled rotates nothing (the predecessor's thread is not replaced)", async () => {
    const f = await seed({ errorCode: "cancelled", resultJson: { cancelledByActorType: "user", cancelledByUserId: "board" } });
    expect(await rotate(f)).toBeNull();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    const [native] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.nativeRunId));
    expect(native!.resultJson).toEqual({});
  });

  it("G4 control + R4: a never-started run a HOLD cancelled stands in for its predecessor; the rotation keeps conversation and trace", async () => {
    const f = await seed({ errorCode: "execution_reconciliation_required", resultJson: { stopReason: "execution_reconciliation_required" } });
    const commentsBefore = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const recordId = await rotate(f);
    expect(recordId).toEqual(expect.any(String));
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, recordId!));
    expect(record!.evidence).toMatchObject({ runId: f.nativeRunId,
      freshContinuation: { sourceRunId: f.nativeRunId, retrySourceRunId: f.neverStartedId, trigger: "person_retry" },
      executionReconciliation: { workspaceRepairEvidence: expect.stringContaining("no unverified files are applied") } });
    // Conversation kept: every comment is still there, unchanged.
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toEqual(commentsBefore);
    // Trace kept: the source run and its provider session id stay; it only loses write authority.
    const [native] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.nativeRunId));
    expect(native).toMatchObject({ status: "failed", nativeSessionId: f.sessionId });
    expect(Object.keys(native!.resultJson ?? {})).toHaveLength(1);
  });
});
