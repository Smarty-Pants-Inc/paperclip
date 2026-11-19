import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agentApiKeys, agents, authUsers, chatCompletionDeliveries, chatTaskHandoffs, companyMemberships, heartbeatRuns, issueComments, issueThreadInteractions, issues, projects, userCompanyPreferences } from "@paperclipai/db";
import type { AgentApiKeyScope } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { sendAgentChatMessage } from "../services/agent-chat-messages.js";
import { initializePrimaryAgent } from "../services/primary-agent.js";
import { withConversationReadState } from "../services/agent-chat-read-state.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { activityService } from "../services/activity.js";
import { recordAcceptedChatHandoff } from "../services/chat-completion-delivery.js";
import { conversationReplay, deliverConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { CROSS_ISSUE_INFLUENCE_LIMIT } from "../services/cross-issue-influence-limit.js";
import { runnerBridgeDefinitions } from "../services/native-runtime/runner-bridge-tools.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import type { ChatMessageReceipt } from "../services/agent-chat-messages.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

(support.supported ? describe : describe.skip)("proactive agent chat messages", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer({ humanSessions: true });
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
  });
  // send_chat_message reaches the source task's persisted responsible person
  // (issues.responsibleUserId), which dispatch records on a real task.
  const withTaskPerson = async <F extends { issueId: string; responsibleUserId: string | null }>(f: F) => {
    await server.db.update(issues).set({ responsibleUserId: f.responsibleUserId }).where(eq(issues.id, f.issueId));
    return f;
  };
  const fixture = async () => withTaskPerson(await server.fixture({ connectionScenario: "fresh", apiToolsEnabled: false, disableWakeOnDemand: true }));
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const member = async (f: Fixture, name: string) => {
    const userId = randomUUID();
    await server.db.insert(authUsers).values({ id: userId, name, email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    return userId;
  };
  let taskNumber = 100;
  /** Another ordinary task of this agent, owned by `responsibleUserId`, with a running run executing for `executionUserId`. */
  const taskFor = async (f: Fixture, responsibleUserId: string, executionUserId: string) => {
    const issueId = randomUUID(), runId = randomUUID(), n = taskNumber++;
    await server.db.insert(issues).values({ id: issueId, companyId: f.companyId, projectId: f.projectId, issueNumber: n,
      identifier: "E" + f.companyId.replaceAll("-", "").slice(0, 8) + "-" + n, title: "Second person's task", status: "in_progress",
      workMode: "standard", assigneeAgentId: f.agentId, responsibleUserId });
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: executionUserId, contextSnapshot: { issueId } });
    await server.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { issueId, runId };
  };
  /**
   * The by-line cause: another person O comments on P's task; the next run's
   * execution identity is resolved by the real run-seed resolver (latest
   * wake comment author) and activated, while the task stays P's.
   */
  const wokenBy = async (f: Fixture, otherUserId: string) => {
    const wake = await issueService(server.db).addComment(f.issueId, "Please tell Paul where this stands.", { userId: otherUserId });
    const seeded = await createHeartbeatRunPreparation(server.db).resolveResponsibleUserIdForRunSeed({
      companyId: f.companyId, contextSnapshot: { issueId: f.issueId, wakeCommentId: wake.id },
      issueContext: { id: f.issueId, responsibleUserId: f.responsibleUserId, parentId: null },
      routineEnvContext: { routineId: null, env: null, responsibleUserId: null },
    });
    expect(seeded).toBe(otherUserId);
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: f.issueId, invocationSource: "on_demand", triggerDetail: "system",
      contextSnapshot: { issueId: f.issueId, wakeCommentId: wake.id, wakeCommentIds: [wake.id] } });
    await server.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    await initializeRunIdentity(server.db, { companyId: f.companyId, runId, issueId: f.issueId, responsibleUserId: seeded!, messageIds: [wake.id], cause: "instruction" });
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.responsibleUserId).toBe(otherUserId);
    expect((await issueService(server.db).getById(f.issueId))!.responsibleUserId).toBe(f.responsibleUserId);
    const authority = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, runId, apiUrl: server.apiUrl, apiToolsEnabled: false });
    return { runId, authority, wakeCommentId: wake.id, as: { ...f, runId, responsibleUserId: otherUserId } };
  };
  const chatsOf = async (f: Fixture) => (await server.db.select().from(issues).where(eq(issues.companyId, f.companyId)))
    .filter(issue => issue.conversationAgentId);
  const agentHttpComment = (f: { agentId: string; companyId: string; runId: string; responsibleUserId: string | null }, issueId: string, body: string) =>
    fetch(`${server.apiUrl}/api/issues/${issueId}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)}` },
      body: JSON.stringify({ body }),
    });
  const input = { body: "## Morning review\n\nThree PRs need your review.", idempotencyKey: "morning-pr-digest" };
  const send = (f: Fixture, value: unknown = input) => sendAgentChatMessage(server.db, f, value);
  const httpSend = (f: Fixture, value: unknown = input, keyScope: AgentApiKeyScope = { kind: "standard" }, authorizingUserId?: string) => fetch(`${server.apiUrl}/api/agents/me/chat/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId, keyScope, authorizingUserId)}` },
    body: JSON.stringify(value),
  });
  const apiKey = async (f: Fixture, scopeConfig: AgentApiKeyScope = { kind: "standard" }) => {
    const token = `pcp_${randomUUID()}`;
    const [key] = await server.db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, name: "Chat delivery test",
      responsibleUserId: f.responsibleUserId, scopeConfig, keyHash: createHash("sha256").update(token).digest("hex") }).returning();
    return { ...key, token };
  };
  const keySend = (f: Fixture, token: string, value: unknown = input) => fetch(`${server.apiUrl}/api/agents/me/chat/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-paperclip-run-id": f.runId },
    body: JSON.stringify(value),
  });
  const spendInfluence = (f: Fixture, count: number) => server.db.insert(activityLog).values(Array.from({ length: count }, (_, index) => ({
    companyId: f.companyId, actorType: "agent" as const, actorId: f.agentId, agentId: f.agentId, runId: f.runId,
    action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: f.issueId,
    details: { kind: ["comment", "update", "interaction_resolution"][index % 3] },
  })));

  it.each(["native", "http"])("enforces the shared run cap for %s delivery without creating an empty chat", async transport => {
    const f = await fixture();
    await spendInfluence(f, CROSS_ISSUE_INFLUENCE_LIMIT);
    if (transport === "native") {
      await expect(f.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
        .rejects.toMatchObject({ status: 429, details: { code: "cross_issue_influence_cap_exceeded", cap: CROSS_ISSUE_INFLUENCE_LIMIT } });
    } else {
      const response = await httpSend(f);
      expect(response.status, await response.clone().text()).toBe(429);
      expect(await response.json()).toMatchObject({ details: { code: "cross_issue_influence_cap_exceeded", cap: CROSS_ISSUE_INFLUENCE_LIMIT } });
    }
    const snapshot = await f.snapshot();
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect(snapshot.activity).toHaveLength(CROSS_ISSUE_INFLUENCE_LIMIT);
  });

  it("charges a committed message once across retries, recovery and conflicting content", async () => {
    const f = await fixture(), receipt = (await send(f))!;
    expect((await httpSend(f)).status).toBe(200);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
      .toMatchObject({ result: { commentId: receipt.commentId, replayed: true } });
    expect((await httpSend(f, { ...input, body: "Different content" })).status).toBe(409);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: { ...input, idempotencyKey: "not-committed" }, callId: randomUUID() })).toBeNull();
    expect((await f.snapshot()).activity.filter(row => row.action === "issue.cross_issue_influence_observed")).toHaveLength(1);
    expect((await f.snapshot()).comments).toHaveLength(1);
  });

  it("cannot race native and HTTP delivery past the shared final slot", async () => {
    const f = await fixture();
    await spendInfluence(f, CROSS_ISSUE_INFLUENCE_LIMIT - 1);
    const outcomes = await Promise.all([
      f.authority.execute({ tool: "send_chat_message", arguments: { ...input, idempotencyKey: "native-last-slot" }, callId: randomUUID() })
        .then(() => 201, error => error.status),
      httpSend(f, { ...input, idempotencyKey: "http-last-slot" }).then(response => response.status),
    ]);
    expect(outcomes.sort()).toEqual([201, 429]);
    const snapshot = await f.snapshot();
    expect(snapshot.activity.filter(row => row.action === "issue.cross_issue_influence_observed")).toHaveLength(CROSS_ISSUE_INFLUENCE_LIMIT);
    expect(snapshot.comments).toHaveLength(1);
    expect(snapshot.issues.filter(issue => issue.conversationAgentId)).toHaveLength(1);
  });

  it("supports standard task API keys without changing agent and run attribution", async () => {
    const f = await fixture(), key = await apiKey(f);
    const response = await keySend(f, key.token);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await f.snapshot()).activity).toContainEqual(expect.objectContaining({ action: "issue.comment_added",
      actorId: f.agentId, agentId: f.agentId, runId: f.runId, responsibleUserId: f.responsibleUserId }));
  });

  it("preserves an external authorizer's current access intersection", async () => {
    const f = await fixture();
    expect((await httpSend(f, input, { kind: "standard" }, randomUUID())).status).toBe(403);
    await expect(sendAgentChatMessage(server.db, { ...f, authorizingUserId: randomUUID() }, input)).rejects.toMatchObject({ status: 403 });
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it("keeps skill-test JWT and API-key scopes confined to their own task", async () => {
    const f = await fixture(), scope = { kind: "skill_test", issueId: f.issueId } as const;
    const key = await apiKey(f, scope);
    expect((await httpSend(f, input, scope)).status).toBe(403);
    expect((await keySend(f, key.token)).status).toBe(403);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it.each(["admitted", "legacy", "saved-task"])("retains a persisted %s skill-test run boundary after task mode changes", async kind => {
    const f = await fixture();
    const contextSnapshot = kind === "admitted" ? { paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId } }
      : kind === "legacy" ? { paperclipSkillTest: { id: randomUUID() } }
      : { paperclipIssue: { id: f.issueId, workMode: "skill_test" } };
    await server.db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(issues).set({ workMode: "skill_test" }).where(eq(issues.id, f.issueId));
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, f.issueId));
    expect((await httpSend(f)).status).toBe(403);
    await expect(sendAgentChatMessage(server.db, f, input, { receiptOnly: true })).rejects.toThrow(/skill.test/i);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
    expect((await f.snapshot()).comments).toEqual([]);
  });

  it("does not let task-bridge credentials publish outside their admitted task", async () => {
    const f = await fixture(), key = await apiKey(f, { kind: "task_bridge", parentIssueId: f.issueId });
    expect((await keySend(f, key.token)).status).toBe(403);
    expect((await f.snapshot()).issues.filter(issue => issue.conversationAgentId)).toEqual([]);
  });

  it.each(["revoked", "narrowed", "responsible-human"])("rechecks a %s API key after waiting for the destination", async kind => {
    const f = await fixture(), receipt = (await send(f))!, key = await apiKey(f);
    let unlock!: () => void, ready!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const gate = server.db.transaction(async tx => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, receipt.conversationId)).for("update");
      ready(pid); await release;
    });
    const pid = await locked;
    const delivery = keySend(f, key.token, { ...input, idempotencyKey: "key-after-wait" });
    try {
      await vi.waitFor(async () => {
        const [row] = await server.db.execute(sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`);
        expect(row.blocked).toBe(true);
      }, { timeout: 5_000, interval: 10 });
      await server.db.update(agentApiKeys).set(kind === "revoked" ? { revokedAt: new Date() }
        : kind === "narrowed" ? { scopeConfig: { kind: "skill_test", issueId: f.issueId } }
        : { responsibleUserId: randomUUID() }).where(eq(agentApiKeys.id, key.id));
      unlock(); await gate;
      expect((await delivery).status).toBe(403);
      expect((await f.snapshot()).comments).toHaveLength(1);
    } finally { unlock(); await gate; await delivery; }
  }, 30_000);

  it("publishes through the native tool without generic API tools, without starting a turn or changing the source", async () => {
    const f = await fixture();
    expect(f.authority.definitions().map(d => d.name)).toContain("send_chat_message");
    const before = await issueService(server.db).getById(f.issueId);
    const receipt = await f.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }) as { commentId: string; conversationId: string; chatUrl: string };
    const snapshot = await f.snapshot();
    const comment = snapshot.comments.find(c => c.id === receipt.commentId)!;
    expect(comment).toMatchObject({ body: input.body, authorAgentId: f.agentId, createdByRunId: f.runId, onBehalfOfUserId: f.responsibleUserId,
      metadata: { chatMessage: { sourceTaskId: f.issueId, sourceRunId: f.runId } } });
    expect(snapshot.issues.find(i => i.id === receipt.conversationId)).toMatchObject({ conversationAgentId: f.agentId,
      conversationUserId: f.responsibleUserId, conversationState: "waiting", executionRunId: null, status: "in_review" });
    expect(await issueService(server.db).getById(f.issueId)).toEqual(before);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(snapshot.activity.filter(a => a.action === "issue.comment_added")).toHaveLength(1);
    expect(await activityService(server.db).runsForIssue(f.companyId, receipt.conversationId)).toEqual([]);
    expect(receipt.chatUrl).toContain(`/chats/${f.agentId}`);
    expect(await withConversationReadState(server.db, f.companyId, f.responsibleUserId!, [{ id: receipt.conversationId }])).toMatchObject([{ isUnreadForMe: true }]);
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
      .toMatchObject({ result: { commentId: receipt.commentId, replayed: true } });
  });

  it("creates once under concurrent first sends and recovers a committed response across run retries", async () => {
    const f = await fixture();
    expect(await f.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() })).toBeNull();
    expect((await f.snapshot()).issues.filter(i => i.conversationAgentId)).toHaveLength(0);
    const [a, b] = await Promise.all([send(f), send(f)]);
    expect(a!.commentId).toBe(b!.commentId);
    expect((await f.snapshot()).comments).toHaveLength(1);
    const other = await send(f, { ...input, idempotencyKey: "second" });
    expect(other!.commentId).not.toBe(a!.commentId);
    await expect(send(f, { ...input, body: "Different digest" })).rejects.toThrow(/different content/);
    const nextRunId = randomUUID();
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId,
      status: "running", nativeIssueId: f.issueId, responsibleUserId: f.responsibleUserId });
    await server.db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, f.issueId));
    expect(await send({ ...f, runId: nextRunId })).toMatchObject({ commentId: a!.commentId, replayed: true });
    expect((await f.snapshot()).comments).toHaveLength(2);
  });

  it("supports HTTP routine delivery during an active chat reply and after a context reset", async () => {
    const f = await fixture();
    await server.db.update(heartbeatRuns).set({ invocationSource: "automation", triggerDetail: "routine" }).where(eq(heartbeatRuns.id, f.runId));
    const first = await httpSend(f);
    expect(first.status, await first.clone().text()).toBe(201);
    const receipt = await first.json();
    const replyRun = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: replyRun, companyId: f.companyId, agentId: f.agentId, status: "running",
      nativeIssueId: receipt.conversationId, responsibleUserId: f.responsibleUserId, contextSnapshot: { issueId: receipt.conversationId, conversationSessionGeneration: 0 } });
    await server.db.update(issues).set({ executionRunId: replyRun, conversationState: "active" }).where(eq(issues.id, receipt.conversationId));
    const before = await issueService(server.db).getById(receipt.conversationId);
    expect((await httpSend(f, { ...input, idempotencyKey: "during-reply" })).status).toBe(201);
    const after = await issueService(server.db).getById(receipt.conversationId);
    expect(after).toMatchObject({ executionRunId: replyRun, conversationState: before!.conversationState, status: before!.status });
    await server.db.update(issues).set({ conversationSessionGeneration: 1, conversationState: "waiting", executionRunId: null }).where(eq(issues.id, receipt.conversationId));
    expect((await httpSend(f, { ...input, idempotencyKey: "after-new" })).status).toBe(201);
    await expect(issueService(server.db).addComment(receipt.conversationId, "Stale reply", { agentId: f.agentId, runId: replyRun })).rejects.toThrow(/earlier session/);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect((await f.snapshot()).comments).toHaveLength(3);
  });

  it("never enqueues a digest during recovery or the next human reply", async () => {
    const f = await fixture(), svc = issueService(server.db);
    const receipt = (await send(f))!;
    const conversation = (await svc.getById(receipt.conversationId))!;
    const enqueue = vi.fn(async (_agentId: string, _options: unknown) => null);
    expect(await undeliveredConversationComments(server.db, f.companyId, conversation.id)).toEqual([]);
    await deliverConversationComments(server.db, conversation, enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    const reply = await svc.addComment(conversation.id, "Which PR should I review first?", { userId: f.responsibleUserId! }, { clientRequestId: randomUUID() });
    expect((await undeliveredConversationComments(server.db, f.companyId, conversation.id)).map(comment => comment.id)).toEqual([reply.id]);
    await deliverConversationComments(server.db, conversation, enqueue);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ requestedByActorType: "user", requestedByActorId: f.responsibleUserId,
      contextSnapshot: { wakeCommentId: reply.id, wakeCommentIds: [reply.id] } });
    expect(await conversationReplay(server.db, f.companyId, conversation.id, reply.id))
      .toContain(JSON.stringify({ author: "agent", body: input.body }));
  });

  it.each([
    { transport: "native", replay: false }, { transport: "native", replay: true },
    { transport: "http", replay: false }, { transport: "http", replay: true },
  ])("serializes $transport delivery with a native chat mutation, replay=$replay", async ({ transport, replay }) => {
    const f = await fixture(), receipt = (await send(f))!, chatRunId = randomUUID();
    await server.db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 2 } } }).where(eq(agents.id, f.agentId));
    await server.db.insert(heartbeatRuns).values({ id: chatRunId, companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: receipt.conversationId, responsibleUserId: f.responsibleUserId,
      contextSnapshot: { issueId: receipt.conversationId, conversationSessionGeneration: 0 } });
    await server.db.update(issues).set({ executionRunId: chatRunId, conversationState: "active" }).where(eq(issues.id, receipt.conversationId));
    const chat = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: receipt.conversationId, runId: chatRunId, apiUrl: server.apiUrl, apiToolsEnabled: false });
    let unlock!: () => void, ready!: (pid: number) => void;
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const gate = server.db.transaction(async tx => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.agentId)).for("update");
      ready(pid);
      await release;
    });
    const pid = await locked;
    const waitForBlocked = async (count: number) => vi.waitFor(async () => {
      const [row] = await server.db.execute(sql<{ count: number }>`with recursive blocked(pid) as (
        select pid from pg_stat_activity where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))
        union select activity.pid from pg_stat_activity activity join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
        where activity.datname = current_database()
      ) select count(*)::int as count from blocked`);
      expect(row.count).toBeGreaterThanOrEqual(count);
    }, { timeout: 5000, interval: 10 });
    const message = replay ? input : { ...input, idempotencyKey: "concurrent-message" };
    let settled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let observedDelivery: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const delivery = transport === "native"
        ? f.authority.execute({ tool: "send_chat_message", arguments: message, callId: randomUUID() })
        : httpSend(f, message).then(async response => {
          expect(response.status, await response.clone().text()).toBe(replay ? 200 : 201);
          return response.json();
        });
      observedDelivery = Promise.allSettled([delivery]);
      await waitForBlocked(1);
      const mutation = chat.execute({ tool: "write_document", callId: randomUUID(), arguments: {
        key: "concurrent-note", title: "Concurrent note", body: "The chat reply stays independent.", baseRevisionId: null, idempotencyKey: "concurrent-note",
      } });
      settled = Promise.allSettled([delivery, mutation]);
      await waitForBlocked(2);
      unlock();
      await gate;
      const results = await settled;
      expect(results.map(result => result.status), JSON.stringify(results)).toEqual(["fulfilled", "fulfilled"]);
      expect(results[1]).toMatchObject({ status: "fulfilled", value: { disposition: "applied", document: { key: "concurrent-note" } } });
      expect(await issueService(server.db).getById(receipt.conversationId)).toMatchObject({ conversationState: "active" });
    } finally {
      unlock();
      await gate;
      await settled;
      await observedDelivery;
    }
  }, 30_000);

  it("isolates two humans sharing an agent and two agents serving one human", async () => {
    const f = await fixture();
    const a = await send(f);
    const userId = await member(f, "Second human");
    // The second human's own task. Its run executes for the first human, but
    // the recipient is each task's responsible person, not the run identity.
    const second = await taskFor(f, userId, f.responsibleUserId!);
    const b = await send({ ...f, issueId: second.issueId, runId: second.runId });
    expect(b!.conversationId).not.toBe(a!.conversationId);
    const conversationUser = async (id: string) => (await issueService(server.db).getById(id))!.conversationUserId;
    expect(await conversationUser(a!.conversationId)).toBe(f.responsibleUserId);
    expect(await conversationUser(b!.conversationId)).toBe(userId);
    const [agent] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Second agent", status: "active", adapterType: "process" }).returning();
    const runId = randomUUID();
    await server.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent.id, status: "running", issueId: f.issueId, responsibleUserId: userId });
    await server.db.update(issues).set({ assigneeAgentId: agent.id, executionRunId: runId }).where(eq(issues.id, f.issueId));
    const c = await send({ ...f, agentId: agent.id, runId });
    expect(new Set([a!.conversationId, b!.conversationId, c!.conversationId]).size).toBe(3);
    expect(await conversationUser(c!.conversationId)).toBe(f.responsibleUserId);
    await expect(issueService(server.db).addComment(a!.conversationId, "Wrong agent", { agentId: agent.id, runId })).rejects.toThrow(/Only this conversation/);
    await expect(issueService(server.db).addComment(b!.conversationId, "Bypass", { agentId: f.agentId, runId: f.runId })).rejects.toThrow(/belongs to another task/);
  });

  it("delivers to its own chat while preserving pending questions and the original handoff completion", async () => {
    const f = await fixture(), svc = issueService(server.db);
    const own = await svc.create(f.companyId, { title: "Own chat", assigneeAgentId: f.agentId,
      conversationAgentId: f.agentId, conversationUserId: f.responsibleUserId!, conversationState: "waiting", status: "in_review" });
    const [coordinator] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Coordinator", status: "active", adapterType: "process" }).returning();
    const origin = await svc.create(f.companyId, { title: "Origin chat", assigneeAgentId: coordinator.id,
      conversationAgentId: coordinator.id, conversationUserId: f.responsibleUserId!, conversationState: "waiting", status: "in_review" });
    await recordAcceptedChatHandoff(server.db, (await svc.getById(f.issueId))!, origin);
    const [question] = await server.db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: own.id,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Proceed?" } }).returning();
    expect(await send(f)).toMatchObject({ conversationId: own.id });
    expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, origin.id))).toEqual([]);
    expect(await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, question.id))).toEqual([question]);
    expect(await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    await svc.update(f.issueId, { status: "done" });
    expect(await server.db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.taskId, f.issueId)))
      .toMatchObject([{ status: "pending", responseCommentId: null }]);
    expect(await server.db.select().from(chatTaskHandoffs).where(eq(chatTaskHandoffs.taskId, f.issueId)))
      .toMatchObject([{ conversationId: origin.id, agentId: coordinator.id }]);
  });

  it.each(["ask", "planning", "review", "watchdog", "stopped", "stale", "missing-human", "revoked", "private-task", "private-project", "private-ancestor", "paused-agent", "missing-task-person"])("rejects %s before creating a chat", async kind => {
    const f = await fixture();
    if (kind === "ask" || kind === "planning") await server.db.update(issues).set({ workMode: kind }).where(eq(issues.id, f.issueId));
    if (kind === "review") await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "watchdog") await server.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, taskWatchdog: true, watchedIssueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "stopped") await server.db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "stale") await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    if (kind === "missing-human") await server.db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "revoked") await server.db.delete(companyMemberships).where(eq(companyMemberships.principalId, f.responsibleUserId!));
    if (kind === "private-task") await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.issueId));
    if (kind === "private-project") await server.db.update(projects).set({ visibility: "private", privacyOwnerUserId: f.responsibleUserId }).where(eq(projects.id, f.projectId));
    if (kind === "private-ancestor") {
      await server.db.update(issues).set({ visibility: "private" }).where(eq(issues.id, f.blockerId));
      await server.db.update(issues).set({ parentId: f.blockerId, privacyParentIssueId: f.blockerId, privacyRootIssueId: f.blockerId }).where(eq(issues.id, f.issueId));
    }
    if (kind === "paused-agent") await server.db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (kind === "missing-task-person") await server.db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, f.issueId));
    await expect(send(f)).rejects.toThrow();
    expect((await f.snapshot()).comments).toHaveLength(0);
    expect((await f.snapshot()).issues.filter(i => i.conversationAgentId)).toHaveLength(0);
  });

  it("rejects forged destinations and server-owned provenance while ignoring the retired flag", async () => {
    const f = await fixture();
    expect((await httpSend(f, { ...input, agentId: f.agentId })).status).toBe(400);
    await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: false });
    try { expect((await httpSend(f)).status).toBe(201); }
    finally { await instanceSettingsService(server.db).updateExperimental({ enableAgentChat: true }); }
    const receipt = await send(f);
    const [comment] = await server.db.select().from(issueComments).where(eq(issueComments.id, receipt!.commentId));
    await expect(issueService(server.db).addComment(f.issueId, "Forged source", { agentId: f.agentId, runId: f.runId }, { metadata: comment.metadata! })).rejects.toThrow(/server-owned/);
  });

  it("keeps unseen concurrent arrivals unread with exact comment cutoffs and monotonic receipts", async () => {
    const f = await fixture();
    const a = (await send(f))!, b = (await send(f, { ...input, idempotencyKey: "later" }))!;
    await server.db.update(issueComments).set({ createdAt: sql`'2026-10-30 12:00:00.123456+00'::timestamptz` }).where(eq(issueComments.id, a.commentId));
    await server.db.update(issueComments).set({ createdAt: sql`'2026-10-30 12:00:00.123789+00'::timestamptz` }).where(eq(issueComments.id, b.commentId));
    const cookie = await server.humanSession(f.responsibleUserId!);
    await server.db.insert(issueComments).values([
      { companyId: f.companyId, issueId: a.conversationId, authorUserId: f.responsibleUserId, authorType: "user", body: "Human message" },
      { companyId: f.companyId, issueId: a.conversationId, authorAgentId: f.agentId, authorType: "system", body: "System message" },
      { companyId: f.companyId, issueId: a.conversationId, authorAgentId: f.agentId, body: "Deleted message", deletedAt: new Date() },
      { companyId: f.companyId, issueId: a.conversationId, authorAgentId: f.agentId, body: "Receipt", origin: "fast_response" },
      { companyId: f.companyId, issueId: a.conversationId, authorAgentId: f.agentId, body: "Notice", presentation: { kind: "system_notice", tone: "neutral", detailsDefaultOpen: false } },
    ]);
    const mark = (id: string) => fetch(`${server.apiUrl}/api/issues/${a.conversationId}/read`, { method: "POST", headers: { Cookie: cookie, Origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ throughCommentId: id }) });
    const unread = async () => (await withConversationReadState(server.db, f.companyId, f.responsibleUserId!, [{ id: a.conversationId }]))[0];
    expect(await unread()).toMatchObject({ isUnreadForMe: true, unreadMessageCount: 2 });
    const response = await mark(a.commentId);
    expect(response.status, await response.text()).toBe(200);
    expect(await unread()).toMatchObject({ isUnreadForMe: true, unreadMessageCount: 1 });
    expect((await mark(b.commentId)).status).toBe(200);
    expect(await unread()).toMatchObject({ isUnreadForMe: false, unreadMessageCount: 0 });
    expect(await withConversationReadState(server.db, f.companyId, randomUUID(), [{ id: a.conversationId }, { id: f.issueId }]))
      .toMatchObject([{ unreadMessageCount: 2, isUnreadForMe: true }, { unreadMessageCount: 0, isUnreadForMe: false }]);
    expect(await withConversationReadState(server.db, randomUUID(), f.responsibleUserId!, [{ id: a.conversationId }]))
      .toMatchObject([{ unreadMessageCount: 0, isUnreadForMe: false }]);
    await mark(a.commentId);
    expect(await unread()).toMatchObject({ isUnreadForMe: false, unreadMessageCount: 0 });
    const foreign = await withTaskPerson(await server.fixture({ connectionScenario: "fresh" }));
    const foreignMessage = (await send(foreign))!;
    expect((await mark(foreignMessage.commentId)).status).toBe(404);
    const chats = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/chats`, { headers: { Cookie: cookie } });
    expect(chats.status).toBe(200);
    expect(await chats.json()).toMatchObject([{ id: a.conversationId, isUnreadForMe: false, unreadMessageCount: 0 }]);
    const detail = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/chats/${f.agentId}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: a.conversationId, unreadMessageCount: 0 });
  });

  describe("explicit principal recipient on fleet-created tasks", () => {
    const fleetFixture = async (principal = true) => {
      const original = await fixture(), paul = original.responsibleUserId!, ops = await member(original, "Fleet ops");
      if (principal) await initializePrimaryAgent(server.db, original.companyId, paul, original.agentId);
      const task = await taskFor(original, ops, ops);
      await server.db.update(issues).set({ createdByAgentId: original.agentId, createdByUserId: null }).where(eq(issues.id, task.issueId));
      await initializeRunIdentity(server.db, { companyId: original.companyId, runId: task.runId, issueId: task.issueId,
        responsibleUserId: ops, cause: "instruction" });
      const authority = new PaperclipRunnerToolAuthority(server.db, { companyId: original.companyId, agentId: original.agentId,
        issueId: task.issueId, runId: task.runId, apiUrl: server.apiUrl, apiToolsEnabled: false });
      return { ...original, ...task, authority, responsibleUserId: ops, paul, ops };
    };
    const principalInput = { ...input, recipient: "my_principal" };
    const deliver = async (transport: string, f: Fixture, value: unknown): Promise<ChatMessageReceipt> => {
      if (transport === "native") return f.authority.execute({ tool: "send_chat_message", arguments: value as Record<string, unknown>, callId: randomUUID() }) as Promise<ChatMessageReceipt>;
      if (transport === "service") return (await send(f, value))!;
      const response = await httpSend(f, value);
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json();
    };

    it.each(["native", "http", "service"])("a/e: %s deliberately reaches Paul's own chat once, keeping ops attribution", async transport => {
      const f = await fleetFixture();
      const paulChat = await issueService(server.db).create(f.companyId, { title: "Paul's own chat", assigneeAgentId: f.agentId,
        conversationAgentId: f.agentId, conversationUserId: f.paul, conversationState: "waiting", status: "in_review" });
      const receipt = await deliver(transport, f, principalInput);
      expect(receipt).toMatchObject({ conversationId: paulChat.id, replayed: false, sourceTaskId: f.issueId });
      const retry = await httpSend(f, principalInput);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ commentId: receipt.commentId, conversationId: paulChat.id, replayed: true });
      expect(await f.authority.recover({ tool: "send_chat_message", arguments: principalInput, callId: randomUUID() }))
        .toMatchObject({ result: { commentId: receipt.commentId, replayed: true } });
      expect((await chatsOf(f)).map(chat => chat.conversationUserId)).toEqual([f.paul]);
      const comments = await server.db.select().from(issueComments).where(eq(issueComments.issueId, paulChat.id));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ authorAgentId: f.agentId, createdByRunId: f.runId, onBehalfOfUserId: f.ops, body: input.body });
      expect(await issueService(server.db).getById(f.issueId)).toMatchObject({ responsibleUserId: f.ops, createdByAgentId: f.agentId });
      // Real human chat reads select by the logged-in person, not by run identity.
      for (const userId of transport === "native" ? [f.paul, f.ops] : []) {
        const cookie = await server.humanSession(userId);
        const response = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/chats`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        const chats = await response.json() as { id: string }[];
        expect(chats.map(chat => chat.id)).toEqual(userId === f.paul ? [paulChat.id] : []);
      }
    });

    it.each(["native", "http", "service"])("b: %s without a choice still reaches ops, not the principal", async transport => {
      const f = await fleetFixture();
      const receipt = await deliver(transport, f, input);
      expect((await issueService(server.db).getById(receipt.conversationId))!.conversationUserId).toBe(f.ops);
      expect((await chatsOf(f)).map(chat => chat.conversationUserId)).toEqual([f.ops]);
      expect(await send(f, { ...input, recipient: "task_person" })).toMatchObject({ commentId: receipt.commentId, replayed: true });
    });

    it("a/e: concurrently creates the principal chat once when no chat exists", async () => {
      const f = await fleetFixture();
      const [a, b] = await Promise.all([send(f, principalInput), send(f, principalInput)]);
      expect(a!.commentId).toBe(b!.commentId);
      expect((await chatsOf(f)).map(chat => chat.conversationUserId)).toEqual([f.paul]);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toHaveLength(1);
    });

    it.each(["absent", "ambiguous", "other-company", "inactive"])("c: a %s principal is a true error, with no fallback or delivery", async kind => {
      const f = await fleetFixture(kind === "ambiguous" || kind === "inactive");
      if (kind === "ambiguous") await initializePrimaryAgent(server.db, f.companyId, f.ops, f.agentId);
      if (kind === "other-company") await initializePrimaryAgent(server.db, f.foreignCompanyId, f.paul, f.agentId);
      if (kind === "inactive") await server.db.update(companyMemberships).set({ status: "inactive" })
        .where(eq(companyMemberships.principalId, f.paul));
      const message = kind === "inactive" ? "The responsible human is no longer an active company member" : "This agent has no principal to message";
      await expect(send(f, principalInput)).rejects.toMatchObject({ status: 403, message });
      await expect(f.authority.execute({ tool: "send_chat_message", arguments: principalInput, callId: randomUUID() }))
        .rejects.toMatchObject({ status: 403, message });
      const response = await httpSend(f, principalInput);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: message });
      expect(await chatsOf(f)).toEqual([]);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toEqual([]);
    });

    it.each(["task-first", "principal-first"])("e: recipient change for the same key is 409, %s, across all paths", async order => {
      const f = await fleetFixture(), first = order === "task-first" ? input : principalInput;
      const second = order === "task-first" ? principalInput : input;
      const original = (await send(f, first))!;
      const shape = { status: 409, details: { code: "chat_message_recipient_changed", commentId: original.commentId } };
      await expect(send(f, second)).rejects.toMatchObject(shape);
      await expect(f.authority.execute({ tool: "send_chat_message", arguments: second, callId: randomUUID() })).rejects.toMatchObject(shape);
      await expect(f.authority.recover({ tool: "send_chat_message", arguments: second, callId: randomUUID() })).rejects.toMatchObject(shape);
      const response = await httpSend(f, second);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "chat_message_recipient_changed" });
      expect(await chatsOf(f)).toHaveLength(1);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toHaveLength(1);
    });

    it.each(["changed", "cleared", "ambiguous"])("revalidates a %s principal after waiting for the destination lock", async kind => {
      const f = await fleetFixture(), receipt = (await send(f, principalInput))!;
      let unlock!: () => void, ready!: (pid: number) => void;
      const locked = new Promise<number>(resolve => { ready = resolve; });
      const release = new Promise<void>(resolve => { unlock = resolve; });
      const gate = server.db.transaction(async tx => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, receipt.conversationId)).for("update");
        ready(pid); await release;
      });
      const pid = await locked;
      const delivery = httpSend(f, { ...principalInput, idempotencyKey: "principal-after-wait" });
      try {
        await vi.waitFor(async () => {
          const [row] = await server.db.execute(sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
            where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`);
          expect(row.blocked).toBe(true);
        }, { timeout: 5_000, interval: 10 });
        if (kind !== "ambiguous") await server.db.update(userCompanyPreferences).set({ primaryAgentId: null })
          .where(eq(userCompanyPreferences.userId, f.paul));
        if (kind !== "cleared") await initializePrimaryAgent(server.db, f.companyId, f.ops, f.agentId);
        unlock(); await gate;
        const response = await delivery;
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: kind === "changed"
          ? "The agent's principal changed before this message was saved" : "This agent has no principal to message" });
        expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toHaveLength(1);
      } finally { unlock(); await gate; await delivery; }
    }, 30_000);

    it("rejects invalid recipient values rather than silently using a default", async () => {
      const f = await fleetFixture();
      for (const recipient of [null, "paul", "", f.paul]) {
        expect((await httpSend(f, { ...input, recipient })).status).toBe(400);
        await expect(f.authority.execute({ tool: "send_chat_message", arguments: { ...input, recipient }, callId: randomUUID() }))
          .rejects.toMatchObject({ status: 400 });
      }
      expect(await chatsOf(f)).toEqual([]);
    });
  });

  describe("recipient is the source task's responsible person (CHATROUTE sections 4-5)", () => {
    it("R1+R7: a run executing for O (woken by O's comment) reaches P's existing chat once, attributed to O", async () => {
      const f = await fixture(), P = f.responsibleUserId!;
      const pChat = await issueService(server.db).create(f.companyId, { title: "Chat with P", assigneeAgentId: f.agentId,
        conversationAgentId: f.agentId, conversationUserId: P, conversationState: "waiting", status: "in_review" });
      const O = await member(f, "Ops person");
      const woken = await wokenBy(f, O);
      const receipt = await woken.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }) as ChatMessageReceipt;
      expect(receipt).toMatchObject({ conversationId: pChat.id, sourceTaskId: f.issueId, replayed: false });
      expect(await woken.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
        .toMatchObject({ result: { commentId: receipt.commentId, conversationId: pChat.id, replayed: true } });
      expect(await sendAgentChatMessage(server.db, woken.as, input)).toMatchObject({ commentId: receipt.commentId, replayed: true });
      expect((await chatsOf(f)).map(chat => [chat.id, chat.conversationUserId])).toEqual([[pChat.id, P]]);
      const delivered = await server.db.select().from(issueComments).where(eq(issueComments.issueId, pChat.id));
      expect(delivered).toHaveLength(1);
      // R7: execution attribution stays O's; the destination is P's chat.
      expect(delivered[0]).toMatchObject({ id: receipt.commentId, authorAgentId: f.agentId, createdByRunId: woken.runId, onBehalfOfUserId: O,
        metadata: { chatMessage: { sourceTaskId: f.issueId, sourceRunId: woken.runId } } });
      expect((await f.snapshot()).activity).toContainEqual(expect.objectContaining({ action: "issue.comment_added", entityId: pChat.id,
        runId: woken.runId, details: expect.objectContaining({ conversationUserId: P, sourceTaskId: f.issueId }) }));
      expect((await issueService(server.db).getById(f.issueId))!.responsibleUserId).toBe(P);
    });

    it("R2: when P has no chat yet, HTTP delivery from O's run creates exactly one chat with P", async () => {
      const f = await fixture(), P = f.responsibleUserId!, O = await member(f, "Ops person");
      const woken = await wokenBy(f, O);
      const first = await httpSend(woken.as);
      expect(first.status, await first.clone().text()).toBe(201);
      const receipt = await first.json() as ChatMessageReceipt;
      const retry = await httpSend(woken.as);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ commentId: receipt.commentId, conversationId: receipt.conversationId, replayed: true });
      expect((await chatsOf(f)).map(chat => [chat.id, chat.conversationUserId, chat.responsibleUserId])).toEqual([[receipt.conversationId, P, P]]);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, receipt.conversationId))).toHaveLength(1);
    });

    it("R3: a task without a responsible person fails closed with a true error and never falls back to the run's person", async () => {
      const f = await fixture(), O = await member(f, "Ops person");
      const woken = await wokenBy(f, O);
      await server.db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, f.issueId));
      await expect(woken.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() }))
        .rejects.toMatchObject({ status: 403, message: "This task has no responsible person to receive the message" });
      const response = await httpSend(woken.as);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "This task has no responsible person to receive the message" });
      expect(await chatsOf(f)).toEqual([]);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toEqual([]);
    });

    it("R5: a key already delivered to O's chat is an explicit recipient-change conflict, never a claim or a second delivery", async () => {
      const f = await fixture(), P = f.responsibleUserId!, O = await member(f, "Ops person");
      const woken = await wokenBy(f, O);
      // The pre-fix destination: the same source-task key committed in O's chat.
      await server.db.update(issues).set({ responsibleUserId: O }).where(eq(issues.id, f.issueId));
      const toO = (await sendAgentChatMessage(server.db, woken.as, input))!;
      expect((await issueService(server.db).getById(toO.conversationId))!.conversationUserId).toBe(O);
      await server.db.update(issues).set({ responsibleUserId: P }).where(eq(issues.id, f.issueId));
      const conflictShape = { status: 409, details: { code: "chat_message_recipient_changed", commentId: toO.commentId, conversationId: toO.conversationId } };
      await expect(sendAgentChatMessage(server.db, woken.as, input)).rejects.toMatchObject(conflictShape);
      await expect(woken.authority.execute({ tool: "send_chat_message", arguments: input, callId: randomUUID() })).rejects.toMatchObject({ status: 409 });
      await expect(woken.authority.recover({ tool: "send_chat_message", arguments: input, callId: randomUUID() })).rejects.toMatchObject({ status: 409 });
      const http = await httpSend(woken.as);
      expect(http.status).toBe(409);
      expect(await http.json()).toMatchObject({ code: "chat_message_recipient_changed" });
      // No P chat was created by the refused retries; O's single message stays.
      expect((await chatsOf(f)).map(chat => chat.conversationUserId)).toEqual([O]);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toHaveLength(1);
      // An intentional resend uses a new key and reaches P once.
      const fresh = (await sendAgentChatMessage(server.db, woken.as, { ...input, idempotencyKey: "morning-pr-digest-resend" }))!;
      expect((await issueService(server.db).getById(fresh.conversationId))!.conversationUserId).toBe(P);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.authorAgentId, f.agentId))).toHaveLength(2);
    });

    it("revalidates the task's responsible person under the source row lock", async () => {
      const f = await fixture(), receipt = (await send(f))!, Q = await member(f, "New owner");
      let unlock!: () => void, ready!: (pid: number) => void;
      const locked = new Promise<number>(resolve => { ready = resolve; });
      const release = new Promise<void>(resolve => { unlock = resolve; });
      const gate = server.db.transaction(async tx => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, receipt.conversationId)).for("update");
        ready(pid); await release;
      });
      const pid = await locked;
      const delivery = httpSend(f, { ...input, idempotencyKey: "person-after-wait" });
      try {
        await vi.waitFor(async () => {
          const [row] = await server.db.execute(sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
            where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`);
          expect(row.blocked).toBe(true);
        }, { timeout: 5_000, interval: 10 });
        await server.db.update(issues).set({ responsibleUserId: Q }).where(eq(issues.id, f.issueId));
        unlock(); await gate;
        const response = await delivery;
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: "The task's responsible person changed before this message was saved" });
        expect((await f.snapshot()).comments).toHaveLength(1);
      } finally { unlock(); await gate; await delivery; }
    }, 30_000);

    it("R6: a comment from another task's run gets the wrong-task 409; a stale-generation reply keeps its text", async () => {
      const f = await fixture(), P = f.responsibleUserId!;
      const pChat = await issueService(server.db).create(f.companyId, { title: "Chat with P", assigneeAgentId: f.agentId,
        conversationAgentId: f.agentId, conversationUserId: P, conversationState: "waiting", status: "in_review" });
      const wrongTask = await agentHttpComment(f, pChat.id, "Paul, here is the status");
      expect(wrongTask.status).toBe(409);
      const wrongBody = await wrongTask.json();
      expect(wrongBody).toMatchObject({ code: "chat_reply_wrong_task" });
      expect(wrongBody.error).toMatch(/^This run belongs to another task; .*Use send_chat_message to message your task's responsible person/);
      expect(wrongBody.error).not.toMatch(/earlier session/);
      // A run that does belong to this chat, but to its earlier session.
      const replyRun = randomUUID();
      await server.db.insert(heartbeatRuns).values({ id: replyRun, companyId: f.companyId, agentId: f.agentId, status: "running",
        nativeIssueId: pChat.id, responsibleUserId: P, contextSnapshot: { issueId: pChat.id, conversationSessionGeneration: 0 } });
      await server.db.update(issues).set({ executionRunId: replyRun, conversationState: "active" }).where(eq(issues.id, pChat.id));
      await server.db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, pChat.id));
      await expect(issueService(server.db).addComment(pChat.id, "Stale reply", { agentId: f.agentId, runId: replyRun }))
        .rejects.toMatchObject({ status: 409, message: "Conversation session changed; this reply belongs to an earlier session" });
      expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, pChat.id))).toEqual([]);
      // The tools say the same thing to the agent.
      const comment = runnerBridgeDefinitions({ workspace: false, skills: false, api: true, mode: "standard" }).find(d => d.name === "comment_on_task")!;
      expect(comment.description).toMatch(/this run belongs to another task.*use send_chat_message to message your task's responsible person/);
      expect(comment.description).toMatch(/conversation session changed/);
      const sendTool = f.authority.definitions().find(d => d.name === "send_chat_message")!;
      expect(sendTool.description).toMatch(/this task's responsible person: the person recorded as responsible on the task, not whoever commented on, woke or instructed this run/);
    });
  });
});
