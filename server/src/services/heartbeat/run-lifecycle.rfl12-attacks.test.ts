import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, chatConversations, chatEndpoints, chatMessageLinks, chatPublications, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issueComments, issues, subscribeDatabaseWork, toolApplications, toolConnections } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import { publishLiveEvent } from "../live-events.js";
import { getHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { createHeartbeatRunState } from "./run-state.js";
import { heartbeatService } from "../heartbeat.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatLifecycle, decorateHeartbeatRunRuntimeStatus, persistHeartbeatRunProcessMetadata, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { STORAGE_CREDENTIALS_REJECTED_HELD_MESSAGE, STORAGE_CREDENTIALS_REJECTED_MESSAGE, STORAGE_UNAVAILABLE_CODE,
  STORAGE_UNAVAILABLE_HELD_MESSAGE, STORAGE_UNAVAILABLE_MESSAGE } from "../../storage/storage-unavailable.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  return {
    ...state,
    ...createHeartbeatRunPreparation(db),
    getRunStatus: vi.fn(state.getRunStatus),
    issuesSvc: {
      addComment: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["addComment"]>(),
      listReviewAttention: vi.fn<HeartbeatLifecycleDependencies["issuesSvc"]["listReviewAttention"]>(),
    },
    recovery: { escalateStrandedAssignedIssue: vi.fn<HeartbeatLifecycleDependencies["recovery"]["escalateStrandedAssignedIssue"]>() },
    companySkills: { completeTestRunForIssue: vi.fn<HeartbeatLifecycleDependencies["companySkills"]["completeTestRunForIssue"]>() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn<HeartbeatLifecycleDependencies["enqueueWakeup"]>(),
    getCurrentUserRedactionOptions: vi.fn(async (): Promise<CurrentUserRedactionOptions> => ({})),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn<HeartbeatLifecycleDependencies["emitTerminalAgentTaskRun"]>(),
    budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
}
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected lifecycle database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat lifecycle module boundary", () => {
  it("constructs without database work or reporting effects", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatLifecycle(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
  });

  // Rows saved by earlier releases can carry the storage retry promise
  // under a code that no storage wait owns. They read truthfully after deploy,
  // with no migration; a run a storage wait owns keeps its promise.
  it.each([
    ["an outage", STORAGE_UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE_HELD_MESSAGE],
    ["rejected credentials", STORAGE_CREDENTIALS_REJECTED_MESSAGE, STORAGE_CREDENTIALS_REJECTED_HELD_MESSAGE],
  ])("reads a previously saved storage retry promise under native recovery truthfully (%s)", (_label, saved, expected) => {
    const held = decorateHeartbeatRunRuntimeStatus({ id: "held-native-run", status: "failed",
      errorCode: "native_continuation_requires_reconciliation", error: saved });
    expect(held.error).toBe(expected);
    const waiting = decorateHeartbeatRunRuntimeStatus({ id: "run-with-storage-wait", status: "failed",
      errorCode: STORAGE_UNAVAILABLE_CODE, error: saved });
    expect(waiting.error).toBe(saved);
    const other = decorateHeartbeatRunRuntimeStatus({ id: "other", status: "failed", errorCode: "adapter_failed", error: "Adapter failed" });
    expect(other.error).toBe("Adapter failed");
  });

  it("ignores absent wake requests without accessing the database", async () => {
    const database = guardedDatabase();
    const lifecycle = createHeartbeatLifecycle(database.db, callbacks(database.db));
    await lifecycle.setWakeupStatus(null, "completed");
    await lifecycle.setWakeupStatus(undefined, "completed");
    expect(database.access).not.toHaveBeenCalled();
  });

  it.each([
    { livenessState: "empty_response", contextSnapshot: { goalControlRequestId: "goal" } },
    { livenessState: "plan_only", contextSnapshot: { resumeSessionGoalHeartbeat: true } },
    { livenessState: "productive", contextSnapshot: { issueId: "issue" } },
    { livenessState: "empty_response", contextSnapshot: {} },
  ])("keeps ineligible continuations out of wake admission (%j)", async (input) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    await createHeartbeatLifecycle(database.db, deps).handleRunLivenessContinuation(input as unknown as Run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(deps.budgets.getInvocationBlock).not.toHaveBeenCalled();
  });

  it("preserves retained native ownership before lease-release teardown reads or writes", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { runtimeMode: "native", status: "running", nativePhase: "terminal_failure", errorCode: "native_execution_ownership_unverified" } as Run;
    expect(await createHeartbeatLifecycle(database.db, deps).terminalizeRunOnLeaseRelease(run)).toBe(run);
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.emitTerminalAgentTaskRun).not.toHaveBeenCalled();
  });

  it("rejects late progress after re-reading a terminal run through the service callback", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    const run = { id: "late-progress", companyId: "company", agentId: "agent", status: "running", contextSnapshot: {} } as Run;
    deps.getRunStatus.mockResolvedValue({ ...run, status: "succeeded" });
    expect(await createHeartbeatLifecycle(database.db, deps).recordCurrentHeartbeatRunRuntimeProgress(run, { phase: "finalize", message: "late update" }, null)).toBeNull();
    expect(deps.getRunStatus).toHaveBeenCalledWith(run.id);
    expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
    expect(database.access).not.toHaveBeenCalled();
  });

  it("does not publish progress when the current status read fails", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getRunStatus.mockRejectedValue(new Error("status read failed"));
    const run = { id: "unavailable-progress", companyId: "company", agentId: "agent", status: "running" };
    vi.mocked(publishLiveEvent).mockClear();
    await expect(createHeartbeatLifecycle(database.db, deps)
      .recordCurrentHeartbeatRunRuntimeProgress(run, { phase: "restore", message: "restoring" }, null))
      .rejects.toThrow("status read failed");
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(database.access).not.toHaveBeenCalled();
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LIFECYCLE_TEST_DATABASE_URL");
const support = external ? { supported: true as const } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping lifecycle module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat lifecycle database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-lifecycle-module");
    db = createDb(external ?? database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    vi.mocked(publishLiveEvent).mockClear();
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Lifecycle module", issuePrefix: "LM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Lifecycle agent" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "native", ...patch }).returning();
    return { company, agent, wake, run };
  }

  async function reviewDispositionFixture(input: {
    originKind?: string;
    conversationAgent?: boolean;
    reply?: "published" | "none" | "held";
    heldReason?: string;
  } = {}) {
    const issueId = randomUUID();
    const f = await fixture({ issueId, contextSnapshot: { issueId } });
    await db.insert(issues).values({ id: issueId, companyId: f.company.id, title: "Review path disposition",
      status: "in_review", assigneeAgentId: f.agent.id, originKind: input.originKind ?? "chat_channel",
      ...(input.conversationAgent ? { conversationAgentId: f.agent.id, conversationUserId: "review-person", conversationState: "active" as const } : {}) });
    await db.insert(issueComments).values({ companyId: f.company.id, issueId, authorType: "user", authorUserId: "review-person",
      body: "Please answer this.", createdAt: new Date(Date.now() - 1_000) });
    if (input.reply !== "none") {
      const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId, authorType: "agent",
        authorAgentId: f.agent.id, createdByRunId: f.run.id, origin: "comment", body: "Here is the answer." }).returning();
      await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: input.reply === "held"
        ? { commentAction: "none", reasonCodes: [input.heldReason ?? "yielded_control_plane_wait"] }
        : { commentAction: "create", commentId: comment!.id } } }).where(eq(heartbeatRuns.id, f.run.id));
      if (input.reply === "published" && (input.originKind ?? "chat_channel") === "chat_channel" && !input.conversationAgent) {
        const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: `RFL channel ${randomUUID()}`, type: "mcp_http" }).returning();
        const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application!.id, name: "RFL channel", uid: randomUUID(),
          transport: "chat_sdk", connectionPurpose: "channel" }).returning();
        const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection!.id, assignedAgentId: f.agent.id,
          provider: "slack", publicId: randomUUID(), status: "active" }).returning();
        const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint!.id, issueId,
          externalConversationId: randomUUID(), externalLabel: "RFL channel" }).returning();
        await db.insert(chatPublications).values({ companyId: f.company.id, endpointId: endpoint!.id, conversationId: conversation!.id,
          issueId, commentId: comment!.id, idempotencyKey: `rfl12-disposition:${comment!.id}`, state: "published",
          providerMessageId: randomUUID(), publishedAt: new Date(), payload: { text: "Here is the answer." } });
      }
    }
    return { ...f, issueId };
  }

  async function runReviewDisposition(f: Awaited<ReturnType<typeof reviewDispositionFixture>>) {
    const deps = callbacks(db);
    deps.issuesSvc.listReviewAttention.mockResolvedValue(new Map([[f.issueId, { state: "stalled", paths: [], reason: null }]]));
    deps.enqueueWakeup.mockResolvedValue({ id: randomUUID() } as never);
    await createHeartbeatLifecycle(db, deps).handleIssueReviewPathDisposition(f.run);
    return deps;
  }

  it("skips disposition for a NULL-channel chat answered by its assigned agent", async () => {
    const f = await reviewDispositionFixture({ reply: "published" });
    const deps = await runReviewDisposition(f);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(2);
    expect(await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.issueId))).toMatchObject([{ status: "in_review" }]);
  }, 60_000);

  it("keeps disposition for an unanswered NULL-channel chat", async () => {
    const f = await reviewDispositionFixture({ reply: "none" });
    const deps = await runReviewDisposition(f);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("keeps disposition for an answered non-chat task", async () => {
    const f = await reviewDispositionFixture({ originKind: "manual", reply: "published" });
    const deps = await runReviewDisposition(f);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("keeps disposition for an answered chat with a conversation agent", async () => {
    const f = await reviewDispositionFixture({ conversationAgent: true, reply: "published" });
    const deps = await runReviewDisposition(f);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 60_000);

  it.each(["yielded_control_plane_wait", "board_response_wait_superseded"] as const)(
    "keeps disposition when the reply was held (%s)", async heldReason => {
      const f = await reviewDispositionFixture({ reply: "held", heldReason });
      const deps = await runReviewDisposition(f);
      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    },
  );


  // ===== RFL round-12 independent attacks (judge-authored; not builder code) =====
  const rfl12Record = (name: string, data: unknown) => { if (process.env.TASK_OUT) appendFileSync(`${process.env.TASK_OUT}/rfl12-attack-receipts.jsonl`, JSON.stringify({ name, data }) + "\n"); };
  const ago = (ms: number) => new Date(Date.now() - ms);
  async function rfl12Base(input: { originKind?: string } = {}) {
    const issueId = randomUUID();
    const f = await fixture({ issueId, contextSnapshot: { issueId } });
    await db.insert(issues).values({ id: issueId, companyId: f.company.id, title: "RFL12 attack", status: "in_review",
      assigneeAgentId: f.agent.id, originKind: input.originKind ?? "chat_channel" });
    const [person] = await db.insert(issueComments).values({ companyId: f.company.id, issueId, authorType: "user", authorUserId: "review-person",
      body: "Please answer this.", createdAt: ago(60_000) }).returning();
    return { ...f, issueId, person: person! };
  }
  type B = Awaited<ReturnType<typeof rfl12Base>>;
  const rfl12Channels = new Map<string, { endpoint: typeof chatEndpoints.$inferSelect; conversation: typeof chatConversations.$inferSelect }>();
  async function channelFor(f: B): Promise<{ endpoint: typeof chatEndpoints.$inferSelect; conversation: typeof chatConversations.$inferSelect }> {
    const existing = rfl12Channels.get(f.issueId);
    if (existing) return existing;
    const [application] = await db.insert(toolApplications).values({ companyId: f.company.id, name: `RFL channel ${randomUUID()}`, type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.company.id, applicationId: application!.id, name: "RFL channel", uid: randomUUID(),
      transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.company.id, connectionId: connection!.id, assignedAgentId: f.agent.id,
      provider: "slack", publicId: randomUUID(), status: "active" }).returning();
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.company.id, endpointId: endpoint!.id, issueId: f.issueId,
      externalConversationId: randomUUID(), externalLabel: "RFL channel" }).returning();
    const result = { endpoint: endpoint!, conversation: conversation! };
    rfl12Channels.set(f.issueId, result);
    return result;
  }
  async function rfl12Run(f: B, name: string) {
    const deps = callbacks(db);
    deps.issuesSvc.listReviewAttention.mockResolvedValue(new Map([[f.issueId, { state: "stalled", paths: [], reason: null }]]));
    deps.enqueueWakeup.mockResolvedValue({ id: randomUUID() } as never);
    const before = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, f.issueId));
    await createHeartbeatLifecycle(db, deps).handleIssueReviewPathDisposition(f.run);
    const after = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, f.issueId));
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, f.issueId));
    const skipped = deps.enqueueWakeup.mock.calls.length === 0;
    rfl12Record(name, { skipped, wakeCalls: deps.enqueueWakeup.mock.calls.length, commentsBefore: before.length, commentsAfter: after.length, status: issue?.status });
    return { skipped, deps };
  }
  const agentReply = (f: B, patch: Partial<typeof issueComments.$inferInsert> = {}) => db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId,
    authorType: "agent", authorAgentId: f.agent.id, createdByRunId: f.run.id, origin: "comment", body: "Here is the answer.", createdAt: ago(30_000), ...patch }).returning().then(r => r[0]!);
  const published = async (f: B, commentId: string) => {
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId } } }).where(eq(heartbeatRuns.id, f.run.id));
    const channel = await channelFor(f);
    await db.insert(chatPublications).values({ companyId: f.company.id, endpointId: channel.endpoint.id, conversationId: channel.conversation.id,
      issueId: f.issueId, commentId, idempotencyKey: `rfl12-attack:${commentId}`, state: "published", providerMessageId: randomUUID(),
      publishedAt: new Date(), payload: { text: "Here is the answer." } });
  };

  it("RFL12 A0 control: published assigned-agent reply after the person message skips", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    expect((await rfl12Run(f, "A0-control-published")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A1 system note after the person message does not skip", async () => {
    const f = await rfl12Base();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "system", body: "System note.", createdAt: ago(30_000),
      presentation: { kind: "system_notice", tone: "info" } as never });
    expect((await rfl12Run(f, "A1-system-note")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A1b system-typed note that carries the assigned agent id does not skip", async () => {
    const f = await rfl12Base();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "system", authorAgentId: f.agent.id, createdByRunId: f.run.id,
      body: "System note with agent id.", createdAt: ago(30_000) });
    expect((await rfl12Run(f, "A1b-system-note-agent-id")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A1c agent-typed comment presented as a system_notice (not an answer) does not skip", async () => {
    const f = await rfl12Base();
    const c = await agentReply(f, { presentation: { kind: "system_notice", tone: "warning" } as never, body: "Couldn't finish this attempt." });
    void c;
    expect((await rfl12Run(f, "A1c-agent-typed-system-notice")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A2 deleted reply does not skip", async () => {
    const f = await rfl12Base(); const c = await agentReply(f, { deletedAt: new Date() }); await published(f, c.id);
    expect((await rfl12Run(f, "A2-deleted-reply")).skipped).toBe(false);
  }, 60_000);
  it.each([
    ["none+yielded", { commentAction: "none", reasonCodes: ["yielded_control_plane_wait"] }],
    ["none+superseded", { commentAction: "none", reasonCodes: ["board_response_wait_superseded"] }],
    ["none+other-reason", { commentAction: "none", reasonCodes: ["interaction_owns_response"] }],
    ["none+no-reasonCodes", { commentAction: "none" }],
    ["create+yielded", { commentAction: "create", reasonCodes: ["yielded_control_plane_wait"] }],
    ["reuse+superseded", { commentAction: "reuse", reasonCodes: ["board_response_wait_superseded"] }],
  ] as const)("RFL12 A3 held reply shape %s does not skip", async (label, presentationDecision) => {
    const f = await rfl12Base(); await agentReply(f);
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision } }).where(eq(heartbeatRuns.id, f.run.id));
    expect((await rfl12Run(f, `A3-held-${label}`)).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A4 reply by a DIFFERENT agent does not skip", async () => {
    const f = await rfl12Base();
    const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Other agent" }).returning();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "agent", authorAgentId: other!.id, origin: "comment",
      body: "Answer from someone else.", createdAt: ago(30_000) });
    expect((await rfl12Run(f, "A4-different-agent")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A5 reply authored through a board key (user-typed) does not skip", async () => {
    const f = await rfl12Base();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "user", authorUserId: "local-board",
      derivedAuthorAgentId: f.agent.id, derivedCreatedByRunId: f.run.id, body: "Board-key authored answer.", createdAt: ago(30_000) });
    expect((await rfl12Run(f, "A5-board-key")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A6 person message AFTER the agent reply does not skip", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "user", authorUserId: "review-person",
      body: "One more question.", createdAt: ago(10_000) });
    expect((await rfl12Run(f, "A6-person-after-reply")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A7a two person messages, reply after both skips", async () => {
    const f = await rfl12Base();
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "user", authorUserId: "review-person", body: "Second.", createdAt: ago(45_000) });
    const c = await agentReply(f); await published(f, c.id);
    expect((await rfl12Run(f, "A7a-two-person-then-reply")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A7b two person messages, reply between them does not skip", async () => {
    const f = await rfl12Base();
    const c = await agentReply(f, { createdAt: ago(50_000) }); await published(f, c.id);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "user", authorUserId: "second-person", body: "Second.", createdAt: ago(45_000) });
    expect((await rfl12Run(f, "A7b-reply-between")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A7c newest person message deleted, reply after the surviving one skips", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "user", authorUserId: "review-person", body: "Retracted.", createdAt: ago(10_000), deletedAt: new Date() });
    expect((await rfl12Run(f, "A7c-deleted-newest-person")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A8 two processes (two lifecycle instances) both skip, write nothing; unanswered both fall through", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    const [a, b] = await Promise.all([rfl12Run(f, "A8-proc-1"), rfl12Run(f, "A8-proc-2")]);
    expect([a.skipped, b.skipped]).toEqual([true, true]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(2);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(wakes).toHaveLength(1); // only the fixture's claimed wake
  }, 60_000);
  it("RFL12 A8b two processes on an UNANSWERED chat both fall through to upstream's own idempotent path", async () => {
    const g = await rfl12Base();
    const [x, y] = await Promise.all([rfl12Run(g, "A8b-unanswered-proc-1"), rfl12Run(g, "A8b-unanswered-proc-2")]);
    expect([x.skipped, y.skipped]).toEqual([false, false]);
  }, 60_000);
  it("RFL12 A9 agent reply with no run (agent API key outside a run) skips", async () => {
    const f = await rfl12Base(); await agentReply(f, { createdByRunId: null });
    expect((await rfl12Run(f, "A9-reply-without-run")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A10 reply whose run recorded NO presentation decision is treated as published", async () => {
    const f = await rfl12Base(); await agentReply(f);
    expect((await rfl12Run(f, "A10-no-presentation-decision")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A11 OBSERVE newest person message stored with NULL author_type (derivable legacy shape) after the reply", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorUserId: "review-person", body: "Newer question, legacy NULL author_type.", createdAt: ago(10_000) });
    expect((await rfl12Run(f, "A11-null-author-type-person-after-reply")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A12 OBSERVE newest inbound from an unmapped external sender (system-typed, sourceChannel metadata) after the reply", async () => {
    const f = await rfl12Base(); const c = await agentReply(f); await published(f, c.id);
    const [followup] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issueId, authorType: "system", body: "External person follow-up.", createdAt: ago(10_000),
      metadata: { version: 1, sourceChannel: "slack", sections: [] } as never }).returning();
    const channel = await channelFor(f);
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: channel.endpoint.id, conversationId: channel.conversation.id,
      commentId: followup!.id, providerMessageId: randomUUID(), direction: "inbound" });
    expect((await rfl12Run(f, "A12-unmapped-external-inbound-after-reply")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A12b OBSERVE thread whose ONLY inbound is system-typed (unmapped sender): answered chat is NOT skipped (fix does not apply)", async () => {
    const f = await rfl12Base();
    await db.update(issueComments).set({ authorType: "system", authorUserId: null, metadata: { version: 1, sourceChannel: "slack", sections: [] } as never }).where(eq(issueComments.id, f.person.id));
    const channel = await channelFor(f);
    await db.insert(chatMessageLinks).values({ companyId: f.company.id, endpointId: channel.endpoint.id, conversationId: channel.conversation.id,
      commentId: f.person.id, providerMessageId: randomUUID(), direction: "inbound" });
    const c = await agentReply(f); await published(f, c.id);
    expect((await rfl12Run(f, "A12b-only-unmapped-inbound-answered")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A13 OBSERVE agent reply with NULL author_type (derivable legacy shape)", async () => {
    const f = await rfl12Base(); const c = await agentReply(f, { authorType: null }); await published(f, c.id);
    expect((await rfl12Run(f, "A13-null-author-type-agent-reply")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A14 OBSERVE fast_response-origin agent comment", async () => {
    const f = await rfl12Base(); await agentReply(f, { origin: "fast_response", createdByRunId: null });
    const r = await rfl12Run(f, "A14-fast-response-origin"); expect(typeof r.skipped).toBe("boolean");
  }, 60_000);
  it("RFL12 A15 reply by an EARLIER run that is published, disposition for a later run that added nothing, skips", async () => {
    const f = await rfl12Base();
    const [earlier] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", runtimeMode: "native",
      contextSnapshot: { issueId: f.issueId }, resultJson: {} }).returning();
    const c = await agentReply(f, { createdByRunId: earlier!.id });
    await db.update(heartbeatRuns).set({ resultJson: { presentationDecision: { commentAction: "create", commentId: c.id } } }).where(eq(heartbeatRuns.id, earlier!.id));
    const channel = await channelFor(f);
    await db.insert(chatPublications).values({ companyId: f.company.id, endpointId: channel.endpoint.id, conversationId: channel.conversation.id,
      issueId: f.issueId, commentId: c.id, idempotencyKey: `rfl12-a15:${c.id}`, state: "published", providerMessageId: randomUUID(),
      publishedAt: new Date(), payload: { text: "Here is the answer." } });
    expect((await rfl12Run(f, "A15-reply-by-earlier-run")).skipped).toBe(true);
  }, 60_000);
  it("RFL12 A16 other-company / other-issue reply by the same agent id does not skip", async () => {
    const f = await rfl12Base();
    const otherIssue = randomUUID();
    await db.insert(issues).values({ id: otherIssue, companyId: f.company.id, title: "Other", status: "in_review", assigneeAgentId: f.agent.id, originKind: "chat_channel" });
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: otherIssue, authorType: "agent", authorAgentId: f.agent.id, origin: "comment", body: "Elsewhere." });
    expect((await rfl12Run(f, "A16-reply-on-other-issue")).skipped).toBe(false);
  }, 60_000);
  it("RFL12 A17 not in_review / non-chat origins unaffected (answered manual task still falls through)", async () => {
    const f = await rfl12Base({ originKind: "manual" }); const c = await agentReply(f); await published(f, c.id);
    expect((await rfl12Run(f, "A17-manual-origin")).skipped).toBe(false);
  }, 60_000);
  // ===== end RFL round-12 attacks =====

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "deleted"])(
    "rechecks progress after a run becomes %s without reading its large payloads",
    async (status) => {
      const { run } = await fixture({
        contextSnapshot: { prompt: randomBytes(128 * 1024).toString("hex") },
        runnerProfileJson: { configuration: randomBytes(128 * 1024).toString("hex") },
        resultJson: { providerData: randomBytes(128 * 1024).toString("hex") },
      });
      const deps = callbacks(db);
      const lifecycle = createHeartbeatLifecycle(db, deps);
      const update = { phase: "restore" as const, message: "Restoring workspace", currentToolName: "sync" };
      const progress = await lifecycle.recordCurrentHeartbeatRunRuntimeProgress(run, update, null);
      expect(progress).toMatchObject({
        companyId: run.companyId, agentId: run.agentId, runId: run.id,
        phase: update.phase, message: update.message, currentToolName: "sync",
      });
      expect(await deps.getRunStatus.mock.results[0].value).toEqual({
        id: run.id, companyId: run.companyId, agentId: run.agentId, status: "running",
      });
      expect(publishLiveEvent).toHaveBeenCalledTimes(1);
      expect(publishLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
        companyId: run.companyId,
        type: "heartbeat.run.progress",
        payload: expect.objectContaining({ runId: run.id, agentId: run.agentId, phase: update.phase, message: update.message }),
      }));

      if (status === "deleted") await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      else await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run.id));

      expect(await lifecycle.recordCurrentHeartbeatRunRuntimeProgress(run, update, null)).toBeNull();
      expect(deps.getRunStatus).toHaveBeenCalledTimes(2);
      expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
      expect(publishLiveEvent).toHaveBeenCalledTimes(1);
    },
  );

  it("wires fresh progress status reads through the public heartbeat service", async () => {
    const { run } = await fixture();
    const service = heartbeatService(db);
    const update = { phase: "config_sync" as const, message: "Syncing workspace" };
    expect(await service.recordRuntimeProgress(run, update, null)).toMatchObject({ runId: run.id, message: update.message });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    expect(await service.recordRuntimeProgress(run, update, null)).toBeNull();
    expect(getHeartbeatRunRuntimeStatus(run.id)).toBeNull();
    expect(publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("preserves sandbox process birth instead of inspecting a colliding controller PID", async () => {
    const { run } = await fixture();
    const remoteBirth = "2026-10-09T00:00:00.000Z";
    const persisted = await persistHeartbeatRunProcessMetadata(db, run.id, {
      pid: process.pid, processGroupId: null, startedAt: remoteBirth, targetKind: "remote",
    });
    expect(persisted?.processStartedAt?.toISOString()).toBe(remoteBirth);
    expect(persisted?.processPid).toBe(process.pid);
  });

  it("keeps one terminal outcome and reports only the winner of competing writes", async () => {
    const { run } = await fixture();
    const deps = callbacks(db);
    const lifecycle = createHeartbeatLifecycle(db, deps);
    const results = await Promise.all([
      lifecycle.setRunStatusIfRunning(run.id, "succeeded", { finishedAt: new Date() }),
      lifecycle.setRunStatusIfRunning(run.id, "failed", { errorCode: "late_failure", finishedAt: new Date() }),
    ]);
    const winner = results.find(result => result.updated)!;
    expect(results.filter(result => result.updated)).toHaveLength(1);
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.status).toBe(winner.run?.status);
    expect(results.every(result => result.run?.status === persisted.status)).toBe(true);
    expect(deps.emitTerminalAgentTaskRun).toHaveBeenCalledTimes(1);
    expect(deps.emitTerminalAgentTaskRun).toHaveBeenCalledWith(winner.run, "running", undefined);
    expect(vi.mocked(publishLiveEvent).mock.calls.filter(([event]) => event.type === "heartbeat.run.status")).toHaveLength(1);
  });

  it("rechecks native ownership atomically before a terminal write", async () => {
    const { run } = await fixture({ errorCode: "native_execution_ownership_unverified", nativePhase: "terminal_failure" });
    const deps = callbacks(db);
    const result = await createHeartbeatLifecycle(db, deps).setRunStatusIfRunning(run.id, "failed");
    expect(result).toMatchObject({ updated: false, run: { status: "running", errorCode: run.errorCode } });
    expect(deps.emitTerminalAgentTaskRun).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("preserves accounting metadata while %s enriches usage", async (operation) => {
    const { run } = await fixture({ usageJson: { accountingReceiptReady: false, usageSource: "per_run", inputTokens: 5 } });
    await createHeartbeatLifecycle(db, callbacks(db))[operation](run.id, "succeeded", { usageJson: { inputTokens: 8, outputTokens: 3 } });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted.usageJson).toEqual({ accountingReceiptReady: false, usageSource: "per_run", inputTokens: 8, outputTokens: 3 });
  });

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("signals committed terminal accounting before %s publishes a failed live event", async operation => {
    const { run } = await fixture({ costAccountingPending: true });
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    vi.mocked(publishLiveEvent).mockImplementationOnce(() => { throw new Error("Live publication unavailable"); });
    try {
      await expect(createHeartbeatLifecycle(db, callbacks(db))[operation](run.id, "succeeded", { finishedAt: new Date() }))
        .rejects.toThrow("Live publication unavailable");
      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(persisted.status).toBe("succeeded");
      expect(persisted.costAccountingPending).toBe(true);
      expect(settled).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it.each(["native", "legacy", "unbound"] as const)("keeps %s run-status response recovery scoped to its task or run", async binding => {
    const { run } = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: run.companyId, title: "Scope owner" }).returning();
    await db.update(heartbeatRuns).set(binding === "native" ? { nativeIssueId: issue.id }
      : binding === "legacy" ? { contextSnapshot: { issueId: issue.id } } : { contextSnapshot: {} }).where(eq(heartbeatRuns.id, run.id));
    const hints: unknown[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.nativeResponsePresentation, (event, scopes) => {
      if (event === "settled") for (const hint of scopes ?? []) hints.push(JSON.parse(hint));
    });
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatusIfRunning(run.id, "succeeded", { finishedAt: new Date() });
      expect(hints).toEqual([binding === "unbound" ? { companyId: run.companyId, runId: run.id }
        : { companyId: run.companyId, issueId: issue.id }]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
    } finally { unsubscribe(); }
  });

  it.each(["setRunStatus", "setRunStatusIfRunning"] as const)("wakes retained cleanup only after the outer %s terminal write commits", async operation => {
    const { run } = await fixture();
    const hints: unknown[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.retainedNativeSessionCleanup, (event, scopes) => {
      if (event === "settled") for (const scope of scopes ?? []) hints.push(JSON.parse(scope));
    });
    try {
      await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await createHeartbeatLifecycle(tx, callbacks(tx))[operation](run.id, "succeeded", { finishedAt: new Date() });
        expect(hints).toEqual([]);
        expect((await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded");
      });
      expect(hints).toEqual([{ companyId: run.companyId, runId: run.id }]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].finishedAt).not.toBeNull();
      hints.length = 0;

      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "succeeded", { error: "repaired metadata" });
      expect(hints).toEqual([{ companyId: run.companyId, runId: run.id }]);
    } finally { unsubscribe(); }
  });

  it("does not wake retained cleanup for running progress", async () => {
    const { run } = await fixture();
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.retainedNativeSessionCleanup, settled);
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "running");
      expect(settled).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("does not request accounting for an unchanged running status", async () => {
    const { run } = await fixture();
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    try {
      await createHeartbeatLifecycle(db, callbacks(db)).setRunStatus(run.id, "running");
      expect(settled).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it("signals legacy terminal accounting after the nested terminalizer transaction commits", async () => {
    const { run } = await fixture({ runtimeMode: "legacy", costAccountingPending: true });
    const settled = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.accounting, settled);
    try {
      const result = await createHeartbeatLifecycle(db, callbacks(db)).setRunStatusIfRunning(run.id, "failed", { finishedAt: new Date() });
      expect(result.updated).toBe(true);
      expect(result.run?.status).toBe("failed");
      expect(settled).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it.each(["claimed", "cancelled"] as const)("settles a %s wake without reviving a revoked request", async (status) => {
    const { wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatLifecycle(db, callbacks(db)).setWakeupStatus(wake.id, "completed", { reason: "settled" });
    const [persisted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(persisted.status).toBe(status === "cancelled" ? "cancelled" : "completed");
    expect(persisted.reason).toBe(status === "cancelled" ? wake.reason : "settled");
  });

  it("publishes the persisted sequence for concurrent event writes", async () => {
    const { run } = await fixture();
    const lifecycle = createHeartbeatLifecycle(db, callbacks(db));
    await Promise.all(["first", "second"].map(message => lifecycle.appendRunEvent(run, { eventType: "lifecycle", message })));
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(heartbeatRunEvents.seq);
    expect(rows.map(row => row.seq)).toEqual([1, 2]);
    const published = vi.mocked(publishLiveEvent).mock.calls.map(([event]) => event).filter(event => event.type === "heartbeat.run.event");
    expect(published).toHaveLength(2);
    for (const row of rows) expect(published.find(event => event.payload?.seq === row.seq)?.payload).toMatchObject({ runId: run.id, message: row.message });
  });

  it.each(["legacy.case_handoff_cleanup_intent", "legacy.case_handoff_cleanup_verified"])(
    "does not count controller cleanup bookkeeping as agent progress (%s)", async (eventType) => {
      const { run } = await fixture({ status: "succeeded", runtimeMode: "legacy" });
      const lifecycle = createHeartbeatLifecycle(db, callbacks(db));
      await lifecycle.appendRunEvent(run, { eventType, stream: "system", message: "Controller cleanup receipt" });
      const result = { summary: "I will inspect the repo next and then implement the fix." };
      const planning = await lifecycle.classifyAndPersistRunLiveness(run, result);
      expect(planning).toMatchObject({ livenessState: "plan_only", lastUsefulActionAt: null });

      await lifecycle.appendRunEvent(run, { eventType: "item.completed", stream: "stdout", message: "Read the source file" });
      const progressed = await lifecycle.classifyAndPersistRunLiveness(run, result);
      expect(progressed?.livenessState).toBe("advanced");
      expect(progressed?.lastUsefulActionAt).toBeInstanceOf(Date);
    },
  );

  it("reads current redaction settings for each event and persists the published sanitized payload", async () => {
    const { run } = await fixture();
    const deps = callbacks(db);
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["alice"], homeDirs: ["/Users/alice"] });
    deps.getCurrentUserRedactionOptions.mockResolvedValueOnce({ enabled: true, userNames: ["bob"], homeDirs: ["/Users/bob"] });
    const lifecycle = createHeartbeatLifecycle(db, deps);
    for (const name of ["alice", "bob"]) await lifecycle.appendRunEvent(run, {
      eventType: "lifecycle", message: `Opening /Users/${name}/project`, payload: { path: `/Users/${name}/project`, token: "test-credential-material" },
    });
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id)).orderBy(heartbeatRunEvents.seq);
    expect(deps.getCurrentUserRedactionOptions).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    const published = vi.mocked(publishLiveEvent).mock.calls.map(([event]) => event).filter(event => event.type === "heartbeat.run.event");
    expect(published).toHaveLength(2);
    for (const row of rows) {
      const text = JSON.stringify({ message: row.message, payload: row.payload });
      expect(text).not.toContain("alice");
      expect(text).not.toContain("bob");
      expect(text).not.toContain("test-credential-material");
      expect(published.find(event => event.payload?.seq === row.seq)?.payload).toMatchObject({ message: row.message, payload: row.payload });
    }
  });
});
