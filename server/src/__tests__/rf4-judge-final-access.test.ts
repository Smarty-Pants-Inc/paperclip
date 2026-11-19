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
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
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

describeEmbeddedPostgres("private-task overlay rows through the real routes (access-overlay F1-F10)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const children: ChildProcess[] = [];
  const childRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ov-rows-");
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

  async function ownerInteraction(f: Seeded) {
    const created = await request(app(f.companyId, { kind: "user", userId: OWNER }))
      .post(`/api/issues/${f.issueId}/interactions`)
      .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Ship it?" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }


  function observation(name: string, data: unknown) {
    appendFileSync(`${process.env.TASK_OUT}/judge-observations.jsonl`, JSON.stringify({name, data}) + "\n");
  }

  it.each(["context/compact", "monitor/check-now", "runner-goal/actions"])("JUDGE residual F4 %s private matches missing before action", async path => {
    const f = await seed();
    const a = app(f.companyId, {kind: "user", userId: REVOKED});
    const body = path === "runner-goal/actions" ? {requestId: randomUUID(), agentId: f.agentId, expectedRevision: 0, action: "create", objective: "judge objective"} : {};
    const before = await snapshot(f);
    const privateResponse = await request(a).post(`/api/issues/${f.issueId}/${path}`).send(body);
    const missing = await request(a).post(`/api/issues/${randomUUID()}/${path}`).send(body);
    observation(`F4-${path}`, {privateStatus: privateResponse.status, privateBody: privateResponse.body, missingStatus: missing.status, missingBody: missing.body, before, after: await snapshot(f)});
    expectNotFound(privateResponse, f);
    expect(privateResponse.body).toEqual(missing.body);
    expect(await snapshot(f)).toEqual(before);
  });

  it("JUDGE residual F4 revoked board cannot checkout private task already assigned to target", async () => {
    const f = await seed();
    const a = app(f.companyId, {kind: "user", userId: REVOKED});
    const before = await snapshot(f);
    const response = await request(a).post(`/api/issues/${f.issueId}/checkout`).send({agentId:f.agentId, expectedStatuses:["in_progress"]});
    observation("F4-checkout", {status:response.status, body:response.body, before, after: await snapshot(f)});
    expectNotFound(response,f);
    expect(await snapshot(f)).toEqual(before);
  });

  it.each(["issueId-identifier", "taskId-identifier", "issueId-padded-uuid"])("JUDGE F4 wake canonical aliases %s cannot bypass private read", async alias => {
    const f=await seed();
    const a=app(f.companyId,{kind:"user",userId:REVOKED});
    const payload = alias === "issueId-identifier" ? {issueId:"OVP-1"} : alias === "taskId-identifier" ? {taskId:"OVP-1"} : {issueId:` ${f.issueId} `};
    const before=await snapshot(f);
    const response=await request(a).post(`/api/agents/${f.agentId}/wakeup`).send({source:"on_demand", triggerDetail:"manual", payload});
    observation(`F4-alias-${alias}`,{status:response.status, body:response.body,before,after:await snapshot(f)});
    expectNotFound(response,f);
    expect(await snapshot(f)).toEqual(before);
  });

  it("JUDGE residual F4 exact-run retry must authorize task before disclosing run eligibility",async()=>{
    const f=await seed();
    const a=app(f.companyId,{kind:"user",userId:REVOKED});
    const response=await request(a).post(`/api/agents/${f.agentId}/wakeup`).send({source:"on_demand",triggerDetail:"manual",reason:"retry_failed_run",failedRunId:f.runId});
    const missing=await request(a).post(`/api/agents/${f.agentId}/wakeup`).send({source:"on_demand",triggerDetail:"manual",reason:"retry_failed_run",failedRunId:randomUUID()});
    observation("F4-exact-run-retry-order",{status:response.status,body:response.body,missingStatus:missing.status,missingBody:missing.body});
    expect(response.status).toBe(404);
    expect(response.body).toEqual(missing.body);
  });

  it("JUDGE Q2 assigned agent checks out its private task using assignment, not explicit grant", async () => {
    const f=await seed();
    const a=app(f.companyId,{kind:"agent",agentId:f.agentId,runId:f.runId});
    const response=await request(a).post(`/api/issues/${f.issueId}/checkout`).send({agentId:f.agentId,expectedStatuses:["in_progress"]});
    observation("Q2-assigned-checkout",{status:response.status,body:response.body});
    expect(response.status,JSON.stringify(response.body)).toBe(200);
  });

  it.each(["issueId", "taskId", "taskKey"])("JUDGE Q2 assigned agent self wake carrying %s remains accepted",async key=>{
    const f=await seed();
    const a=app(f.companyId,{kind:"agent",agentId:f.agentId,runId:f.runId});
    const response=await request(a).post(`/api/agents/${f.agentId}/wakeup`).send({source:"on_demand",triggerDetail:"manual",payload:{[key]: key === "taskKey" ? "OVP-1" : f.issueId}});
    observation(`Q2-self-wake-${key}`,{status:response.status,body:response.body});
    expect(response.status,JSON.stringify(response.body)).toBe(202);
  });

  it.each(["provider-trace/reproject-workspace-diffs", "runtime-requests/judge-request/resolve"])("JUDGE residual F7 %s requires private task read before run details",async suffix=>{
    const f=await seed();
    const a=app(f.companyId,{kind:"user",userId:REVOKED});
    const response=await request(a).post(`/api/heartbeat-runs/${f.runId}/${suffix}`).send({});
    const missing=await request(a).post(`/api/heartbeat-runs/${randomUUID()}/${suffix}`).send({});
    observation(`F7-${suffix}`,{status:response.status,body:response.body,missingStatus:missing.status,missingBody:missing.body});
    expect(response.status).toBe(404);
    expect(response.body).toEqual(missing.body);
  });

  it("JUDGE F7 basic audit must not disclose hidden task existence through row metadata",async()=>{
    const f=await seed();
    await request(app(f.companyId,{kind:"user",userId:OWNER})).put(`/api/issues/${f.issueId}/title`).send({title:"JUDGE-PRIVATE-AUDIT-TITLE"}).expect(200);
    const a=app(f.companyId,{kind:"user",userId:REVOKED});
    const response=await request(a).get(`/api/companies/${f.companyId}/audit/agent-actions?actorScope=all`);
    observation("F7-basic-audit-existence",{status:response.status,body:response.body,privateIssueId:f.issueId});
    expect(response.status).toBe(200);
    expect(response.body.items.filter((item:any)=>item.entityId===f.issueId)).toEqual([]);
  });

  it("JUDGE Q2 assigned agent legacy invoke remains accepted",async()=>{
    const f=await seed();
    const a=app(f.companyId,{kind:"agent",agentId:f.agentId,runId:f.runId});
    const response=await request(a).post(`/api/agents/${f.agentId}/heartbeat/invoke`).send({source:"on_demand",triggerDetail:"manual",payload:{issueId:f.issueId}});
    observation("Q2-self-invoke",{status:response.status,body:response.body});
    expect(response.status,JSON.stringify(response.body)).toBe(202);
  });

  it("JUDGE Q2 explicit grant allows non-assigned company agent read",async()=>{
    const f=await seed();
    const owner=app(f.companyId,{kind:"user",userId:OWNER});
    await request(owner).post(`/api/issues/${f.issueId}/access-grants`).send({subjectType:"agent",subjectId:f.otherAgentId}).expect(201);
    const a=app(f.companyId,{kind:"agent",agentId:f.otherAgentId});
    const response=await request(a).get(`/api/issues/${f.issueId}/execution`);
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    await request(a).get(`/api/issues/${f.issueId}`).expect(200);
    // Requesting the assigned target agent would need lifecycle-manager authority;
    // the grant only supplies task privacy, so this read control does not conflate the two.
    observation("Q2-granted-agent-read",{status:response.status,body:response.body});
  });

  it.each(["local_trusted", "instance_admin"])("JUDGE Q2 %s board chat comment remains accepted on private task",async mode=>{
    const f=await seed();
    const a=app(f.companyId,{kind:"user",userId:mode === "local_trusted" ? "local-board" : ADMIN,
      local:mode === "local_trusted",instanceAdmin:mode === "instance_admin"});
    const response=await request(a).post(`/api/issues/${f.issueId}/comments`).send({body:"JUDGE-PRIVILEGED-BOARD-CHAT"});
    observation(`Q2-board-chat-${mode}`,{status:response.status,body:response.body});
    expect(response.status,JSON.stringify(response.body)).toBe(201);
  });

  it("JUDGE residual F9 revoked user must not write feedback vote on private comment",async()=>{
    const f=await seed();
    const comment=await request(app(f.companyId,{kind:"agent",agentId:f.agentId,runId:f.runId})).post(`/api/issues/${f.issueId}/comments`).send({body:"JUDGE-PRIVATE-FEEDBACK-COMMENT"});
    expect(comment.status).toBe(201);
    const a=app(f.companyId,{kind:"user",userId:REVOKED});
    const response=await request(a).post(`/api/issues/${f.issueId}/feedback-votes`).send({targetType:"issue_comment",targetId:comment.body.id,vote:"up"});
    const votes=await db.select().from(feedbackVotes).where(eq(feedbackVotes.issueId,f.issueId));
    observation("F9-feedback-vote",{status:response.status,body:response.body,votes});
    expectNotFound(response,f);
    expect(votes).toHaveLength(0);
  });
});
