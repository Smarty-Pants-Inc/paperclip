// Fork-only regression ports; upstream intentionally deleted the stock suite.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { PrpEvent } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeQuestionBridgeInternals, projectNativeRuntimeRequest } from "./native-question-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping native question bridge tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("native question bridge", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let db: ReturnType<typeof createDb>;

  let companyId: string;

  let issueId: string;

  let agentId: string;

  let runId: string;

  let sessionId: string;

  let runnerInstanceId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-question-");
    db = createDb(temporary.connectionString);
  }, 20_000);

  // Projection does not dispatch a provider. Each row seeds a new company;
  // only the bridge's process-local registration needs resetting between rows.
  afterEach(() => { nativeQuestionBridgeInternals.resetForTests(); });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed() {
    companyId = randomUUID();
    issueId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();
    sessionId = randomUUID();
    runnerInstanceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native questions",
      issuePrefix: `NQ${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "operator-1", name: "Operator", email: "operator-1@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "operator-1", status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native Codex",
      adapterType: "paperclip_runner",
      status: "running",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Answer a native question",
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "operator-1",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      driverKind: "codex",
      contextSnapshot: { issueId },
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "observed",
    });
  }

  function runtimeRequestEvent(): PrpEvent {
    return {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "runtime-question-1",
      sourceSeq: 1,
      sourceInstanceId: runnerInstanceId,
      sourceKind: "runner",
      runId,
      normalizedSessionId: sessionId,
      turnId: "turn-1",
      itemId: "item-1",
      eventType: "runtime_request.created",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-25T18:00:00.000Z",
      payload: {
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "request-1",
          type: "input",
          status: "pending",
          prompt: "Choose a deployment color",
          input: {
            schema: "paperclip.question_set.v1",
            title: "Deployment",
            questions: [{
              id: "color",
              prompt: "Which color?",
              required: true,
              answerMode: "single_select",
              options: [
                { id: "blue", label: "Blue" },
                { id: "green", label: "Green" },
              ],
            }],
          },
        },
      },
    };
  }

  function binding() {
    return {
      companyId,
      issueId,
      runId,
      agentId,
      normalizedSessionId: sessionId,
      runnerSourceInstanceId: runnerInstanceId,
      completionContractId: randomUUID(),
      completionContractSha256: `sha256:${"a".repeat(64)}`,
      completionContractRevision: "1",
      completionContractCriterionIds: [],
    };
  }

  it.each(["valid", "cross-turn", "other-person", "equal-timestamp"])("freezes Pi card source to the same person's consumed input in cursor order (%s)", async scenario => {
    await seed();
    const database = db;
    await database.transaction(async transaction => {
    const db = transaction as unknown as typeof database;
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, agentId));
    await db.insert(authUsers).values({ id: "operator-2", name: "Other operator", email: "operator-2@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    const ids = Array.from({ length: 5 }, () => randomUUID());
    // PostgreSQL now() is stable across this transaction, including the nested
    // card insert: ACK, event and card creation timestamps are genuinely equal.
    const [clock] = await db.execute<{ instant: Date }>(sql`select now() as instant`);
    const sameTime = new Date(clock.instant);
    await db.insert(issueComments).values(ids.map((id, index) => ({ id, companyId, issueId,
      authorUserId: index === 3 ? "operator-2" : "operator-1", body: `Person input ${index}`, createdAt: sameTime })));
    const acknowledgements = {
      [ids[1]]: { status: "acknowledged", turnId: "turn-1", afterEventSeq: 10, acknowledgedAt: sameTime.toISOString() },
      [ids[2]]: { status: "acknowledged", turnId: "another-turn", afterEventSeq: 19, acknowledgedAt: sameTime.toISOString() },
      [ids[3]]: { status: "acknowledged", turnId: "turn-1", afterEventSeq: 18, acknowledgedAt: sameTime.toISOString() },
      [ids[4]]: { status: "acknowledged", turnId: "turn-1", afterEventSeq: 21, acknowledgedAt: sameTime.toISOString() },
    };
    // Cross-turn and other-person rows have no eligible same-person steer.
    if (scenario === "cross-turn") acknowledgements[ids[1]].turnId = "another-turn";
    if (scenario === "other-person") await db.update(issueComments).set({ authorUserId: "operator-2" }).where(eq(issueComments.id, ids[1]));
    if (scenario === "equal-timestamp") {
      acknowledgements[ids[2]].turnId = "turn-1";
      // All Dates are identical; cursor 19, not insertion/key order, wins.
      acknowledgements[ids[1]].afterEventSeq = 12;
    }
    const event = runtimeRequestEvent();
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "turn.started", createdAt: sameTime,
        payload: { prpEvent: { turnId: "turn-1" } } },
      { companyId, runId, agentId, seq: 20, eventType: event.eventType, createdAt: sameTime, payload: { prpEvent: event } },
    ]);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, wakeCommentId: ids[0] }, nextEventSeq: 23,
      resultJson: { queuedSteeringAcknowledgements: acknowledgements } }).where(eq(heartbeatRuns.id, runId));
    const interaction = await projectNativeRuntimeRequest({ db, binding: binding(), event });
    const expected = scenario === "cross-turn" || scenario === "other-person" ? ids[0] : scenario === "equal-timestamp" ? ids[2] : ids[1];
    expect(interaction!.sourceCommentId).toBe(expected);
    expect(new Date(interaction!.createdAt).getTime()).toBe(sameTime.getTime());
    // Projection replay after another ACK must preserve the frozen source.
    await db.update(heartbeatRuns).set({ resultJson: { queuedSteeringAcknowledgements: {
      ...acknowledgements, [ids[4]]: { ...acknowledgements[ids[4]], afterEventSeq: 24 },
    } } }).where(eq(heartbeatRuns.id, runId));
    expect((await projectNativeRuntimeRequest({ db, binding: binding(), event }))!.sourceCommentId).toBe(expected);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction!.id)))[0].sourceCommentId).toBe(expected);
    });
  });
});
