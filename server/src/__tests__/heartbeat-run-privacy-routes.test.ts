import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { piUsageFacadeEvents } from "./helpers/pi-usage-facade.js";
import { budgetService, computeObservedSpend } from "../services/budgets.js";
import { assertBudgetAdmissionAtLimits } from "./helpers/budget-admission-at-limits.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { costService } from "../services/costs.js";
import { subscriptionCostReport } from "../services/subscription-report.js";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { createFullDatabaseResponseCapture, installDatabaseResponseCapture } from "./helpers/full-database-response-capture.js";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  budgetPolicies,
  budgetReservations,
  agentRuntimeState,
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueAccessGrants,
  issues,
  nativeRunFinalizations,
  runUsageReceipts,
  toolApplications,
  toolConnections,
  workspaceOperations,
} from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { authorizationService } from "../services/authorization.js";
import { canActorReadWorkspaceOperation, getHeartbeatRunReadDecisions } from "../services/heartbeat-run-privacy.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { claimCancellationRequest } from "../services/native-runtime/native-cancellation-request.js";
import { createNativeUsageDelivery } from "../services/native-runtime/native-usage-delivery.js";
import type { UsageReceiptEnvelope } from "../services/usage-receipts.js";
import { QUALIFIED_PI_RPC_PROFILE, type PrpEvent } from "../vendor/paperclip-runner/index.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_LOG_PRIVACY_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat run privacy routes", { concurrent: false }, () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    if (!externalDatabaseUrl) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-privacy-routes-");
    db = createDb(externalDatabaseUrl ?? tempDb!.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 120_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueAccessGrants);
    await db.delete(agentRuntimeState);
    await db.delete(nativeRunFinalizations);
    await db.delete(costEvents);
    await db.delete(budgetReservations);
    await db.delete(budgetPolicies);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
    if (externalDatabaseUrl) await db.$client.end({ timeout: 1 });
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const grantedAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const otherUserId = `other-${randomUUID()}`;
    const issueId = randomUUID();
    const privateRunId = randomUUID();
    const maintenanceRunId = randomUUID();
    const operationId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Run Privacy",
      issuePrefix: "RPR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([ownerUserId, otherUserId].map((id) => ({
      id,
      name: id === ownerUserId ? "Owner user" : "Other user",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })));
    await db.insert(companyMemberships).values([ownerUserId, otherUserId].map((principalId) => ({
      companyId,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: "operator",
    })));
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Owner",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: grantedAgentId,
        companyId,
        name: "Granted reviewer",
        role: "security",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other agent",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RPR-1",
      title: "Confidential email triage",
      description: "private@example.test",
      visibility: "private",
      privacyRootIssueId: issueId,
      status: "in_progress",
      responsibleUserId: ownerUserId,
      assigneeAgentId: ownerAgentId,
    });
    await db.insert(issueAccessGrants).values({
      issueId,
      subjectType: "agent",
      subjectId: grantedAgentId,
      source: "explicit",
      grantedByAgentId: ownerAgentId,
    });

    const startedAt = new Date("2026-07-31T12:00:00.000Z");
    const finishedAt = new Date("2026-07-31T12:01:00.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: privateRunId,
        companyId,
        agentId: ownerAgentId,
        scopeKind: "issue",
        issueId,
        invocationSource: "assignment",
        status: "running",
        startedAt,
        finishedAt,
        usageJson: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 },
        resultJson: { summary: "Read the confidential email", costUsd: 0.42 },
        contextSnapshot: { issueId, title: "Confidential email triage" },
        logStore: "local_file",
        logRef: "missing-private-run-log.ndjson",
      },
      {
        id: maintenanceRunId,
        companyId,
        agentId: ownerAgentId,
        scopeKind: "company",
        issueId: null,
        invocationSource: "timer",
        status: "succeeded",
        startedAt,
        finishedAt,
        resultJson: { summary: "Maintenance complete", costUsd: 0.01 },
        contextSnapshot: { wakeReason: "heartbeat_timer" },
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: privateRunId,
      agentId: ownerAgentId,
      seq: 1,
      eventType: "output",
      stream: "stdout",
      message: "private@example.test",
    });
    await db.insert(workspaceOperations).values({
      id: operationId,
      companyId,
      heartbeatRunId: privateRunId,
      issueId: null,
      phase: "provision",
      status: "succeeded",
      command: "read private email",
      stdoutExcerpt: "private@example.test",
      logStore: "local_file",
      logRef: "missing-private-operation-log.ndjson",
    });

    return {
      companyId,
      ownerAgentId,
      grantedAgentId,
      otherAgentId,
      ownerUserId,
      otherUserId,
      issueId,
      privateRunId,
      maintenanceRunId,
      operationId,
    };
  }

  function createApp(companyId: string, agentId: string, sourceDb = db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", agentRoutes(sourceDb));
    app.use("/api", activityRoutes(sourceDb));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(companyId: string, userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // Keep reason: real incidents 4a2004cc and 54a1eaaa lost all measured
  // tokens when the last facade receipt was incomplete (PR #19 audit).
  it.each(["summary", "interrupt"])("fix3 real-path %s preserves measured usage through facade, replay and run API", async trigger => {
    const f = await seedFixture(), runnerInstanceId = randomUUID(), runId = f.privateRunId;
    await db.update(heartbeatRuns).set({ runnerInstanceId, runtimeMode: "native", costAccountingPending: true })
      .where(eq(heartbeatRuns.id, runId));
    const input = { companyId: f.companyId, runId, runnerInstanceId,
      provider: { kind: "pi_rpc" as const, profile: QUALIFIED_PI_RPC_PROFILE, model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "xhigh" as const },
      billing: { provider: "anthropic", biller: "anthropic", billingType: "metered_api" as const } };
    const fixture = JSON.parse(readFileSync(new URL(`../../../packages/paperclip-runner/test-fixtures/pi-rpc/${trigger === "summary" ? "real-session-usage-only" : "real-interrupt-usage-only"}.json`, import.meta.url), "utf8"));
    const native: Record<string, unknown>[] = trigger === "summary"
      ? fixture.events.slice(0, fixture.events.findIndex((event: { type: string }) => event.type === "compaction_end") + 1)
      : fixture.nativeReplay;
    const expected = trigger === "interrupt" ? fixture.expected : native.reduce((sum: Record<string, number>, event: any) => {
      const usage = event.message?.usage;
      if (usage) { sum.inputTokens += usage.input + usage.cacheWrite; sum.outputTokens += usage.output;
        sum.cachedInputTokens += usage.cacheRead; sum.cacheWriteTokens += usage.cacheWrite; }
      return sum;
    }, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 });
    const events = await piUsageFacadeEvents(native, runId, runnerInstanceId, trigger === "interrupt" ? "turn.cancelled" : "turn.completed");
    expect(events.filter(event => event.eventType === "usage.reported").at(-1)?.payload).toMatchObject({ runDeltaAvailable: false });
    let delivery = await createNativeUsageDelivery(db, input);
    for (const event of events) await delivery.capture(event);
    delivery = await createNativeUsageDelivery(db, input);
    for (const event of events) await delivery.capture(event);
    const response = await request(createApp(f.companyId, f.ownerAgentId)).get(`/api/heartbeat-runs/${runId}`).expect(200);
    expect(response.body.usageJson).toMatchObject({ ...expected, accountingReceiptReady: true, accountingUsageLost: true, costStatus: "unpriced",
      pricingProvenance: { evidence: expect.stringContaining("lower bound") } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    expect(await costService(db).summary(f.companyId)).toMatchObject({ accountingUsageLost: true, pricingComplete: false });
    expect((await costService(db).byAgent(f.companyId))[0]).toMatchObject({ accountingUsageLost: true, inputTokens: expected.inputTokens });
    await assertBudgetAdmissionAtLimits(db, f.companyId, f.ownerAgentId, 1);
    // The redacted production order itself must also survive receipt replay;
    // its snapshots are already normalized by the real Runner facade.
    if (trigger === "interrupt") {
      const other = { companyId: f.companyId, privateRunId: f.maintenanceRunId }, otherRunner = randomUUID();
      const direct = await createNativeUsageDelivery(db, { ...input, companyId: other.companyId, runId: other.privateRunId, runnerInstanceId: otherRunner });
      for (const [index, receipt] of fixture.receipts.entries()) {
        const isUsage = receipt.payload.kind === "usage" && receipt.payload.usage;
        await direct.capture({ ...events[0], runId: other.privateRunId, sourceInstanceId: otherRunner,
          sourceEventId: `production-${index}`, sourceSeq: index + 1, eventType: isUsage ? "usage.reported" : receipt.eventType,
          payload: isUsage ? { runDelta: receipt.payload.usage.runDelta, runDeltaAvailable: receipt.payload.usage.runDeltaComplete } : receipt.payload });
      }
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other.privateRunId));
      expect(saved.usageJson).toMatchObject({ ...expected, accountingReceiptReady: true });
    }
  });

  it.each(["typed", "prose", "normal"])("fix3 %s restore-gap admission at 99/100 and 101/100 cents", async kind => {
    const f = await seedFixture(), runnerInstanceId = randomUUID(), runId = f.privateRunId;
    await db.update(heartbeatRuns).set({ runnerInstanceId, runtimeMode: "native", status: "running", costAccountingPending: true })
      .where(eq(heartbeatRuns.id, runId));
    const delivery = await createNativeUsageDelivery(db, { companyId: f.companyId, runId, runnerInstanceId,
      provider: { kind: "opencode", model: "unknown-test-model" },
      billing: { provider: "test", biller: "test", billingType: "metered_api" } });
    const values = [
      ["turn.failed", "lost", { error: { code: "provider_turn_lost_on_restore" } }],
      ["turn.started", "next", {}],
      ["usage.reported", "next", { runDeltaAvailable: true, runDelta: { inputTokens: 11, outputTokens: 3 } }],
      ["turn.completed", "next", {}],
    ] as const;
    const selected = kind === "typed" ? values : values.slice(1);
    for (const [index, [eventType, turnId, payload]] of selected.entries()) await delivery.capture({ schema: "paperclip.prp.event.v1", schemaVersion: 1,
      sourceKind: "runner", sourceInstanceId: runnerInstanceId, sourceEventId: `budget-${index}`, sourceSeq: index + 1, priority: 0,
      runId, normalizedSessionId: "budget-session", emittedAt: new Date().toISOString(), eventType, turnId, payload } as PrpEvent);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (kind !== "normal") await db.update(heartbeatRuns).set({ usageJson: { ...saved.usageJson,
      pricingProvenance: { source: "unknown", evidence: kind === "typed" ? "wording changed" : "lost on restore" } } })
      .where(eq(heartbeatRuns.id, runId));
    await assertBudgetAdmissionAtLimits(db, f.companyId, f.ownerAgentId, kind === "typed" ? 0 : 1);
  });

  it("marks company and agent totals that include lower-bound runs, without changing their measured money", async () => {
    const f = await seedFixture();
    await db.update(heartbeatRuns).set({ usageJson: { accountingUsageLost: true } }).where(eq(heartbeatRuns.id, f.privateRunId));
    await db.insert(costEvents).values([
      { companyId: f.companyId, agentId: f.ownerAgentId, heartbeatRunId: f.privateRunId, provider: "test", model: "first", billingType: "metered_api", costStatus: "reported", costCents: 25, inputTokens: 11, outputTokens: 3, occurredAt: new Date() },
      { companyId: f.companyId, agentId: f.ownerAgentId, heartbeatRunId: f.privateRunId, provider: "test", model: "second", billingType: "metered_api", costStatus: "estimated", costCents: 10, inputTokens: 7, outputTokens: 2, occurredAt: new Date() },
      { companyId: f.companyId, agentId: f.otherAgentId, heartbeatRunId: f.maintenanceRunId, provider: "test", model: "normal", billingType: "metered_api", costStatus: "reported", costCents: 5, inputTokens: 2, outputTokens: 1, occurredAt: new Date() },
    ]);
    const costs = costService(db);
    expect(await costs.summary(f.companyId)).toMatchObject({ accountingUsageLost: true, pricingComplete: false, spendCents: 40 });
    expect((await subscriptionCostReport(db, f.companyId, { userId: f.ownerUserId, canManage: false })).api)
      .toMatchObject({ accountingUsageLost: true, costCents: "40.0000000" });
    const byAgent = await costs.byAgent(f.companyId);
    expect(byAgent.find(row => row.agentId === f.ownerAgentId)).toMatchObject({ accountingUsageLost: true, costCents: 35, inputTokens: 18 });
    expect(byAgent.find(row => row.agentId === f.otherAgentId)).toMatchObject({ accountingUsageLost: false, costCents: 5 });
    expect((await costs.byAgentModel(f.companyId)).filter(row => row.agentId === f.ownerAgentId)).toEqual([
      expect.objectContaining({ accountingUsageLost: true }), expect.objectContaining({ accountingUsageLost: true }),
    ]);
    expect(await costs.summary(f.companyId, { from: new Date("2000-01-01"), to: new Date("2000-01-02") }))
      .toMatchObject({ accountingUsageLost: false, pricingComplete: true, spendCents: 0 });
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Other company", issuePrefix: "OTHER" });
    const [foreignAgent] = await db.insert(agents).values({ companyId: foreignCompanyId, name: "Other agent", role: "engineer", adapterType: "process" }).returning();
    await db.insert(costEvents).values({ companyId: foreignCompanyId, agentId: foreignAgent.id, heartbeatRunId: f.privateRunId,
      provider: "test", model: "foreign", billingType: "metered_api", costStatus: "reported", costCents: 3, occurredAt: new Date() });
    expect(await costs.summary(foreignCompanyId)).toMatchObject({ accountingUsageLost: false, pricingComplete: true, spendCents: 3 });
  });

  it("blocks a typed lower-bound final charge under block-unpriced, just like prose-only uncertainty", async () => {
    const f = await seedFixture();
    await db.update(heartbeatRuns).set({ usageJson: { accountingUsageLost: true } }).where(eq(heartbeatRuns.id, f.privateRunId));
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100000, unpricedUsagePolicy: "block", notifyEnabled: false }).returning();
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.ownerAgentId, heartbeatRunId: f.privateRunId,
      idempotencyKey: `heartbeat:${f.privateRunId}:final`, provider: "test", model: "unpriced", billingType: "metered_api",
      costStatus: "unpriced", costCents: 0, inputTokens: 11, outputTokens: 3, occurredAt: new Date() });
    expect((await computeObservedSpend(db, policy)).unpricedEventCount).toBe(1);
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.ownerAgentId)).not.toBeNull();
    await db.update(heartbeatRuns).set({ usageJson: { pricingProvenance: { source: "unknown", evidence: "Pi summary usage is unknown; observed usage and cost are a lower bound" } } })
      .where(eq(heartbeatRuns.id, f.privateRunId));
    expect((await computeObservedSpend(db, policy)).unpricedEventCount).toBe(1);
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.ownerAgentId)).not.toBeNull();
    await db.update(heartbeatRuns).set({ usageJson: { accountingUsageLost: true } }).where(eq(heartbeatRuns.id, f.privateRunId));
    await db.update(costEvents).set({ costCents: 100001, costStatus: "reported" }).where(eq(costEvents.heartbeatRunId, f.privateRunId));
    expect(await computeObservedSpend(db, policy)).toMatchObject({ totalExact: "100001.0000000", unpricedEventCount: 0 });
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.ownerAgentId)).not.toBeNull();
  });

  it("exposes the missing Pi summary lower bound in the run API after receipt replay and another turn", async () => {
    const f = await seedFixture(), runnerInstanceId = randomUUID();
    const runId = f.privateRunId;
    await db.update(heartbeatRuns).set({ runnerInstanceId, runtimeMode: "native", costAccountingPending: true })
      .where(eq(heartbeatRuns.id, runId));
    const input = { companyId: f.companyId, runId, runnerInstanceId,
      provider: { kind: "pi_rpc" as const, profile: QUALIFIED_PI_RPC_PROFILE, model: "paperclip/faux", piRpcThinkingLevel: "xhigh" as const },
      billing: { provider: "anthropic", biller: "unknown", billingType: "unknown" as const } };
    let delivery = await createNativeUsageDelivery(db, input);
    let sequence = 0;
    const capture = async (eventType: string, turnId: string, payload: Record<string, unknown> = {}) => {
      await delivery.capture({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner",
        sourceInstanceId: runnerInstanceId, sourceEventId: `summary-${++sequence}`, sourceSeq: sequence,
        priority: 0, runId, normalizedSessionId: "summary-session", emittedAt: new Date().toISOString(),
        eventType, turnId, payload } as PrpEvent);
    };
    await capture("turn.started", "compacting");
    await capture("usage.reported", "compacting", { runDeltaAvailable: true,
      runDelta: { inputTokens: 11, outputTokens: 3 }, summaryUsage: "unknown", accountingUsageLost: true });
    await capture("turn.completed", "compacting");
    delivery = await createNativeUsageDelivery(db, input);
    await capture("turn.started", "later");
    await capture("usage.reported", "later", { runDeltaAvailable: true, runDelta: { inputTokens: 7, outputTokens: 5 } });
    await capture("turn.completed", "later");
    const receipts = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, runId));
    expect(receipts).toHaveLength(6);
    const latest = receipts.find(receipt => receipt.sequence === sequence)!;
    expect(latest.receiptJson.receipt).toMatchObject({ complete: true, accountingUsageLost: true, usage: { inputTokens: 18, outputTokens: 8 },
      pricingProvenance: { source: "unknown", evidence: expect.stringMatching(/summary.*unknown.*lower bound/i) } });
    expect((receipts.find(receipt => receipt.sequence === 2)!.receiptJson as UsageReceiptEnvelope).producerEvent?.usage)
      .toMatchObject({ summaryUsage: "unknown", accountingUsageLost: true });
    const response = await request(createApp(f.companyId, f.ownerAgentId))
      .get(`/api/heartbeat-runs/${runId}`).expect(200);
    expect(response.body.usageJson).toMatchObject({ inputTokens: 18, outputTokens: 8,
      accountingReceiptReady: true, accountingUsageLost: true, costStatus: "unpriced", pricingProvenance: {
        source: "unknown", evidence: expect.stringMatching(/summary.*unknown.*lower bound/i),
      } });
  });

  it("lists workspace operations with small run reads and checks a revoked issue grant again", async () => {
    const f = await seedFixture(), payload = "workspace-operation-saved-input🙂".repeat(25_000);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, prompt: payload },
      runnerProfileJson: { instructions: payload }, stdoutExcerpt: payload, stderrExcerpt: payload,
    }).where(eq(heartbeatRuns.id, f.privateRunId));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.privateRunId));
    const observed = createDb(externalDatabaseUrl ?? tempDb!.connectionString), events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createFullDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(observed, { heartbeatRuns }, capture);
    try {
      const app = createApp(f.companyId, f.grantedAgentId, observed);
      const response = await request(app).get(`/api/heartbeat-runs/${f.privateRunId}/workspace-operations`).expect(200);
      expect(response.body).toEqual([expect.objectContaining({ id: f.operationId })]);
      capture.flush();
      const reads = events.filter(event => event.table === "heartbeat_runs" && event.operation === "select");
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.reduce((bytes, event) => bytes + Number(event.responseValueBytes), 0)).toBeLessThan(2048);
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.subjectId, f.grantedAgentId));
      await request(app).get(`/api/heartbeat-runs/${f.privateRunId}/workspace-operations`).expect(404);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.privateRunId)))[0]).toEqual(before);
    } finally { capture.flush(); await observed.$client.end(); }
  });

  it.each(["local_file", "s3_segments"])("returns 404 for private %s run content and metadata-only list stubs", async (logStore) => {
    const fixture = await seedFixture();
    await db.update(heartbeatRuns).set({ logStore }).where(eq(heartbeatRuns.id, fixture.privateRunId));
    const app = createApp(fixture.companyId, fixture.otherAgentId);

    for (const path of [
      `/api/heartbeat-runs/${fixture.privateRunId}`,
      `/api/heartbeat-runs/${fixture.privateRunId}/events`,
      `/api/heartbeat-runs/${fixture.privateRunId}/events?view=plugin-panels`,
      `/api/heartbeat-runs/${fixture.privateRunId}/log`,
      `/api/heartbeat-runs/${fixture.privateRunId}/workspace-operations`,
      `/api/workspace-operations/${fixture.operationId}/log`,
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("private@example.test");
    }

    const history = await request(app).get(`/api/companies/${fixture.companyId}/heartbeat-runs`);
    expect(history.status).toBe(200);
    const privateStub = history.body.find((run: { id: string }) => run.id === fixture.privateRunId);
    expect(privateStub).toMatchObject({
      redacted: true,
      durationMs: 60_000,
      costUsd: 0.42,
      usageJson: { inputTokens: 11, cachedInputTokens: 2, outputTokens: 7 },
    });
    expect(privateStub).not.toHaveProperty("issueId");
    expect(privateStub).not.toHaveProperty("contextSnapshot");
    expect(privateStub).not.toHaveProperty("resultJson");
    expect(JSON.stringify(privateStub)).not.toContain("Confidential email triage");
    expect(JSON.stringify(privateStub)).not.toContain("summary");

    const summarizedHistory = await request(app)
      .get(`/api/companies/${fixture.companyId}/heartbeat-runs?summary=true`);
    const summarizedStub = summarizedHistory.body.find((run: { id: string }) => run.id === fixture.privateRunId);
    expect(summarizedStub).toMatchObject({ redacted: true, durationMs: 60_000, costUsd: 0.42 });
    expect(summarizedStub.usageJson).toMatchObject({ inputTokens: 11, outputTokens: 7 });

    const live = await request(app).get(`/api/companies/${fixture.companyId}/live-runs`);
    expect(live.status).toBe(200);
    expect(live.body[0]).toMatchObject({ id: fixture.privateRunId, redacted: true, costUsd: 0.42 });
    expect(live.body[0]).not.toHaveProperty("issueId");

    const maintenance = await request(app).get(`/api/heartbeat-runs/${fixture.maintenanceRunId}`);
    expect(maintenance.status).toBe(200);
    expect(maintenance.body.resultJson.summary).toBe("Maintenance complete");
  });

  it("filters latest failures within the requested run window and preserves private-run redaction", async () => {
    const f = await seedFixture();
    await db.update(heartbeatRuns).set({ status: "failed", createdAt: new Date("2026-10-26T10:00:00Z") })
      .where(eq(heartbeatRuns.id, f.privateRunId));
    await db.update(heartbeatRuns).set({ createdAt: new Date("2026-10-26T09:00:00Z") })
      .where(eq(heartbeatRuns.id, f.maintenanceRunId));
    const timeoutId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timeoutId, companyId: f.companyId, agentId: f.otherAgentId, scopeKind: "company",
      invocationSource: "timer", status: "timed_out", createdAt: new Date("2026-10-26T11:00:00Z"),
    });
    const app = createApp(f.companyId, f.otherAgentId);
    const path = `/api/companies/${f.companyId}/heartbeat-runs?summary=true&latestFailuresOnly=true`;
    const response = await request(app).get(path).expect(200);
    expect(response.body.map((run: { id: string }) => run.id)).toEqual([timeoutId, f.privateRunId]);
    const privateStub = response.body[1];
    expect(privateStub).toMatchObject({ redacted: true, status: "failed" });
    expect(privateStub).not.toHaveProperty("issueId");
    expect(privateStub).not.toHaveProperty("contextSnapshot");
    expect(JSON.stringify(response.body)).not.toContain("Confidential email triage");
    const bounded = await request(app).get(`${path}&limit=1`).expect(200);
    expect(bounded.body.map((run: { id: string }) => run.id)).toEqual([timeoutId]);
    const agentOnly = await request(app).get(`${path}&agentId=${f.ownerAgentId}`).expect(200);
    expect(agentOnly.body.map((run: { id: string }) => run.id)).toEqual([f.privateRunId]);
    // A newer success suppresses an older failure rather than selecting the latest failure alone.
    await db.update(heartbeatRuns).set({ createdAt: new Date("2026-10-26T12:00:00Z") })
      .where(eq(heartbeatRuns.id, f.maintenanceRunId));
    const recovered = await request(app).get(path).expect(200);
    expect(recovered.body.map((run: { id: string }) => run.id)).toEqual([timeoutId]);
  });

  it("returns full private-run content to the owner and an explicitly granted agent", async () => {
    const fixture = await seedFixture();

    for (const agentId of [fixture.ownerAgentId, fixture.grantedAgentId]) {
      const app = createApp(fixture.companyId, agentId);
      const detail = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ issueId: fixture.issueId });
      expect(detail.body.resultJson.summary).toBe("Read the confidential email");

      const events = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/events`);
      expect(events.status).toBe(200);
      expect(events.body[0].message).toBe("private@example.test");

      const linkedIssues = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/issues`);
      expect(linkedIssues.status).toBe(200);
      expect(linkedIssues.body[0]).toMatchObject({ issueId: fixture.issueId, title: "Confidential email triage" });
    }
  });

  it("filters private task links from a readable company run while preserving authorized links", async () => {
    const fixture = await seedFixture();
    const publicIssueId = randomUUID();
    await db.insert(issues).values({
      id: publicIssueId, companyId: fixture.companyId, identifier: "RPR-2",
      title: "Public follow-up", visibility: "open", status: "todo",
    });
    await db.insert(activityLog).values([fixture.issueId, publicIssueId].map(entityId => ({
      companyId: fixture.companyId, runId: fixture.maintenanceRunId,
      agentId: fixture.ownerAgentId, actorType: "agent", actorId: fixture.ownerAgentId,
      action: "issue.comment_added", entityType: "issue", entityId,
    })));

    const outsider = await request(createApp(fixture.companyId, fixture.otherAgentId))
      .get(`/api/heartbeat-runs/${fixture.maintenanceRunId}/issues`);
    expect(outsider.status).toBe(200);
    expect(outsider.body).toEqual([expect.objectContaining({ issueId: publicIssueId, title: "Public follow-up" })]);
    expect(JSON.stringify(outsider.body)).not.toContain(fixture.issueId);
    expect(JSON.stringify(outsider.body)).not.toContain("Confidential email triage");
    expect(JSON.stringify(outsider.body)).not.toContain("RPR-1");

    for (const agentId of [fixture.ownerAgentId, fixture.grantedAgentId]) {
      const response = await request(createApp(fixture.companyId, agentId))
        .get(`/api/heartbeat-runs/${fixture.maintenanceRunId}/issues`);
      expect(response.status).toBe(200);
      expect(response.body.map((row: { issueId: string }) => row.issueId).sort())
        .toEqual([fixture.issueId, publicIssueId].sort());
    }
  });

  it("filters credential diagnostics in full-run and history responses by viewer", async () => {
    const fixture = await seedFixture();
    const readerId = `reader-${randomUUID()}`;
    await db.insert(authUsers).values({ id: readerId, name: "Task reader", email: `${readerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: readerId, status: "active", membershipRole: "operator" });
    await db.update(issues).set({ visibility: "open", privacyRootIssueId: null }).where(eq(issues.id, fixture.issueId));
    const applicationId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: fixture.companyId, name: "AI fixture", type: "rest_api" });
    await db.insert(toolConnections).values({ id: connectionId, companyId: fixture.companyId, applicationId, name: "Owner's API key", uid: "credential-fixture", connectionPurpose: "ai", transport: "runtime_auth" });
    await db.insert(connectionGrants).values({ id: grantId, companyId: fixture.companyId, connectionId, kind: "user", subjectUserId: fixture.ownerUserId });
    await db.update(heartbeatRuns).set({ status: "failed", responsibleUserId: fixture.otherUserId,
      errorCode: "configuration_incomplete", error: "This credential is not shared with the responsible user",
      resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
        credentialAccess: { connectionName: "Owner's API key", grantId } } },
    }).where(eq(heartbeatRuns.id, fixture.privateRunId));
    for (const userId of [fixture.ownerUserId, fixture.otherUserId, readerId]) {
      const app = createBoardApp(fixture.companyId, userId);
      const detail = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}`);
      const history = await request(app).get(`/api/companies/${fixture.companyId}/heartbeat-runs`);
      expect(detail.status).toBe(200);
      expect(history.status).toBe(200);
      const expected = userId === readerId ? {} : { connectionName: "Owner's API key" };
      expect(detail.body.resultJson.configurationIncomplete.credentialAccess).toEqual(expected);
      expect(JSON.stringify(detail.body)).not.toContain(grantId);
      expect(JSON.stringify(history.body)).not.toContain(grantId);
      if (userId === readerId) expect(JSON.stringify(history.body)).not.toContain("Owner's API key");
    }
  });

  it("returns no linked issue metadata to a non-member", async () => {
    const fixture = await seedFixture();
    const response = await request(createApp(fixture.companyId, fixture.otherAgentId))
      .get(`/api/heartbeat-runs/${fixture.privateRunId}/issues`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("returns an actor-bound saved native Stop claim through the real run detail", async () => {
    const fixture = await seedFixture();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: fixture.issueId, resultJson: null })
      .where(eq(heartbeatRuns.id, fixture.privateRunId));
    await db.insert(nativeRunFinalizations).values({ runId: fixture.privateRunId, companyId: fixture.companyId,
      issueId: fixture.issueId, phase: "retryable_failure" });
    const requestId = randomUUID();
    await claimCancellationRequest(db, fixture.privateRunId, fixture.companyId, requestId, fixture.ownerUserId);
    const detail = await request(createBoardApp(fixture.companyId, fixture.ownerUserId)).get(`/api/heartbeat-runs/${fixture.privateRunId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.execution.canStop).toBe(true);
    expect(detail.body.resultJson.startupCancellation).toMatchObject({ cancellationRequestId: requestId,
      requestedBy: { type: "board", userId: fixture.ownerUserId } });
    expect(detail.body.resultJson.nativeCancellation).toBeUndefined();
    await expect(claimCancellationRequest(db, fixture.privateRunId, fixture.companyId, requestId, fixture.otherUserId))
      .rejects.toMatchObject({ status: 409 });
    await expect(claimCancellationRequest(db, fixture.privateRunId, fixture.companyId, requestId, fixture.ownerUserId))
      .resolves.toMatchObject({ status: "failed" });
  });

  it("rejects stale failed-native Stop correlation before cancellation activity is recorded", async () => {
    const fixture = await seedFixture();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: fixture.issueId,
      driverKind: "codex_app_server", resultJson: null,
    }).where(eq(heartbeatRuns.id, fixture.privateRunId));
    await db.insert(nativeRunFinalizations).values({ runId: fixture.privateRunId, companyId: fixture.companyId,
      issueId: fixture.issueId, phase: "retryable_failure" });
    const app = createBoardApp(fixture.companyId, fixture.ownerUserId);
    const detail = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.execution.canStop).toBe(true);
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "retry_authority_revoked" })
      .where(eq(nativeRunFinalizations.runId, fixture.privateRunId));
    const before = await db.select().from(activityLog).where(eq(activityLog.companyId, fixture.companyId));
    const unchanged = await request(app).post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`).send({});
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toMatchObject({ status: "failed", resultJson: null });
    const recorded = await db.select().from(activityLog).where(eq(activityLog.companyId, fixture.companyId));
    expect(recorded).toHaveLength(before.length + 1);
    expect(recorded.at(-1)?.action).toBe("heartbeat.cancelled");
    const denied = await request(app).post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`)
      .send({ cancellationRequestId: randomUUID() });
    expect(denied.status).toBe(409);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, fixture.companyId))).toEqual(recorded);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.privateRunId)))[0])
      .toMatchObject({ status: "failed", resultJson: null });
  });

  it("conceals private runs from unauthorized cancellation and watchdog mutations", async () => {
    const fixture = await seedFixture();

    const deniedCancel = await request(createBoardApp(fixture.companyId, fixture.otherUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`);
    expect(deniedCancel.status).toBe(404);

    const deniedWatchdog = await request(createApp(fixture.companyId, fixture.otherAgentId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/watchdog-decisions`)
      .send({ decision: "continue" });
    expect(deniedWatchdog.status).toBe(404);

    const allowedWatchdog = await request(createBoardApp(fixture.companyId, fixture.ownerUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/watchdog-decisions`)
      .send({ decision: "continue" });
    expect(allowedWatchdog.status).toBe(200);

    await db.update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, fixture.privateRunId));
    const allowedCancel = await request(createBoardApp(fixture.companyId, fixture.ownerUserId))
      .post(`/api/heartbeat-runs/${fixture.privateRunId}/cancel`);
    expect(allowedCancel.status).toBe(200);
    expect(allowedCancel.body.id).toBe(fixture.privateRunId);
  });

  it("keeps deleted-issue runs and operation history bound to a fail-closed tombstone", async () => {
    const fixture = await seedFixture();

    await db.delete(issues).where(eq(issues.id, fixture.issueId));

    const missingDetail = await request(createApp(fixture.companyId, fixture.ownerAgentId))
      .get(`/api/heartbeat-runs/${fixture.privateRunId}`);
    expect(missingDetail.status).toBe(404);

    const [tombstonedRun] = await db.select({
      scopeKind: heartbeatRuns.scopeKind,
      issueId: heartbeatRuns.issueId,
    })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, fixture.privateRunId));
    expect(tombstonedRun).toEqual({ scopeKind: "issue", issueId: null });

    const [operation] = await db.select({
      heartbeatRunId: workspaceOperations.heartbeatRunId,
      issueId: workspaceOperations.issueId,
    })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, fixture.operationId));
    expect(operation).toEqual({ heartbeatRunId: fixture.privateRunId, issueId: null });

    const missingOperationLog = await request(createApp(fixture.companyId, fixture.ownerAgentId))
      .get(`/api/workspace-operations/${fixture.operationId}/log`);
    expect(missingOperationLog.status).toBe(404);
  });

  it("logs would-deny decisions without enforcing them in shadow mode", async () => {
    const fixture = await seedFixture();
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "shadow";
    try {
      const response = await request(createApp(fixture.companyId, fixture.otherAgentId))
        .get(`/api/heartbeat-runs/${fixture.privateRunId}`);
      expect(response.status).toBe(200);
      expect(response.body.resultJson.summary).toBe("Read the confidential email");
    } finally {
      process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    }
  });
  it("batches distinct issue bindings without changing current authorization decisions", async () => {
    const fixture = await seedFixture();
    const ids = Array.from({ length: 64 }, () => randomUUID());
    await db.insert(issues).values(ids.map((id, index) => ({
      id, companyId: fixture.companyId, title: `History ${index}`, status: "in_progress",
      visibility: index % 2 ? "private" : "open", privacyRootIssueId: index % 2 ? id : null,
      assigneeAgentId: fixture.ownerAgentId, responsibleUserId: fixture.ownerUserId,
    })));
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as typeof db;
    const access = authorizationService(observedDb);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.grantedAgentId };
    const bindings = [...ids, fixture.issueId].map(issueId => ({ companyId: fixture.companyId, scopeKind: "issue" as const, issueId }));
    const runs = [...bindings, ...bindings, { ...bindings[0], companyId: randomUUID() },
      { ...bindings[0], issueId: randomUUID() }, { companyId: fixture.companyId, scopeKind: "company" as const },
      { companyId: fixture.companyId, scopeKind: "issue" as const }];
    const individual = await getHeartbeatRunReadDecisions(observedDb, { decide: access.decide }, actor, runs);
    const individualCount = queries.length;
    queries.length = 0;
    const batched = await getHeartbeatRunReadDecisions(observedDb, access, actor, runs);
    expect(batched).toEqual(individual);
    expect(batched.slice(0, 64)).toEqual(ids.map((_, index) => index % 2 === 0));
    expect(batched.at(64)).toBe(true);
    expect(batched.slice(-4)).toEqual([false, false, true, false]);
    expect(queries.length).toBeLessThan(25);
    expect(queries.length).toBeLessThan(individualCount / 4);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.subjectId, fixture.grantedAgentId));
    expect((await getHeartbeatRunReadDecisions(observedDb, access, actor, runs)).at(64)).toBe(false);
  });

  it.each(["enforce", "shadow", "off"])("keeps missing and foreign issue bindings closed in %s mode", async mode => {
    const fixture = await seedFixture();
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = mode;
    try {
      const access = authorizationService(db);
      const actor = { type: "board" as const, userId: fixture.ownerUserId };
      const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
      const runs = [binding, { ...binding, issueId: randomUUID() }, { ...binding, companyId: randomUUID() }];
      const expected = await getHeartbeatRunReadDecisions(db, { decide: access.decide }, actor, runs);
      expect(await getHeartbeatRunReadDecisions(db, access, actor, runs)).toEqual(expected);
      expect(expected).toEqual([true, false, false]);
      await db.delete(companyMemberships).where(eq(companyMemberships.principalId, fixture.ownerUserId));
      expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding])).toEqual(
        await getHeartbeatRunReadDecisions(db, { decide: access.decide }, actor, [binding]),
      );
    } finally { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; }
  });

  it("checks more than 500 task bindings with bounded company-scoped queries", async () => {
    const fixture = await seedFixture();
    const ids = Array.from({ length: 501 }, () => randomUUID());
    await db.insert(issues).values(ids.map((id, index) => ({
      id, companyId: fixture.companyId, title: `Batch ${index}`, visibility: "open", status: "in_progress",
    })));
    const queries: { query: string; params: unknown[] }[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query, params) { queries.push({ query, params }); } } }) as typeof db;
    const access = authorizationService(observedDb);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const runs = ids.map(issueId => ({ companyId: fixture.companyId, scopeKind: "issue" as const, issueId }));
    expect(await getHeartbeatRunReadDecisions(observedDb, access, actor, runs)).toEqual(ids.map(() => true));
    const existence = queries.filter(({ query }) => query.startsWith('select "id" from "issues"'));
    expect(existence.map(({ params }) => params.length).sort((a, b) => a - b)).toEqual([2, 501]);
    expect(existence.every(({ query, params }) => query.includes('"company_id"') && params[0] === fixture.companyId)).toBe(true);
  });

  it("captures batch inputs before awaiting reads and rejects a failed batch", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    const decideReads = vi.spyOn(access, "decideReads");
    const pending = getHeartbeatRunReadDecisions(db, access, actor, [binding, binding]);
    binding.issueId = randomUUID();
    expect(await pending).toEqual([true, true]);
    expect(decideReads).toHaveBeenCalledExactlyOnceWith(actor, [expect.objectContaining({ issueId: fixture.issueId })]);
    const error = new Error("authorization unavailable");
    decideReads.mockRejectedValueOnce(error);
    const current = { ...binding, issueId: fixture.issueId };
    await expect(getHeartbeatRunReadDecisions(db, access, actor, [current])).rejects.toBe(error);
    const transient = Object.assign(new Error("temporary disconnect"), { code: "CONNECTION_CLOSED" });
    decideReads.mockRejectedValueOnce(transient);
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [current])).toEqual([true]);
  });

  it("does no database or authorization work for company-only or empty batches", async () => {
    const fixture = await seedFixture();
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as typeof db;
    const access = authorizationService(observedDb);
    const decideReads = vi.spyOn(access, "decideReads");
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    expect(await getHeartbeatRunReadDecisions(observedDb, access, actor, [])).toEqual([]);
    expect(await getHeartbeatRunReadDecisions(observedDb, access, actor, [
      { companyId: fixture.companyId, scopeKind: "company" }, { companyId: fixture.companyId, scopeKind: "issue" },
    ])).toEqual([true, false]);
    expect(queries).toEqual([]);
    expect(decideReads).not.toHaveBeenCalled();
  });

  it.each(["owner", "outsider"])("checks concurrent duplicate issue runs once for the %s", async (viewer) => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const decide = vi.spyOn(access, "decide");
    const actor = {
      type: "agent" as const,
      companyId: fixture.companyId,
      agentId: viewer === "owner" ? fixture.ownerAgentId : fixture.otherAgentId,
    };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    const decisions = await getHeartbeatRunReadDecisions(db, { decide: access.decide }, actor, Array.from({ length: 200 }, () => ({ ...binding })));
    expect(decisions).toEqual(Array(200).fill(viewer === "owner"));
    expect(decide).toHaveBeenCalledTimes(1);
    decide.mockRestore();
  });

  it("keeps company scope, issue scope, and company identity separate", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding, { ...binding, companyId: randomUUID() }])).toEqual([true, false]);
    expect(await getHeartbeatRunReadDecisions(db, access, { ...actor, agentId: fixture.otherAgentId }, [
      { ...binding, scopeKind: "company" }, binding, { ...binding, scopeKind: null },
      { companyId: fixture.companyId, scopeKind: "issue" },
    ])).toEqual([true, false, false, false]);
  });

  it("uses the captured binding if a caller changes its input while checks are pending", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const decide = vi.spyOn(access, "decide");
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    const pending = getHeartbeatRunReadDecisions(db, { decide: access.decide }, actor, [binding, binding]);
    binding.issueId = randomUUID();
    expect(await pending).toEqual([true, true]);
    expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      resource: expect.objectContaining({ companyId: fixture.companyId, issueId: fixture.issueId }),
    }));
  });

  it("does not share decisions between actors", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding])).toEqual([true]);
    expect(await getHeartbeatRunReadDecisions(db, access, { ...actor, agentId: fixture.otherAgentId }, [binding])).toEqual([false]);
  });

  it("keeps event and operation authorization reads narrow for large runs", async () => {
    const fixture = await seedFixture();
    await db.update(heartbeatRuns).set({
      contextSnapshot: { issueId: fixture.issueId, prompt: "large-private-context".repeat(65_536) },
      runnerProfileJson: { instructions: "large-private-profile".repeat(65_536) },
    }).where(eq(heartbeatRuns.id, fixture.privateRunId));
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as typeof db;
    const app = createApp(fixture.companyId, fixture.grantedAgentId, observedDb);
    const response = await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/events`);
    expect(response.status).toBe(200);
    expect(response.body[0].message).toBe("private@example.test");
    expect(queries.some(query => query.startsWith('select "id", "company_id", "scope_kind", "issue_id" from "heartbeat_runs"'))).toBe(true);
    expect(queries.filter(query => query.startsWith("select ")).join("\n")).not.toMatch(/"runner_profile_json"|"stdout_excerpt"/);
    queries.length = 0;
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, fixture.operationId));
    expect(await canActorReadWorkspaceOperation(observedDb, authorizationService(observedDb), {
      type: "agent", companyId: fixture.companyId, agentId: fixture.grantedAgentId,
    }, operation)).toBe(true);
    expect(queries.some(query => query.startsWith('select "company_id", "scope_kind", "issue_id" from "heartbeat_runs"'))).toBe(true);
    expect(queries.filter(query => query.startsWith("select ")).join("\n")).not.toMatch(/"runner_profile_json"|"stdout_excerpt"/);
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.subjectId, fixture.grantedAgentId));
    expect((await request(app).get(`/api/heartbeat-runs/${fixture.privateRunId}/events`)).status).toBe(404);
  });

  it("rechecks a revoked grant on the next history request", async () => {
    const fixture = await seedFixture();
    const duplicateId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: duplicateId, companyId: fixture.companyId, agentId: fixture.ownerAgentId,
      scopeKind: "issue", issueId: fixture.issueId, invocationSource: "on_demand", status: "succeeded",
      resultJson: { summary: "PRIVATE_HISTORY_CANARY" },
    });
    const app = createApp(fixture.companyId, fixture.grantedAgentId);
    const path = `/api/companies/${fixture.companyId}/heartbeat-runs`;
    const permitted = await request(app).get(path);
    expect(permitted.status).toBe(200);
    expect(permitted.body.find((run: { id: string }) => run.id === duplicateId).resultJson.summary).toBe("PRIVATE_HISTORY_CANARY");
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.subjectId, fixture.grantedAgentId));
    for (const suffix of ["", "?summary=true"]) {
      const denied = await request(app).get(path + suffix);
      expect(denied.status).toBe(200);
      for (const id of [fixture.privateRunId, duplicateId]) {
        expect(denied.body.find((run: { id: string }) => run.id === id)).toMatchObject({ id, redacted: true });
      }
      expect(JSON.stringify(denied.body)).not.toContain("PRIVATE_HISTORY_CANARY");
      expect(JSON.stringify(denied.body)).not.toContain("private@example.test");
    }
  });

  it("fails closed when a shared decision rejects and can recover in a new request", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const error = new Error("authorization unavailable");
    const decide = vi.spyOn(access, "decide").mockRejectedValue(error);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    await expect(getHeartbeatRunReadDecisions(db, { decide: access.decide }, actor, Array(20).fill(binding))).rejects.toBe(error);
    expect(decide).toHaveBeenCalledTimes(1);
    decide.mockRestore();
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding])).toEqual([true]);
  });

  it("rejects an issue deleted before the next request", async () => {
    const fixture = await seedFixture();
    const access = authorizationService(db);
    const actor = { type: "agent" as const, companyId: fixture.companyId, agentId: fixture.ownerAgentId };
    const binding = { companyId: fixture.companyId, scopeKind: "issue" as const, issueId: fixture.issueId };
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding])).toEqual([true]);
    await db.delete(issues).where(eq(issues.id, fixture.issueId));
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [binding])).toEqual([false]);
  });

});
