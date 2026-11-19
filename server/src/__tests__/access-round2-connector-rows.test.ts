import { appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  feedbackExports,
  feedbackVotes,
  heartbeatRuns,
  issueReadStates,
  issueThreadInteractions,
  issues,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatPublications,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// access-overlay (rf-4 F1-F10): the private-task overlay rides on every
// issue-scoped decision. A board user whose grant was REVOKED, a board user who
// was NEVER granted, and a company agent that was never granted (and is not the
// assignee) all get the missing-task 404 on every route below, before any
// effect. The owner, a still-granted user, the ASSIGNED agent, local_trusted
// board, an instance admin, any member on a non-private task and a scheduled
// (system) wake keep working.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OWNER = "ov-owner";
const REVOKED = "ov-revoked";
const GRANTED = "ov-granted";
const NEVER = "ov-never";
const ADMIN = "ov-instance-admin";
const DOC_TEXT = "OV-PRIVATE-DOCUMENT-BODY";
const NOT_FOUND = { error: "Issue not found" };

type Principal =
  | { kind: "user"; userId: string; instanceAdmin?: boolean; local?: boolean }
  | { kind: "agent"; agentId: string; runId?: string };

describeEmbeddedPostgres("access-round2 F5 connector rows through the real chat-channel routes (planted endpoint/conversation/publication/delivery/action)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const children: ChildProcess[] = [];
  const childRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-a2-chat-rows-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 60_000);

  afterEach(async () => {
    for (const id of childRunIds) runningProcesses.delete(id);
    for (const child of children) child.kill();
    children.length = 0;
    childRunIds.length = 0;
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, who: Principal) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = who.kind === "agent"
        ? { type: "agent", source: "agent_key", agentId: who.agentId, companyId, runId: who.runId ?? null }
        : {
            type: "board",
            source: who.local ? "local_implicit" : "session",
            userId: who.userId,
            companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "operator" }],
            isInstanceAdmin: who.instanceAdmin === true,
          };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use("/api", agentRoutes(db));
    testApp.use("/api", activityRoutes(db));
    testApp.use("/api", chatChannelRoutes(db, { heartbeat: { wakeup: async () => undefined } } as any));
    testApp.use(errorHandler);
    return testApp;
  }

  /** Company, users, assigned agent A, a never-granted agent N, a private task
   * (owner-created, assigned to A, live issue-bound run) and a non-private task.
   * Grants and the revoke go through the real access-grant routes. */
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const openIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: "Overlay company",
      issuePrefix: `O${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const users = [OWNER, REVOKED, GRANTED, NEVER, ADMIN];
    await db.insert(authUsers).values(users.map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values(users.map(principalId => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assigned Agent", role: "engineer", status: "idle",
        adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
      { id: otherAgentId, companyId, name: "Other Agent", role: "engineer", status: "idle",
        adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(companyMemberships).values([agentId, otherAgentId].map(principalId => ({
      companyId, principalType: "agent", principalId, status: "active", membershipRole: "operator",
    })));
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "overlay rows",
      status: "running", runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "OVP-1", title: "Private overlay task", status: "in_progress",
        priority: "medium", assigneeAgentId: agentId, executionRunId: runId, visibility: "private",
        privacyRootIssueId: issueId, responsibleUserId: OWNER, createdByUserId: OWNER },
      { id: openIssueId, companyId, identifier: "OVP-2", title: "Open overlay task", status: "todo",
        priority: "medium", assigneeAgentId: agentId, createdByUserId: OWNER },
    ]);
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    childRunIds.push(runId);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });

    const owner = app(companyId, { kind: "user", userId: OWNER });
    const grants: Record<string, string> = {};
    for (const subjectId of [REVOKED, GRANTED]) {
      const granted = await request(owner).post(`/api/issues/${issueId}/access-grants`).send({ subjectType: "user", subjectId });
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      grants[subjectId] = granted.body.id;
    }
    await request(app(companyId, { kind: "user", userId: REVOKED })).get(`/api/issues/${issueId}`).expect(200);
    const doc = await request(owner).put(`/api/issues/${issueId}/documents/plan`)
      .send({ title: "Private plan", body: DOC_TEXT, format: "markdown" });
    expect([200, 201], JSON.stringify(doc.body)).toContain(doc.status);
    const openDoc = await request(owner).put(`/api/issues/${openIssueId}/documents/plan`)
      .send({ title: "Open plan", body: "open body", format: "markdown" });
    expect([200, 201], JSON.stringify(openDoc.body)).toContain(openDoc.status);
    await request(owner).post(`/api/issues/${issueId}/access-grants/${grants[REVOKED]}/revoke`).send({}).expect(200);
    // The revoke is real; NEVER and agent N never had a grant.
    await request(app(companyId, { kind: "user", userId: REVOKED })).get(`/api/issues/${issueId}`).expect(404);
    await request(app(companyId, { kind: "user", userId: NEVER })).get(`/api/issues/${issueId}`).expect(404);
    await request(app(companyId, { kind: "agent", agentId: otherAgentId })).get(`/api/issues/${issueId}`).expect(404);
    return { companyId, agentId, otherAgentId, issueId, openIssueId, runId };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const DENIED = ["revoked", "never-granted", "non-granted-agent"] as const;
  function denied(f: Seeded, who: typeof DENIED[number]): Principal {
    if (who === "revoked") return { kind: "user", userId: REVOKED };
    if (who === "never-granted") return { kind: "user", userId: NEVER };
    return { kind: "agent", agentId: f.otherAgentId };
  }

  async function snapshot(f: Seeded) {
    const wakes = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)).orderBy(agentWakeupRequests.id);
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(heartbeatRuns.id);
    const activity = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const docs = await db.select({ id: documents.id, body: documents.latestBody, lockedAt: documents.lockedAt,
      lockedByUserId: documents.lockedByUserId, lockedByAgentId: documents.lockedByAgentId })
      .from(documents).where(eq(documents.companyId, f.companyId)).orderBy(documents.id);
    const reads = await db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.companyId, f.companyId));
    const interactions = await db.select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId)).orderBy(issueThreadInteractions.id);
    const issueRows = await db.select({ id: issues.id, title: issues.title, status: issues.status }).from(issues)
      .where(eq(issues.companyId, f.companyId)).orderBy(issues.id);
    return { wakes, runs, activity: activity.length, docs, reads: reads.length, interactions, issueRows };
  }

  function expectNotFound(response: request.Response, f: Seeded) {
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(DOC_TEXT);
    expect(text).not.toContain(f.runId);
  }

  async function expectDeniedNoEffect(f: Seeded, send: () => Promise<request.Response>, missing?: () => Promise<request.Response>,
    options: { boardOnlyBeforeLookup?: boolean } = {}) {
    const before = await snapshot(f);
    const response = await send();
    // A board-only route refuses an agent before it looks the task up: the same
    // 403 for a private and a missing task (no oracle), and no effect.
    if (options.boardOnlyBeforeLookup) expect(response.status, JSON.stringify(response.body)).toBe(403);
    else expectNotFound(response, f);
    expect(await snapshot(f)).toEqual(before);
    if (missing) {
      const absent = await missing();
      expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
    }
  }


  /** PLANTED (named): one Slack chat endpoint on a tool connection, a conversation
   * bound to the private task and one bound to the open task, a pending
   * publication and a failed delivery and a provider_effect action on the
   * private conversation. The users get tools:manage_connections so the route
   * reaches its record lookup (the gate under test), not the manager 403. */
  async function plant(f: Seeded) {
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection.id,
      provider: "slack", publicId: randomUUID(), assignedAgentId: f.agentId, status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id, issueId: f.issueId,
      externalConversationId: "C-PRIVATE", externalThreadId: "t-private", externalLabel: "#a2-private", state: "waiting" }).returning();
    const [openConversation] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id, issueId: f.openIssueId,
      externalConversationId: "C-OPEN", externalThreadId: "t-open", externalLabel: "#a2-open", state: "waiting" }).returning();
    const [publication] = await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: endpoint.id,
      conversationId: conversation.id, issueId: f.issueId, idempotencyKey: `a2-${randomUUID()}`, payload: { kind: "comment", body: "A2-PRIVATE-PUBLICATION" } as any,
      state: "pending" }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint.id, conversationId: conversation.id,
      providerEventId: `ev-${randomUUID()}`, deduplicationKey: `dk-${randomUUID()}`, eventKind: "message", normalizedEvent: { text: "A2-PRIVATE-DELIVERY" },
      state: "failed" }).returning();
    const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: endpoint.id, conversationId: conversation.id,
      deliveryId: delivery.id, kind: "provider_effect", providerActionId: `pa-${randomUUID()}`, status: "received" }).returning();
    await db.insert(principalPermissionGrants).values([OWNER, REVOKED, GRANTED, NEVER].map(principalId => ({
      companyId: f.companyId, principalType: "user", principalId, permissionKey: "tools:manage_connections" })));
    return { endpointId: endpoint.id, conversationId: conversation.id, openConversationId: openConversation.id,
      publicationId: publication.id, deliveryId: delivery.id, actionId: action.id };
  }
  type Planted = Awaited<ReturnType<typeof plant>>;

  async function chatState(f: Seeded) {
    const publications = await db.select({ id: chatPublications.id, state: chatPublications.state, attempts: chatPublications.attempts })
      .from(chatPublications).where(eq(chatPublications.companyId, f.companyId)).orderBy(chatPublications.id);
    const deliveries = await db.select({ id: chatDeliveries.id, state: chatDeliveries.state, attempts: chatDeliveries.attempts })
      .from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId)).orderBy(chatDeliveries.id);
    const actions = await db.select({ id: chatActions.id, status: chatActions.status })
      .from(chatActions).where(eq(chatActions.companyId, f.companyId)).orderBy(chatActions.id);
    return { publications, deliveries, actions, base: await snapshot(f) };
  }

  const ORDER = ["non-granted-agent", "revoked", "never-granted"] as const;
  type Route = { name: string; send: (a: express.Express, f: Seeded, p: Planted, missing: boolean) => request.Test; body404: unknown };
  const ROUTES: Route[] = [
    { name: "publication replay", body404: { error: "Publication not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/publications/${m ? randomUUID() : p.publicationId}/replay`).send({}) },
    { name: "publication resolve", body404: { error: "Publication not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/publications/${m ? randomUUID() : p.publicationId}/resolve`).send({ action: "cancel" }) },
    { name: "delivery replay", body404: { error: "Delivery not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/deliveries/${m ? randomUUID() : p.deliveryId}/replay`).send({}) },
    { name: "action resolve", body404: { error: "Provider action not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/actions/${m ? randomUUID() : p.actionId}/resolve`).send({ action: "cancel" }) },
    { name: "publish comment", body404: { error: "Conversation not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/conversations/${m ? randomUUID() : p.conversationId}/publications`).send({ commentId: randomUUID() }) },
    { name: "publish board message", body404: { error: "Conversation not found" },
      send: (a, _f, p, m) => request(a).post(`/api/chat-endpoints/${p.endpointId}/conversations/${m ? randomUUID() : p.conversationId}/publications`).send({ body: "A2 board send", idempotencyKey: "a2-board-send-key-0001" }) },
  ];

  for (const route of ROUTES) {
    it.each(ORDER)(`A2-2 F5 ${route.name} by %s: the private task's connector record looks missing, no effect`, async who => {
      const f = await seed();
      const p = await plant(f);
      const a = app(f.companyId, denied(f, who));
      const before = await chatState(f);
      const response = await route.send(a, f, p, false);
      const absent = await route.send(a, f, p, true);
      expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
      if (who === "non-granted-agent") expect([200, 201, 202, 204], JSON.stringify(response.body)).not.toContain(response.status);
      else {
        expect(response.status, JSON.stringify(response.body)).toBe(404);
        expect(response.body).toEqual(route.body404);
      }
      expect(JSON.stringify(response.body)).not.toContain("A2-PRIVATE");
      expect(await chatState(f)).toEqual(before);
    });
  }

  it.each(ORDER)("A2-2 F5 task chat-binding for %s: a private task has no binding, exactly as a missing task", async who => {
    const f = await seed();
    await plant(f);
    const a = app(f.companyId, denied(f, who));
    const response = await request(a).get(`/api/issues/${f.issueId}/chat-binding`);
    const absent = await request(a).get(`/api/issues/${randomUUID()}/chat-binding`);
    expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
    expect(JSON.stringify(response.body)).not.toContain("a2-private");
  });

  it.each(["revoked", "never-granted"] as const)("A2-2 F5 conversation list for %s omits the private task's conversation", async who => {
    const f = await seed();
    const p = await plant(f);
    const response = await request(app(f.companyId, denied(f, who))).get(`/api/chat-endpoints/${p.endpointId}/conversations`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.map((row: any) => row.id)).toEqual([p.openConversationId]);
    expect(JSON.stringify(response.body)).not.toContain(f.issueId);
  });

  it.each([OWNER, GRANTED])("A2-2 control: %s still lists both conversations, sees the binding, and reaches the connector records", async userId => {
    const f = await seed();
    const p = await plant(f);
    const a = app(f.companyId, { kind: "user", userId });
    const list = await request(a).get(`/api/chat-endpoints/${p.endpointId}/conversations`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((row: any) => row.id).sort()).toEqual([p.conversationId, p.openConversationId].sort());
    const binding = await request(a).get(`/api/issues/${f.issueId}/chat-binding`);
    expect(binding.status, JSON.stringify(binding.body)).toBe(200);
    expect(binding.body).not.toBeNull();
    // a pending publication is not replayable: the route's real 409, not a 404.
    const replay = await request(a).post(`/api/chat-endpoints/${p.endpointId}/publications/${p.publicationId}/replay`).send({});
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    const resolve = await request(a).post(`/api/chat-endpoints/${p.endpointId}/publications/${p.publicationId}/resolve`).send({ action: "cancel" });
    expect(resolve.status, JSON.stringify(resolve.body)).not.toBe(404);
  });
});
