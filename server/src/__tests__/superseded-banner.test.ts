import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// SMA-4 shape: after the sweep retires the false stranded card of a superseded
// automatic completion run, the real issue GET shows no failed attempt either.
// A real failure that carries a person's message keeps its banner and Retry,
// also when a superseded completion run lies on top of it.
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("superseded completion: no false failure banner on the real issue GET", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let hb: ReturnType<typeof heartbeatService>;
  const failing = new Set<string>();
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("superseded-banner-");
    db = createDb(temp.connectionString); hb = heartbeatService(db);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    registerServerAdapter({ type: "codex_local", supportsLocalAgentJwt: false,
      execute: async input => {
        const issueId = String(input.context.issueId);
        if (failing.has(issueId)) return { exitCode: 1, signal: null, timedOut: false, errorCode: "provider_policy_refusal",
          errorMessage: "PLANTED terminal provider policy refusal", executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, resultJson: {} };
        if (input.context.wakeReason !== "chat_task_completed")
          await issueService(db).addComment(issueId, "Reply to the person", { agentId: input.agent.id, runId: input.runId },
            { authorType: "agent", completionReply: true });
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      }, testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await hb?.drainActiveRunExecutions(); unregisterServerAdapter("codex_local");
    await db?.$client.end({ timeout: 1 }); await temp?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = `sb-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Person", email: `${userId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Banner", issuePrefix: `B${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", responsibleUserId: userId });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false }; next(); });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    return { companyId, agentId, issueId, client: app };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  async function send(f: F, body: string) {
    const r = await request(f.client).post(`/api/issues/${f.issueId}/comments`).send({ body, clientRequestId: randomUUID() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await hb.drainActiveRunExecutions(); await hb.resumeQueuedRuns(); await hb.drainActiveRunExecutions();
    return r.body.id as string;
  }
  async function runs(f: F) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => r.contextSnapshot?.issueId === f.issueId).sort((a, b) => +a.createdAt - +b.createdAt);
  }
  /** The historical (pre-9e501968) superseded completion run, beside a real reply, with its stranded card. */
  async function historicalSuperseded(f: F, error = "chat_completion_superseded") {
    await hb.wakeup(f.agentId, { source: "automation", triggerDetail: "system", reason: "chat_task_completed", allowRunCoalescing: false,
      requestedByActorType: "system", requestedByActorId: "chat_completion_delivery", payload: { issueId: f.issueId, chatCompletionDeliveryIds: [randomUUID()] },
      contextSnapshot: { issueId: f.issueId, wakeReason: "chat_task_completed", conversationSessionGeneration: -1, chatCompletionDeliveryIds: [randomUUID()] } });
    await hb.drainActiveRunExecutions();
    const run = (await runs(f)).filter(r => r.contextSnapshot?.wakeReason === "chat_task_completed").at(-1)!;
    // PLANTED: the exact pre-upgrade row 9a73d06a left (now a succeeded no-op).
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "setup_failed", error }).where(eq(heartbeatRuns.id, run.id));
    const [existing] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const [action] = existing ? [existing] : await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", ownerType: "board", status: "active", cause: "stranded_assigned_issue",
      fingerprint: `superseded:${run.id}`, nextAction: "Try again",
      evidence: { latestRunId: run.id, sourceRunId: null, latestRunStatus: "failed", latestRunErrorCode: "setup_failed" } }).returning();
    await hb.reconcileStrandedAssignedIssues({ companyId: f.companyId }); await hb.drainActiveRunExecutions();
    const [card] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    const issue = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body;
    return { run, card, interruption: issue.interruption ?? null };
  }

  it("SMA-4: answered person message + retired superseded card => no failure banner and no Retry on GET", async () => {
    const f = await fixture();
    await send(f, "Please do this");
    expect((await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).some(c => c.authorType === "agent")).toBe(true);
    const { card, interruption } = await historicalSuperseded(f);
    expect(card).toMatchObject({ status: "resolved", outcome: "false_positive" });
    expect(interruption?.state ?? "resolved").not.toBe("failed");
    expect(interruption?.canRetry ?? false).toBe(false);
  }, 120_000);

  it("CONTROL: a real failure carrying a person's message keeps its banner and Retry, even under a superseded run", async () => {
    const f = await fixture();
    failing.add(f.issueId);
    await send(f, "Please do this; the provider refuses");
    failing.delete(f.issueId);
    const personRun = (await runs(f)).find(r => r.status === "failed")!;
    expect(personRun, "the person-carrying run failed for real").toBeDefined();
    const before = (await request(f.client).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption;
    expect(before).toMatchObject({ state: "failed", canRetry: true, observedRunId: personRun.id });
    const { interruption } = await historicalSuperseded(f);
    expect(interruption).toMatchObject({ state: "failed", canRetry: true, observedRunId: personRun.id });
  }, 120_000);

  it("CONTROL: a setup failure whose text is more than the superseded marker is a real failure and keeps its banner", async () => {
    const f = await fixture();
    await send(f, "Please do this");
    const { run, card, interruption } = await historicalSuperseded(f, "chat_completion_superseded; then Workspace preparation failed");
    expect(card?.outcome ?? null).not.toBe("false_positive");
    expect(interruption).toMatchObject({ state: "failed", canRetry: true, observedRunId: run.id });
  }, 120_000);
});
