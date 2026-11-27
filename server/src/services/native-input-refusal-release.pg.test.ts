// Keep reason: real-PG regression for held deferred wakes bypassing admission and losing wake-only content.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issueComments, issues, agentWakeupRequests, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { buildPaperclipWakePayload } from "./heartbeat/run-preparation.js";
import { buildNativeExecutionInput } from "./native-runtime/native-execution-input.js";
import { buildNativeContinuationPrompt } from "./native-runtime/native-continuation.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { nativeInputRevision } from "./native-runtime/native-turn-budget.js";
import { hasUnchangedNativeInputRefusal } from "./native-input-refusal.js";
import { createPostgresWakeQueueAdapter, createWakeAdmissionReader } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("refusal-release-"); db = createDb(database.connectionString); }, 120000);
afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
async function fixture(runtimeMode: "native" | "legacy" = "legacy") {
  const now = new Date(), user = randomUUID();
  await db.insert(authUsers).values({ id: user, name: "Input owner", email: user + "@example.test", createdAt: now, updatedAt: now });
  const [company] = await db.insert(companies).values({ name: "Held input regression", issuePrefix: "H" + randomUUID().replaceAll("-", "").slice(0,8).toUpperCase() }).returning();
  await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: user, status: "active", membershipRole: "operator" });
  const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Input worker", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Answer", description: "Short request.", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: user }).returning();
  const [message] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: user, body: "x".repeat(600_038) }).returning();
  const revision = nativeInputRevision(issue, [{ id: message.id, authorType: "user", updatedAt: message.updatedAt.toISOString(), deleted: false }]);
  const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "failed", runtimeMode, issueId: issue.id, nativeIssueId: runtimeMode === "native" ? issue.id : null, responsibleUserId: user, contextSnapshot: { issueId: issue.id, nativeInputRevision: revision }, startedAt: now, finishedAt: now, errorCode: "native_turn_prompt_exceeds_command_bound", resultJson: { nativeTurnPromptRefusalInput: revision, ...(runtimeMode === "legacy" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : {}) } }).returning();
  if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ companyId: company.id, issueId: issue.id, runId: run.id, phase: "committed" });
  const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: async () => user, getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: user }), resolveSessionBeforeForWakeup: async () => null,
  }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
  const deps = createHeartbeatQueueTestDependencies(db); deps.getAgent.mockResolvedValue(agent); deps.instanceSettings.getExperimental.mockResolvedValue({} as never);
  deps.releaseIssueExecutionAndPromote.mockImplementation(async (source, options) => { await release({ companyId: source.companyId, runId: source.id, now: new Date(), ...options }); });
  const queue = createHeartbeatQueue(db, deps);
  const wake = (reason: string, extra: Record<string, unknown> = {}) => queue.enqueueWakeup(agent.id, { source: "automation", reason, requestedByActorType: "system", payload: { issueId: issue.id, ...extra }, contextSnapshot: { issueId: issue.id, wakeReason: reason } });
  const wakes = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, company.id));
  const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id));
  const held = () => hasUnchangedNativeInputRefusal(db, { companyId: company.id, issueId: issue.id });
  const repair = () => db.update(issueComments).set({ body: "Please answer ready.", updatedAt: new Date(message.updatedAt.getTime() + 1000) }).where(eq(issueComments.id, message.id));
  return { company, agent, issue, message, run, revision, queue, wake, wakes, runs, held, repair, release, deps, user };
}
it("P1 direct release cannot promote an automatic assignment receipt while refused input is unchanged", async () => {
  const f = await fixture(); expect(await f.wake("issue_assigned")).toBeNull();
  const result = await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true });
  console.info(JSON.stringify({ row: "P1-direct-release", result, held: await f.held(), receipts: await f.wakes(), runIds: (await f.runs()).map(r => r.id) }));
  expect(await f.held()).toBe(true); expect(await f.runs()).toHaveLength(1);
  expect((await f.wakes())[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date(), resumeStrandedQueue: true });
  expect(await f.runs()).toHaveLength(1);
}, 120000);
it("DEDUPE one held row preserves every distinct child summary and deduplicates identical content", async () => {
  const f = await fixture();
  for (const childSummary of ["child A", "child B", "child C", "child A"]) expect(await f.wake("issue_children_completed", { childSummary })).toBeNull();
  const wakes = await f.wakes(); console.info(JSON.stringify({ row: "DEDUPE-content", receipts: wakes }));
  expect(wakes).toHaveLength(1);
  const events = wakes[0].payload?.nativeInputRefusalWakes as Array<{ payload: { childSummary: string } }>;
  expect(events.map(e => e.payload.childSummary).sort()).toEqual(["child A", "child B", "child C"]);
}, 120000);
it.each(["legacy", "native"] as const)("REPAIR %s edit releases all saved child content exactly once through the real drain", async mode => {
  const f = await fixture(mode);
  for (const childSummary of ["child A", "child B", "child C"]) await f.wake("issue_children_completed", { childSummary, triggerPayload: { amount: 7 } });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(1);
  await f.repair(); expect(await f.held()).toBe(false);
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const runs = await f.runs(); console.info(JSON.stringify({ row: "REPAIR-exactly-once", mode, runIds: runs.map(r => r.id), receipts: await f.wakes() }));
  expect(runs).toHaveLength(2);
  const next = runs.find(r => r.id !== f.run.id)!;
  expect((await f.wakes())[0]).toMatchObject({ status: "queued", runId: next.id });
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, agentId: f.agent.id, runId: next.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  expect(JSON.stringify(payload)).toContain("child A"); expect(JSON.stringify(payload)).toContain("child B"); expect(JSON.stringify(payload)).toContain("child C");
  const execution = buildNativeExecutionInput({ companyId: f.company.id, agentId: f.agent.id, runId: next.id,
    issue: { ...f.issue, workMode: "standard" }, taskPrompt: "Answer the repaired task.", wakePayload: payload,
    provider: "pi_rpc", boundCommandBytes: true, normalizedSessionId: null,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: "contract", sha256: "a".repeat(64),
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } } });
  const compact = buildNativeContinuationPrompt({ wakePayload: { ...payload, reason: "issue_children_completed",
    executionContinuation: { version: 1, objective: "Answer", messages: [], resumeDelta: { baseRunId: f.run.id, messages: [] } } },
    previousRunId: f.run.id, issue: f.issue, previousIssue: f.issue });
  const promptOnly = buildNativeContinuationPrompt({ wakePayload: payload, promptOnly: true,
    previousRunId: f.run.id, issue: f.issue, previousIssue: f.issue });
  for (const child of ["child A", "child B", "child C"]) {
    expect(execution.task.prompt).toContain(child); expect(compact).toContain(child); expect(promptOnly).toContain(child);
  }
  console.info(JSON.stringify({ row: "REPAIR-runtime-payload", mode, runId: next.id, payload, nativePrompt: execution.task.prompt, compact, promptOnly }));
}, 120000);
it("STRANDED ten simulated minutes of every automatic wake kind do not replay one 600 KB refused comment", async () => {
  const f = await fixture();
  const reasons = ["issue_assigned", "issue_assignment_recovery", "issue_continuation_needed", "issue_recovery_action_restored", "native_run_failed", "issue_status_changed", "transient_failure_retry", "issue_children_completed", "issue_commented", "issue_dependency_resolved", "routine", "timer", "webhook", "future_automatic_reason"];
  for (let minute = 0; minute <= 10; minute++) {
    // Age the actual persisted rows rather than faking PostgreSQL's clock.
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - minute * 60_000) }).where(eq(agentWakeupRequests.companyId, f.company.id));
    for (const source of ["timer", "assignment", "on_demand", "automation"] as const) for (const reason of reasons) {
      expect(await f.queue.enqueueWakeup(f.agent.id, { source, reason, requestedByActorType: source === "on_demand" ? "agent" : "system",
        payload: { issueId: f.issue.id, childSummary: "saved evidence", ...(reason === "issue_commented" ? { commentId: f.message.id } : {}) },
        contextSnapshot: { issueId: f.issue.id, wakeReason: reason } })).toBeNull();
    }
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date(Date.now() + minute * 60_000), suppressImmediateRecovery: true, resumeStrandedQueue: true });
    expect(await f.runs()).toHaveLength(1); expect(await f.held()).toBe(true);
    expect((await f.wakes()).every(w => w.status === "deferred_issue_execution" && w.runId === null)).toBe(true);
  }
  expect(await f.wakes()).toHaveLength(1);
  expect((await db.select().from(issueComments).where(eq(issueComments.id, f.message.id)))[0].body).toHaveLength(600_038);
  console.info(JSON.stringify({ row: "STRANDED-600KB-ten-minutes", attemptedWakes: reasons.length * 4 * 11, sources: ["timer", "assignment", "on_demand", "automation"], reasons, runIds: (await f.runs()).map(r => r.id), receipts: await f.wakes() }));
}, 120000);
it("K reassignment admits the new agent rather than applying the refused agent's hold", async () => {
  const f = await fixture();
  const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "New assignee", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, f.issue.id)); f.deps.getAgent.mockResolvedValue(other);
  const next = await f.queue.enqueueWakeup(other.id, { source: "automation", reason: "issue_assigned", requestedByActorType: "system", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } });
  console.info(JSON.stringify({ row: "K-agent-scope", refusedAgentId: f.agent.id, newAgentId: other.id, nextRunId: next?.id }));
  expect(next).not.toBeNull(); expect(next?.agentId).toBe(other.id);
}, 120000);
it("REPAIR admitted person run takes held wake-only content once, while an unchanged explicit attempt cannot take it", async () => {
  const f = await fixture();
  await f.wake("issue_children_completed", { childSummary: "owed A" });
  await f.wake("issue_children_completed", { childSummary: "owed B" });
  const attempt = () => f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: f.user,
    payload: { issueId: f.issue.id, commentId: f.message.id }, contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_commented", wakeCommentId: f.message.id } });
  const unchanged = await attempt(); expect(unchanged).not.toBeNull();
  expect(unchanged!.contextSnapshot?.nativeInputRefusalWakes).toBeUndefined();
  expect((await f.wakes()).filter(w => w.payload?.nativeInputRefusalHold === true && w.status === "deferred_issue_execution")).toHaveLength(1);
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, unchanged!.id));
  await f.repair(); const repaired = await attempt(); expect(repaired).not.toBeNull();
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, agentId: f.agent.id, runId: repaired!.id, contextSnapshot: repaired!.contextSnapshot as Record<string, unknown> });
  expect(JSON.stringify(payload)).toContain("owed A"); expect(JSON.stringify(payload)).toContain("owed B");
  const held = (await f.wakes()).filter(w => w.payload?.nativeInputRefusalHold === true && w.status === "deferred_issue_execution");
  expect(held).toHaveLength(0);
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, repaired!.id));
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  expect(await f.runs()).toHaveLength(3);
  console.info(JSON.stringify({ row: "REPAIR-person-adoption", refusedRunId: f.run.id, unchangedExplicitRunId: unchanged!.id, repairedRunId: repaired!.id, payload, runCount: (await f.runs()).length }));
}, 120000);
it("DEDUPE concurrent held wakes serialize into one pending receipt without losing content", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 12 }, (_, n) => f.wake("issue_children_completed", { childSummary: `child ${n}` })));
  const wakes = await f.wakes(); expect(wakes).toHaveLength(1);
  expect(wakes[0].payload?.nativeInputRefusalWakes).toHaveLength(12);
  console.info(JSON.stringify({ row: "DEDUPE-concurrent", requestId: wakes[0].id, count: (wakes[0].payload?.nativeInputRefusalWakes as unknown[]).length }));
}, 120000);
it("a generic deferred merge cannot reauthorize or overwrite an automatic held aggregate", async () => {
  const f = await fixture(); await f.wake("issue_children_completed", { childSummary: "owed child" });
  const existing = await db.transaction(tx => createWakeAdmissionReader(tx as never, f.company.id).findExistingDeferredWake({ companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id }));
  expect(existing).toBeNull();
  console.info(JSON.stringify({ row: "HOLD-no-generic-merge", requestId: (await f.wakes())[0].id, genericMergeCandidate: existing }));
}, 120000);
it("UPGRADE saved v14 held child payloads consolidate on inspection and are delivered rather than discarded", async () => {
  const f = await fixture();
  for (const childSummary of ["v14 saved child A", "v14 saved child B", "v14 saved child C"]) await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
    // A v14 generic merge could have rewritten the original actor. The hold
    // marker still denies replay; an inherited user actor cannot authorize it.
    source: childSummary.endsWith("A") ? "assignment" : "automation", reason: "issue_children_completed", requestedByActorType: childSummary.endsWith("A") ? "user" : "system",
    status: "deferred_issue_execution", payload: { issueId: f.issue.id, nativeInputRefusalHold: true, childSummary, _paperclipWakeContext: { issueId: f.issue.id, wakeReason: "issue_children_completed" } } });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(1);
  expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(1);
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!; expect(next).toBeDefined();
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  for (const child of ["v14 saved child A", "v14 saved child B", "v14 saved child C"]) expect(JSON.stringify(payload)).toContain(child);
  console.info(JSON.stringify({ row: "UPGRADE-v14-held-payload", runId: next.id, payload }));
}, 120000);
it.each(["agent", "system"] as const)("C1 %s authored refused source can be repaired by edit or deletion", async authorType => {
  for (const mutation of ["edit", "delete"] as const) {
    const f = await fixture();
    const [source] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType, ...(authorType === "agent" ? { authorAgentId: f.agent.id, createdByRunId: f.run.id } : {}), body: "z".repeat(600_038) }).returning();
    const revision = nativeInputRevision(f.issue, [
      { id: f.message.id, authorType: "user", updatedAt: f.message.updatedAt.toISOString(), deleted: false },
      { id: source.id, authorType, createdByRunId: source.createdByRunId, updatedAt: source.updatedAt.toISOString(), deleted: false },
    ]);
    await db.update(heartbeatRuns).set({ resultJson: { nativeTurnPromptRefusalInput: revision } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await f.wake("issue_children_completed", { childSummary: "owed content" })).toBeNull();
    expect(await f.held()).toBe(true);
    await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorType: "system", body: "Unrelated bookkeeping is not a repair." });
    expect(await f.held()).toBe(true);
    await db.update(issueComments).set({ ...(mutation === "delete" ? { deletedAt: new Date() } : { body: "Repaired source." }),
      updatedAt: new Date(source.updatedAt.getTime() + 1000) }).where(eq(issueComments.id, source.id));
    expect(await f.held()).toBe(false);
    // A new automatic message wake (not a person's bypass) must now pass the gate.
    const next = await f.wake("issue_commented", { commentId: source.id });
    console.info(JSON.stringify({ row: "C1-nonperson-source", authorType, mutation, sourceId: source.id, refusedRunId: f.run.id, nextRunId: next?.id }));
    expect(next).not.toBeNull();
  }
}, 120000);
