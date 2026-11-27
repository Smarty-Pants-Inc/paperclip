import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/index.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueComments, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, responsibilities, responsibilityLinks, routineTriggers, routines, userWorkspacePreferences, workAssessments } from "@paperclipai/db";
import { FAST_RESPONSE_AGENT_GUIDANCE } from "@paperclipai/shared";
import { registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareHeartbeatTaskContext } from "../services/heartbeat/task-context.js";
import { documentService } from "../services/documents.js";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "../services/issue-continuation-summary.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { buildLowTrustSourceTrust, LOW_TRUST_QUARANTINED_BODY } from "../services/source-trust.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import * as redaction from "../redaction.js";
const withoutNativeTaskRevisions = <T,>(value: T): T => redaction.withoutNativeTaskRevisions?.(value) ?? value;
import { buildNativeContinuationPrompt, readNativeTaskSnapshot } from "../services/native-runtime/native-continuation.js";
import * as nativeContinuation from "../services/native-runtime/native-continuation.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/activity-log.js";
import { buildExecutionContinuation } from "../services/execution-continuation.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { hasCompactWakeShape } from "../services/native-runtime/compact-wake-shape.js";
import { decideNativeContinuation as nativeDecideContinuation } from "../services/native-runtime/continued-session.js";
// Keep the behavioral revert control runnable on v3, which has no raw revisions.
const withNativeTaskRevisions = (value: unknown) => nativeContinuation.withNativeTaskRevisions?.(value) ?? readNativeTaskSnapshot(value);
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping heartbeat task context tests: ${support.reason}`);

describePostgres("heartbeat task context delivered to an adapter", () => {
  const adapterType = "task_context_test";
  const captured = new Map<string, AdapterExecutionContext>();
  const inspectPreparation = new Map<string, () => void>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const visiblePrompts: Record<string, unknown> = {};

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-task-context-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "context-user", name: "Context user", email: "context-user@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        inspectPreparation.get(input.agent.id)?.();
        captured.set(input.runId, input);
        return { exitCode: 0, signal: null, timedOut: false, sessionId: "context-session", resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
    if (process.env.CONTINUITY_PROMPT_OUTPUT) await writeFile(process.env.CONTINUITY_PROMPT_OUTPUT, JSON.stringify(visiblePrompts, null, 2) + "\n");
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task context fixture", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "context-user",
      membershipRole: "member", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Context reader", adapterType, status: "idle" });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Task context fixture", description: "Assignment description canary",
      status: "todo", assigneeAgentId: agentId, responsibleUserId: "context-user", issueNumber: 1,
    });
    return { companyId, agentId, issueId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown>) {
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_assigned",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
    expect(captured.has(run!.id)).toBe(true);
    return captured.get(run!.id)!;
  }

  // Real PostgreSQL regressions for the two continuity findings: use the stock
  // task-start context, issue mutation receipts, comment provenance and committer.
  async function continuityTurn(description = "Assignment description canary", secrets: string[] = [], titleNeedsGeneration = false) {
    const f = await seed(), runId = randomUUID(), sessionId = randomUUID(), contractId = randomUUID();
    await db.update(issues).set({ status: "in_progress", description, titleNeedsGeneration }).where(eq(issues.id, f.issueId));
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "continuity",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: sessionId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId: f.issueId } }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.issueId));
    for (const secret of secrets) await createRunSecretRedactionRegistry(db).register(f.companyId, runId, secret);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const context: Record<string, unknown> = { issueId: f.issueId, executionContinuation: { version: 1, messages: [] } };
    await prepareHeartbeatTaskContext(db, { run, agent, task: { issueRef, issueContext: issueRef as never, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null } });
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(context)}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    const start = readNativeTaskSnapshot((context.paperclipIssue as Record<string, unknown>).continuationSnapshot)!;
    expect(start).not.toBeNull();
    return { ...f, runId, sessionId, contractId, start };
  }
  async function editDuringTurn(f: Awaited<ReturnType<typeof continuityTurn>>, patch: { description?: string; priority?: string }, actor: "person" | "own" | "unknown" | "other-run") {
    const updated = await issueService(db).update(f.issueId, { ...patch, actorUserId: actor === "person" ? "context-user" : null,
      actorAgentId: actor === "own" || actor === "other-run" ? f.agentId : null,
      actorRunId: actor === "own" ? f.runId : null });
    if (actor === "unknown") return;
    const otherRunId = actor === "other-run" ? randomUUID() : null;
    if (otherRunId) await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded" });
    await logActivity(db, { companyId: f.companyId, actorType: actor === "person" ? "user" : "agent",
      actorId: actor === "person" ? "context-user" : f.agentId, agentId: actor === "person" ? null : f.agentId,
      runId: actor === "own" ? f.runId : otherRunId, action: "issue.updated", entityType: "issue", entityId: f.issueId,
      details: { ...patch, changes: updated!.changes } });
  }
  async function finishContinuityTurn(f: Awaited<ReturnType<typeof continuityTurn>>) {
    const [beforeCommit] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(beforeCommit.status).toBe("in_progress");
    const resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: f.contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      contractId: f.contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: f.companyId,
      priorIssueStatus: beforeCommit.status, priorStatusVersion: beforeCommit.statusVersion, policyVersion: "continuity", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId, phase: "arbitrating", attempt: 0, resultId });
    await commitNativeStatusDecision({ db, companyId: f.companyId, issueId: f.issueId, runId: f.runId, assessmentId,
      priorStatus: beforeCommit.status, priorStatusVersion: beforeCommit.statusVersion, priorDecisionId: beforeCommit.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "in_review", toStatus: "in_review",
        reasonCode: "continuity_attribution", unblockDescriptor: null, effects: [] } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const end = run.contextSnapshot!.paperclipEndTaskSnapshot as { taskSnapshot: unknown };
    const baseline = readNativeTaskSnapshot(end.taskSnapshot)!;
    const rawCurrent = withNativeTaskRevisions(issue)!;
    const displayCurrent = (await createRunSecretRedactionRegistry(db).redactForIssue(f.companyId, f.issueId, rawCurrent))!;
    const current = { ...displayCurrent, fieldRevisions: rawCurrent.fieldRevisions };
    const wake = { reason: "issue_continuation_needed", executionContinuation: { version: 1, messages: [], resumeDelta: { baseRunId: f.runId, messages: [] } } };
    const prompt = buildNativeContinuationPrompt({ wakePayload: wake, previousWakePayload: wake, continuousPi: true, promptOnly: true,
      previousTurnDelivered: true, previousRunId: f.runId, issue, previousIssue: issue, taskSnapshot: current, previousTaskSnapshot: baseline });
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain("status: in_progress -> in_review");
    return { prompt: prompt!, baseline, current, wake, issue, receipt: end, runId: f.runId, resultId, companyId: f.companyId, issueId: f.issueId };
  }
  it("bootstraps rather than trusting legacy, foreign or missing-start baseline receipts", async () => {
    const f = await continuityTurn(), result = await finishContinuityTurn(f);
    const read = nativeContinuation.readNativeEndTaskSnapshot;
    expect(read(result.receipt, f.issueId)).toEqual(result.baseline);
    const missingStart = await continuityTurn();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: missingStart.issueId } }).where(eq(heartbeatRuns.id, missingStart.runId));
    const untrusted = await finishContinuityTurn(missingStart);
    for (const receipt of [{ issueId: f.issueId, taskSnapshot: result.current },
      { ...result.receipt, issueId: randomUUID() }, untrusted.receipt]) {
      const previousTaskSnapshot = read(receipt, f.issueId);
      expect(previousTaskSnapshot).toBeNull();
      expect(buildNativeContinuationPrompt({ wakePayload: result.wake, continuousPi: true, promptOnly: true, previousTurnDelivered: true,
        previousRunId: f.runId, issue: result.issue, previousIssue: result.issue, taskSnapshot: result.current, previousTaskSnapshot })).toBeNull();
    }
    expect(read(untrusted.receipt, missingStart.issueId)).toBeNull();
  });
  it.each(["person", "unknown", "other-run"] as const)("announces a mid-turn %s description edit, not this turn's own status move", async actor => {
    const f = await continuityTurn();
    await editDuringTurn(f, { description: "MID_TURN_PERSON_DESCRIPTION" }, actor);
    const result = await finishContinuityTurn(f);
    expect(result.prompt).toContain("description: changed\nMID_TURN_PERSON_DESCRIPTION");
    expect(result.baseline.description).toBe(f.start.description);
    if (actor === "person") visiblePrompts.midTurnPersonDescription = result;
  });
  it("announces a concurrent person priority change while suppressing attributable agent-only changes", async () => {
    const f = await continuityTurn();
    await editDuringTurn(f, { description: "OWN_DESCRIPTION" }, "own");
    await editDuringTurn(f, { priority: "urgent" }, "person");
    const result = await finishContinuityTurn(f);
    expect(result.prompt).toContain("priority: medium -> urgent");
    expect(result.prompt).not.toContain("description: changed");
    expect(result.baseline.description).toBe("OWN_DESCRIPTION");
  });
  it("does not announce agent-only field changes or replay the original brief", async () => {
    const f = await continuityTurn();
    await editDuringTurn(f, { description: "OWN_DESCRIPTION", priority: "high" }, "own");
    const result = await finishContinuityTurn(f);
    expect(result.prompt).toContain("no new messages");
    expect(result.prompt).not.toContain("no task field differs");
    expect(result.prompt).not.toContain("description: changed");
    expect(result.prompt).not.toContain("priority: medium -> high");
    visiblePrompts.repeatedWake = result;
    const [person] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "PERSON_COMMENT_AFTER_OWN_STATUS" }).returning();
    const executionContinuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [person.id] },
      previousContextRunId: f.runId, summary: null, exposeLowTrustRaw: true });
    const commentedWake = { ...result.wake, reason: "issue_commented", commentIds: [person.id], comments: [], executionContinuation };
    const prompt = buildNativeContinuationPrompt({ wakePayload: commentedWake, continuousPi: true, promptOnly: true,
      previousTurnDelivered: true, previousRunId: f.runId, issue: result.issue, previousIssue: result.issue,
      taskSnapshot: result.current, previousTaskSnapshot: result.baseline });
    expect(prompt).toContain("\n\nPERSON_COMMENT_AFTER_OWN_STATUS");
    expect(prompt).not.toContain('"messages"');
    expect(prompt).not.toContain("status: in_progress -> in_review");
    visiblePrompts.ownStatusThenPersonComment = { ...result, wake: commentedWake, prompt };
  });
  it("keeps real cumulative receipts and answered-question history on the constructor's short path", async () => {
    const f = await continuityTurn();
    await db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: { review: {
      state: "completed", operationId: "request_review", result: { status: "in_review" },
    } } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId,
      kind: "ask_user_questions", status: "answered", resolvedByUserId: "context-user", resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] }] },
      result: { version: 1, answers: [{ questionId: "scope", optionIds: ["yes"] }] } });
    const settled = await finishContinuityTurn(f);
    const [person] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "PLAIN_AFTER_REAL_HISTORY",
      sourceTrust: { preset: "standard", disposition: "promoted", promotedByActorType: "user", promotedByActorId: "context-user" } }).returning();
    for (const reviewerReturn of [false, true]) {
      if (reviewerReturn) await issueService(db).update(f.issueId, { status: "in_progress", actorUserId: "context-user" });
      const executionContinuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
        agentId: f.agentId, context: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [person.id] },
        previousContextRunId: f.runId, summary: null, exposeLowTrustRaw: true });
      expect(executionContinuation.completedActions).toEqual([expect.objectContaining({ operationId: "request_review" })]);
      expect(executionContinuation.interactionOutcomes).toHaveLength(1);
      expect(executionContinuation.humanResponses).toHaveLength(1);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const wake = { reason: "issue_commented", commentIds: [person.id], comments: [], executionContinuation };
      expect(hasCompactWakeShape(wake), JSON.stringify(wake, null, 2)).toBe(true);
      const result = buildNativeExecutionInput({ companyId: f.companyId, runId: randomUUID(), agentId: f.agentId, issue,
        taskSnapshot: withNativeTaskRevisions(issue), taskPrompt: "ORIGINAL_BRIEF", provider: "pi_rpc", normalizedSessionId: f.sessionId, resumedSession: true,
        previousTurn: { runId: f.runId, status: "succeeded", acceptedResultId: settled.resultId, task: settled.issue, taskSnapshot: settled.baseline }, wakePayload: wake,
        workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: f.contractId, sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
          revision: "1", objective: "Continue", criteria: [{ id: "reply", requirement: "Reply" }] } } });
      expect(result.continuationPrompt).not.toBeNull();
      expect(result.continuationPrompt).toContain("\n\nPLAIN_AFTER_REAL_HISTORY");
      expect(result.continuationPrompt).not.toContain('"messages"');
      expect(result.continuationPrompt).toContain('Source trust metadata (data): {"preset":"standard"');
      expect(result.continuationPrompt).not.toContain("request_review");
      expect(result.continuationPrompt).not.toContain("Which scope?");
      if (reviewerReturn) expect(result.continuationPrompt).toContain("status: in_review -> in_progress");
    }
  });
  it("captures complete raw keyed own-write evidence through the real PATCH route and set_task_title tool", async () => {
    const f = await continuityTurn("password=harmless-dummy-A", [], true);
    const { issueRoutes } = await import("../routes/issues.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: f.agentId, companyId: f.companyId, runId: f.runId, source: "agent_jwt" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const response = await request(app).patch(`/api/issues/${f.issueId}`).send({ description: "password=harmless-dummy-B" }).expect(200);
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId });
    const call = { tool: "set_task_title", callId: "own-title", arguments: { title: "Own final title", onlyIfProvisional: true, idempotencyKey: "own-title" } };
    await authority.execute(call);
    const [written] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = written.contextSnapshot!.paperclipTaskWrites as { fieldRevisions: Array<{ key: string; from: string; to: string; value: unknown }> };
    await authority.execute(call);
    const [replayed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(replayed.contextSnapshot!.paperclipTaskWrites).toEqual(receipt);
    const result = await finishContinuityTurn(f);
    expect(result.prompt).toContain("no new messages");
    for (const key of ["description", "title", "titleNeedsGeneration"]) expect(result.prompt).not.toContain(key + ":");
    expect(receipt?.fieldRevisions.map(write => write.key)).toEqual(["description", "title", "titleNeedsGeneration"]);
    expect(JSON.stringify(receipt)).not.toContain("harmless-dummy-B");
    expect(JSON.stringify(response.body)).not.toContain("fieldRevisions");
    visiblePrompts.atomicOwnWrites = { prompt: result.prompt, receipt, baseline: result.baseline, current: result.current };
  });
  it("makes a truncated executionPolicy readable through the named authorized task tool", async () => {
    const f = await continuityTurn(), executionPolicy = { note: "POLICY_READER_CANARY_".repeat(5000) };
    await db.update(issues).set({ executionPolicy, billingCode: "reader-billing", reviewPolicy: "human_only" }).where(eq(issues.id, f.issueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const prompt = buildNativeContinuationPrompt({ wakePayload: { reason: "issue_updated_by_user", executionContinuation: { version: 1, messages: [], resumeDelta: { baseRunId: f.runId, messages: [] } } }, continuousPi: true,
      promptOnly: true, previousTurnDelivered: true, previousRunId: f.runId, issue, previousIssue: issue,
      taskSnapshot: withNativeTaskRevisions(issue), previousTaskSnapshot: f.start });
    expect(prompt).toContain("executionPolicy: changed");
    expect(prompt).toContain("get_task_context({})");
    expect(prompt).not.toContain(JSON.stringify(executionPolicy));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId });
    const result = await authority.execute({ tool: "get_task_context", callId: "truncated-policy-reader", arguments: {} });
    expect(result).toMatchObject({ activeTask: { executionPolicy, billingCode: "reader-billing", reviewPolicy: "human_only",
      responsibleUserId: "context-user", conversationAgentId: null } });
    await db.insert(issues).values(Array.from({ length: 100 }, (_, i) => ({ companyId: f.companyId,
      title: `Policy child ${i}`, parentId: f.issueId, executionPolicy, billingCode: "child-billing",
      responsibleUserId: "context-user", status: "todo" })));
    const expanded = await authority.execute({ tool: "get_task_context", callId: "bounded-policy-reader", arguments: {} }) as { activeTask: unknown; childTasks: Record<string, unknown>[] };
    expect(expanded.childTasks).toHaveLength(100);
    const added = ["executionPolicy", "billingCode", "reviewPolicy", "responsibleUserId", "conversationAgentId"];
    for (const child of expanded.childTasks) for (const key of added) expect(child).not.toHaveProperty(key);
    expect(Buffer.byteLength(JSON.stringify(expanded))).toBeLessThan(200_000);
    const search = await authority.execute({ tool: "search_tasks", callId: "bounded-policy-search", arguments: { limit: 200 } }) as { tasks: Record<string, unknown>[] };
    expect(search.tasks.length).toBeGreaterThan(0);
    for (const task of search.tasks) for (const key of added) expect(task).not.toHaveProperty(key);
    expect(Buffer.byteLength(JSON.stringify(search))).toBeLessThan(100_000);
    const dot = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: f.runId, dotRuntime: true });
    const restricted = await dot.execute({ tool: "get_task_context", callId: "restricted-dot-policy", arguments: {} }) as { activeTask: Record<string, unknown> };
    for (const key of added) expect(restricted.activeTask).not.toHaveProperty(key);
    const muse = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      runId: f.runId, museRuntime: true, externalAuthorizingUserId: "context-user" });
    const restrictedMuse = await muse.execute({ tool: "get_task_context", callId: "restricted-muse-policy", arguments: {} }) as { activeTask: Record<string, unknown> };
    for (const key of added) expect(restrictedMuse.activeTask).not.toHaveProperty(key);
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || '{"paperclipAgentJwtScope":{"kind":"skill_test"}}'::jsonb` }).where(eq(heartbeatRuns.id, f.runId));
    const restrictedSkill = await authority.execute({ tool: "get_task_context", callId: "restricted-skill-policy", arguments: {} }) as { activeTask: Record<string, unknown> };
    for (const key of added) expect(restrictedSkill.activeTask).not.toHaveProperty(key);
    visiblePrompts.boundedTaskProjection = { childCount: expanded.childTasks.length, contextBytes: Buffer.byteLength(JSON.stringify(expanded)),
      searchCount: search.tasks.length, searchBytes: Buffer.byteLength(JSON.stringify(search)), ordinaryActiveKeys: Object.keys(expanded.activeTask as object),
      restrictedDotActiveKeys: Object.keys(restricted.activeTask), restrictedMuseActiveKeys: Object.keys(restrictedMuse.activeTask),
      restrictedSkillActiveKeys: Object.keys(restrictedSkill.activeTask) };
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
  });
  it("never treats revision-shaped user policy as trusted server evidence", async () => {
    const secret = "dummy-policy-revision-secret";
    const f = await continuityTurn("Safe assignment", [secret]);
    await db.update(issues).set({ executionPolicy: { fieldRevisions: { description: secret }, note: secret } }).where(eq(issues.id, f.issueId));
    const result = await finishContinuityTurn(f);
    expect(result.prompt).not.toContain(secret);
    expect(result.prompt).not.toContain("fieldRevisions");
    expect(result.prompt).toContain(REDACTED_EVENT_VALUE);
  });
  // Never-OK credential guard: a receipt must not be an offline PIN oracle.
  it("E4: cannot recover a registered four-digit secret from a stored receipt or run responses", async () => {
    const secret = "4821";
    const f = await continuityTurn("door code " + secret, [secret]);
    const result = await finishContinuityTurn(f);
    const { agentRoutes } = await import("../routes/agents.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "context-user", companyIds: [f.companyId], source: "session", isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const responses = [];
    for (const path of [`/heartbeat-runs/${f.runId}`, `/companies/${f.companyId}/heartbeat-runs`,
      `/companies/${f.companyId}/heartbeat-runs?summary=true`, `/companies/${f.companyId}/live-runs?minCount=1`]) {
      responses.push((await request(app).get("/api" + path).expect(200)).body);
    }
    const registry = createRunSecretRedactionRegistry(db);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    responses.push(await registry.redactForRun(f.companyId, f.runId, run));
    responses.push(await registry.redactForRuns(f.companyId, [run]));
    responses.push((await registry.redactorForRun(f.companyId, f.runId))(run));
    const disclosed = JSON.stringify(responses);
    const attackInput = JSON.stringify({ receipt: result.receipt, responses });
    const recovered: string[] = [];
    for (let pin = 0; pin < 10000; pin++) {
      const candidate = String(pin).padStart(4, "0");
      for (const raw of [candidate, JSON.stringify(candidate), JSON.stringify("door code " + candidate)]) {
        if (attackInput.includes(createHash("sha256").update(raw).digest("hex"))) recovered.push(candidate);
      }
    }
    expect(recovered, "offline dictionary attack over all 10,000 PINs").toEqual([]);
    expect(disclosed).not.toContain("fieldRevisions");
    expect(disclosed).not.toContain(secret);
    expect(result.baseline.description).toBe("door code " + REDACTED_EVENT_VALUE);
    visiblePrompts.E4 = { runId: f.runId, receipt: result.receipt, responses, recovered };
  });
  it.each(["person", "own"] as const)("compares raw revisions across redaction collisions (%s edit)", async actor => {
    const secretA = "registered-continuity-canary-A", secretB = "registered-continuity-canary-B";
    const f = await continuityTurn("Use " + secretA, [secretA, secretB]);
    await editDuringTurn(f, { description: "Use " + secretB }, actor);
    const result = await finishContinuityTurn(f);
    expect(result.current.description).toBe(result.baseline.description);
    if (actor === "person") expect(result.prompt).toContain("description: changed\nUse " + REDACTED_EVENT_VALUE);
    else expect(result.prompt).not.toContain("description: changed");
    expect(result.prompt).not.toContain(secretA);
    expect(result.prompt).not.toContain(secretB);
    expect(result.prompt).not.toContain("fieldRevisions");
  });
  it.each(["person-first", "own-first"] as const)("never absorbs another actor's same-field edit (%s)", async order => {
    const f = await continuityTurn();
    if (order === "person-first") await editDuringTurn(f, { description: "PERSON_FIRST" }, "person");
    await editDuringTurn(f, { description: "OWN_DESCRIPTION" }, "own");
    if (order === "own-first") await editDuringTurn(f, { description: "PERSON_LAST" }, "person");
    const result = await finishContinuityTurn(f);
    expect(result.prompt).toContain("description: changed\n" + (order === "person-first" ? "OWN_DESCRIPTION" : "PERSON_LAST"));
  });
  it.each(["edited", "deleted"] as const)("retains an own previous-turn reply's later %s revision from the stock delta", async revision => {
    const f = await continuityTurn();
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: f.runId, body: "ORIGINAL_OWN_REPLY" }).returning();
    const settled = await finishContinuityTurn(f);
    const updatedAt = new Date(Date.now() + 1000);
    await db.update(issueComments).set(revision === "edited" ? { body: "LATER_EDITED_OWN_REPLY", updatedAt }
      : { deletedAt: updatedAt, deletedByType: "user", deletedByUserId: "context-user", updatedAt }).where(eq(issueComments.id, reply.id));
    const [person] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "PERSON_AFTER_REPLY_REVISION" }).returning();
    const executionContinuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [person.id] },
      previousContextRunId: f.runId, summary: null, exposeLowTrustRaw: true });
    const message = executionContinuation.resumeDelta!.messages.find(entry => entry.id === reply.id)!;
    expect(message).toMatchObject({ createdByRunId: f.runId, deleted: revision === "deleted" });
    expect(message.updatedAt).not.toBe(message.createdAt);
    const wake = { reason: "issue_commented", commentIds: [person.id], comments: [], executionContinuation };
    const decision = nativeDecideContinuation({ provider: "pi_rpc", hasSession: true, agentId: f.agentId, previousRunId: f.runId, wakePayload: wake });
    expect(decision).toEqual({ continue: true, promptOnly: false });
    const prompt = buildNativeContinuationPrompt({ wakePayload: wake, continuousPi: true, promptOnly: decision.promptOnly,
      previousTurnDelivered: true, previousRunId: f.runId, agentId: f.agentId, issue: settled.issue, previousIssue: settled.issue,
      taskSnapshot: settled.current, previousTaskSnapshot: settled.baseline });
    expect(prompt).toContain(reply.id);
    expect(prompt).toContain(person.body);
    if (revision === "edited") expect(prompt).toContain("LATER_EDITED_OWN_REPLY");
    else expect(prompt).toContain('"deleted":true');
    visiblePrompts[revision + "OwnReply"] = { prompt, decision, message };
  });
  it.each(["own-turn", "other-session", "unattributable"] as const)("uses stock comment run provenance for a same-agent %s reply", async source => {
    const f = await continuityTurn(), otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      runtimeMode: "native", nativeIssueId: f.issueId, nativeSessionId: randomUUID() });
    const commentRunId = source === "own-turn" ? f.runId : source === "other-session" ? otherRunId : null;
    const [reply] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: commentRunId, body: "SAME_AGENT_REPLY_" + source }).returning();
    const settled = await finishContinuityTurn(f);
    const [person] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "NEXT_PERSON_MESSAGE" }).returning();
    const context = { issueId: f.issueId, wakeReason: "issue_reopened_via_comment", wakeCommentIds: [person.id] };
    const executionContinuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context, previousContextRunId: f.runId, summary: null, exposeLowTrustRaw: true });
    expect(executionContinuation.resumeDelta!.messages.find(message => message.id === reply.id)?.createdByRunId).toBe(commentRunId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    // Exercise the retained-input projection with the real stock DB delta.
    // Full comment presentation metadata has its separate full-framing guard.
    const wake = { reason: context.wakeReason, executionContinuation, commentIds: [person.id], comments: [] };
    const execution = buildNativeExecutionInput({ companyId: f.companyId, runId: randomUUID(), agentId: f.agentId, issue,
      taskSnapshot: settled.current, taskPrompt: "ORIGINAL_BRIEF", provider: "pi_rpc", normalizedSessionId: f.sessionId, resumedSession: true,
      previousTurn: { runId: f.runId, status: "succeeded", acceptedResultId: settled.resultId, task: issue, taskSnapshot: settled.baseline }, wakePayload: wake,
      workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null }, runtimeContext: nativeRuntimeContextFixture(),
      completionContract: { id: f.contractId, sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1", contract: {
        revision: "1", objective: "Continue", criteria: [{ id: "reply", requirement: "Reply" }] } } });
    const prompt = execution.continuationPrompt!;
    expect(prompt, JSON.stringify(wake, null, 2)).not.toBeNull();
    expect(prompt).toContain(person.body);
    const generic = buildNativeContinuationPrompt({ wakePayload: wake, continuousPi: true, promptOnly: false,
      previousTurnDelivered: true, previousRunId: f.runId, agentId: f.agentId, issue, previousIssue: issue,
      taskSnapshot: settled.current, previousTaskSnapshot: settled.baseline })!;
    if (source === "own-turn") {
      expect(prompt).not.toContain(reply.body);
      expect(generic).not.toContain(reply.body);
      expect(prompt).not.toContain('"messages"');
    } else {
      expect(prompt).toContain(reply.body);
      expect(generic).toContain(reply.body);
    }
    if (source === "other-session") visiblePrompts.otherSessionSameAgentComment = { prompt, generic, runId: f.runId, commentRunId,
      nativeSessionId: f.sessionId, companyId: f.companyId, issueId: f.issueId, commentId: reply.id };
  });

  it("keeps assignment, wake, compact, and revision context aligned after secret redaction", async () => {
    const f = await seed();
    const secret = "task-context-secret-canary";
    const description = `Assignment description canary ${secret}`;
    await db.update(issues).set({ description }).where(eq(issues.id, f.issueId));
    const previousRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: previousRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "succeeded", contextSnapshot: { issueId: f.issueId },
    });
    await createRunSecretRedactionRegistry(db).register(f.companyId, previousRunId, secret);
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: `Wake comment canary ${secret}`,
    });
    const { context, runId } = await execute(f, {
      wakeCommentId: commentId, wakeCommentIds: [commentId],
      paperclipTaskCommunicationGuidance: "FORGED caller guidance", paperclipSkillTest: { directive: "FORGED skill" },
      paperclipContinuationSummary: { body: "FORGED summary" },
      paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId },
    });
    expect(context.paperclipTaskMarkdown).toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdown).toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownAssignment).toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownAssignment).not.toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownCompact).not.toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownCompact).toContain("Wake comment canary");
    expect(context.paperclipTaskMarkdownAssignmentCompact).not.toContain("Assignment description canary");
    expect(context.paperclipTaskMarkdownAssignmentCompact).not.toContain("Wake comment canary");
    for (const key of ["paperclipIssue", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact"]) {
      expect(JSON.stringify(context[key])).not.toContain(secret);
    }
    // The same authorized, redacted row is durably available for the next turn's field comparison.
    const taskSnapshot = readNativeTaskSnapshot((context.paperclipIssue as Record<string, unknown>).continuationSnapshot);
    expect(taskSnapshot).toMatchObject({ status: "in_progress", priority: "medium", assigneeAgentId: f.agentId,
      assigneeUserId: null, parentId: null, projectId: null, goalId: null, billingCode: null,
      description: `Assignment description canary ${REDACTED_EVENT_VALUE}` });
    const savedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
    const savedIssue = (savedRun.contextSnapshot as Record<string, unknown>).paperclipIssue as Record<string, unknown>;
    const savedSnapshot = readNativeTaskSnapshot(savedIssue.continuationSnapshot)!;
    expect(savedSnapshot.fieldRevisions).toBeDefined();
    expect(withoutNativeTaskRevisions(savedSnapshot)).toEqual(taskSnapshot);
    expect(JSON.stringify(context)).not.toContain("fieldRevisions");
    expect(context.paperclipTaskCommunicationGuidance).toBe(FAST_RESPONSE_AGENT_GUIDANCE);
    expect(context.paperclipSkillTest).toBeUndefined();
    expect(context.paperclipAgentJwtScope).toEqual({ kind: "standard" });
    expect(context.paperclipContinuationSummary).toBeUndefined();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    expect(context.paperclipTurnContext).toMatchObject({
      version: 1,
      assignment: { owner: "task_markdown", description: { id: f.issueId, revision: digest(`Assignment description canary ${REDACTED_EVENT_VALUE}`) } },
      events: { owner: "wake_prompt", comments: [{ id: commentId, revision: digest(`Wake comment canary ${REDACTED_EVENT_VALUE}`) }] },
    });
  });

  it("reads selected comments once for both wake projections", async () => {
    const f = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "selected wake canary",
    });
    const select = vi.spyOn(db, "select");
    inspectPreparation.set(f.agentId, () => {
      const commentReads = select.mock.calls.filter(([projection]) => projection
        && projection.body === issueComments.body && projection.id === issueComments.id && projection.deletedAt === issueComments.deletedAt);
      expect(commentReads).toHaveLength(1);
    });
    try {
      const { context } = await execute(f, { wakeCommentId: commentId, wakeCommentIds: [commentId] });
      expect(context.paperclipWakeComment).toMatchObject({ id: commentId, body: "selected wake canary" });
      expect(context.paperclipWake).toMatchObject({ comments: [{ id: commentId, body: "selected wake canary" }] });
    } finally {
      inspectPreparation.delete(f.agentId);
      select.mockRestore();
    }
  });

  it("cancels deleted-only queued comments before adapter dispatch", async () => {
    const f = await seed(), commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "discarded wake", deletedAt: new Date() });
    const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] } });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await heartbeat.getRun(run!.id);
    expect(finished).toMatchObject({ status: "cancelled", error: "Queued messages were discarded before dispatch" });
    expect(captured.has(run!.id)).toBe(false);
  });

  it("preserves deleted comment metadata without delivering its body", async () => {
    const f = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "context-user", body: "deleted wake canary", deletedAt: new Date(),
      presentation: { kind: "system_notice", tone: "info", detailsDefaultOpen: false }, metadata: { version: 1, sections: [] } });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const context: Record<string, unknown> = { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] };
    await prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef, issueContext: null, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
    });
    expect(context.paperclipWakeComment).toMatchObject({ id: commentId, body: "", presentation: null, metadata: null });
    expect(context.paperclipWake).toMatchObject({ comments: [{ id: commentId, body: "", presentation: null, metadata: null }] });
    expect(context.paperclipTaskMarkdown).not.toContain("deleted wake canary");
  });

  it.each([false, true])("uses admitted skill-test scope when recovery is %s", async (recovering) => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const context: Record<string, unknown> = { issueId: f.issueId, paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issueId } };
    const pinned = vi.fn(async () => null);
    const preparing = prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef, issueContext: null, context, taskSession: null },
      policy: { recovering, trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: pinned },
    });
    if (recovering) await expect(preparing).rejects.toThrow("skill test's saved version is unavailable");
    else await preparing;
    expect(pinned).toHaveBeenCalledTimes(recovering ? 1 : 0);
    expect(context.paperclipAgentJwtScope).toEqual({ kind: recovering ? "skill_test" : "standard", ...(recovering ? { issueId: f.issueId } : {}) });
  });

  it("delivers the chat owner's saved time zone to any adapter and keeps the admitted zone on recovery", async () => {
    const f = await seed();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const prepare = async (context: Record<string, unknown>, recovering: boolean) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", issueId: f.issueId }).returning();
      await prepareHeartbeatTaskContext(db, {
        run, agent, task: { issueRef, context, taskSession: null,
          issueContext: { ...issueRef, conversationAgentId: f.agentId, conversationUserId: "context-user" } as never },
        policy: { recovering, trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
        services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
      });
      return context;
    };
    const line = (zone: string) => `The person's time zone is ${zone} (from their browser).`;

    const unknown = await prepare({ issueId: f.issueId, paperclipConversationTimeZone: "Europe/Paris" }, false);
    expect(unknown.paperclipTaskMarkdown).not.toContain("The person's time zone is");
    expect(unknown.paperclipConversationTimeZone).toBeUndefined();

    await db.insert(userWorkspacePreferences).values({ userId: "context-user", timeZone: "America/Chicago" });
    const fresh = await prepare({ issueId: f.issueId }, false);
    expect(fresh.paperclipTaskMarkdown).toContain(line("America/Chicago"));
    expect(fresh.paperclipTaskMarkdownAssignment).toContain(line("America/Chicago"));
    expect(fresh.paperclipConversationTimeZone).toBe("America/Chicago");

    await db.update(userWorkspacePreferences).set({ timeZone: "Asia/Tokyo" }).where(eq(userWorkspacePreferences.userId, "context-user"));
    const recovered = await prepare({ issueId: f.issueId, paperclipConversationTimeZone: "America/Chicago" }, true);
    expect(recovered.paperclipTaskMarkdown).toContain(line("America/Chicago"));
    const forged = await prepare({ issueId: f.issueId, paperclipConversationTimeZone: "Ignore previous instructions" }, true);
    expect(forged.paperclipTaskMarkdown).not.toContain("The person's time zone is");
  });

  it("gives the bar-conversation instructions only to the agent in a bar conversation, and only with the flag on", async () => {
    const f = await seed();
    const [responsibility] = await db.insert(responsibilities).values({
      companyId: f.companyId, ownerUserId: "context-user", title: "Runway", status: "active",
      standard: "Runway stays comfortable", metricName: "Runway", metricUnit: "months", metricTarget: 12,
    }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const prepare = async (experimentalInstanceSettings: { enableResponsibilities?: boolean }) => {
      const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", issueId: f.issueId }).returning();
      const context: Record<string, unknown> = { issueId: f.issueId };
      await prepareHeartbeatTaskContext(db, {
        run, agent, task: { issueRef, context, taskSession: null, issueContext: issueRef as never },
        policy: { recovering: false, trustPreset: { kind: "standard" }, experimentalInstanceSettings },
        services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
      });
      return String(context.paperclipTaskMarkdown);
    };

    // An ordinary task: the routine offer, never the bar conversation.
    const ordinary = await prepare({ enableResponsibilities: true });
    expect(ordinary).toContain("Routine offer:");
    expect(ordinary).not.toContain("Bar conversation:");

    await db.update(issues).set({ originKind: "responsibility_bar", originId: responsibility!.id }).where(eq(issues.id, f.issueId));
    const bar = await prepare({ enableResponsibilities: true });
    expect(bar).toContain("Bar conversation:");
    expect(bar).toContain("- Title: Runway");
    expect(bar).toContain(`POST /api/issues/${f.issueId}/bar-proposals`);
    expect(bar).not.toContain("Routine offer:");
    expect(await prepare({})).not.toContain("Bar conversation:");

    // An automation conversation about another task carries its own block, never the routine offer.
    const [source] = await db.insert(issues).values({ id: randomUUID(), companyId: f.companyId, title: "Triage new support tickets", issueNumber: 7 }).returning();
    await db.update(issues).set({ originKind: "automation_conversation", originId: source!.id }).where(eq(issues.id, f.issueId));
    const automation = await prepare({ enableResponsibilities: true });
    expect(automation).toContain("Automation conversation:");
    expect(automation).toContain("- Title: Triage new support tickets");
    expect(automation).toContain(`POST /api/issues/${f.issueId}/automation-proposals`);
    expect(automation).not.toContain("Routine offer:");
    expect(await prepare({})).not.toContain("Automation conversation:");
  });

  it("gives the dashboard-conversation instructions only on a dashboard conversation, by mode, and only with the flag on", async () => {
    const f = await seed();
    await db.insert(responsibilities).values({ companyId: f.companyId, ownerUserId: "context-user", title: "Every LP hears from us monthly.", status: "active" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const prepare = async (experimentalInstanceSettings: { enableResponsibilities?: boolean }) => {
      const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", issueId: f.issueId }).returning();
      const context: Record<string, unknown> = { issueId: f.issueId };
      await prepareHeartbeatTaskContext(db, {
        run, agent, task: { issueRef, context, taskSession: null, issueContext: issueRef as never },
        policy: { recovering: false, trustPreset: { kind: "standard" }, experimentalInstanceSettings },
        services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
      });
      return String(context.paperclipTaskMarkdown);
    };
    expect(await prepare({ enableResponsibilities: true })).not.toContain("Dashboard conversation:");

    await db.update(issues).set({ originKind: "responsibility_dashboard", originId: "context-user", originFingerprint: "create" }).where(eq(issues.id, f.issueId));
    const create = await prepare({ enableResponsibilities: true });
    expect(create).toContain("Dashboard conversation:");
    expect(create).toContain("How to hold the conversation (create):");
    expect(create).toContain("Every LP hears from us monthly.");
    expect(create).toContain(`POST /api/issues/${f.issueId}/dashboard-changes`);
    expect(create).not.toContain("Routine offer:");
    expect(await prepare({})).not.toContain("Dashboard conversation:");

    await db.update(issues).set({ originFingerprint: "edit" }).where(eq(issues.id, f.issueId));
    const edit = await prepare({ enableResponsibilities: true });
    expect(edit).toContain("How to hold the conversation (edit):");
    expect(edit).not.toContain("How to hold the conversation (create):");
  });

  it("gives the status-update instructions on a status request, and a short reminder on other work the agent reports on", async () => {
    const f = await seed();
    const [responsibility] = await db.insert(responsibilities).values({
      companyId: f.companyId, ownerUserId: "context-user", title: "Site performance", status: "active",
      standard: "Product pages load in under 2 seconds", metricName: "LCP p75", metricUnit: "s", metricTarget: 2, metricDirection: "at_most",
    }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const prepare = async (experimentalInstanceSettings: { enableResponsibilities?: boolean }) => {
      const [issueRef] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        status: "running", issueId: f.issueId }).returning();
      const context: Record<string, unknown> = { issueId: f.issueId };
      await prepareHeartbeatTaskContext(db, {
        run, agent, task: { issueRef, context, taskSession: null, issueContext: issueRef as never },
        policy: { recovering: false, trustPreset: { kind: "standard" }, experimentalInstanceSettings },
        services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
      });
      return String(context.paperclipTaskMarkdown);
    };

    // Not under the responsibility: nothing about its status.
    expect(await prepare({ enableResponsibilities: true })).not.toContain("Responsibility status:");

    // Filed under it, and this agent is the only one working there: the reminder, next to the routine offer.
    await db.insert(responsibilityLinks).values({ companyId: f.companyId, responsibilityId: responsibility!.id, issueId: f.issueId });
    const ordinary = await prepare({ enableResponsibilities: true });
    expect(ordinary).toContain("Responsibility status:");
    expect(ordinary).toContain(`"Site performance" (id ${responsibility!.id})`);
    expect(ordinary).toContain("Routine offer:");
    expect(ordinary).not.toContain("Status update:");
    expect(await prepare({})).not.toContain("Responsibility status:");

    // A status update request: the full instructions, no reminder, never a routine offer.
    await db.update(issues).set({ originKind: "responsibility_status_update", originId: responsibility!.id }).where(eq(issues.id, f.issueId));
    const update = await prepare({ enableResponsibilities: true });
    expect(update).toContain("Status update:");
    expect(update).toContain("- Title: Site performance");
    expect(update).toContain(`POST /api/responsibilities/${responsibility!.id}/status-report`);
    expect(update).not.toContain("Responsibility status:");
    expect(update).not.toContain("Routine offer:");
    expect(await prepare({})).not.toContain("Status update:");
  });

  it("lists the agent's active standing checks on a timer wake with no task, only while the experiment is on", async () => {
    const f = await seed();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [routine] = await db.insert(routines).values({ companyId: f.companyId, title: "Chase overdue invoices",
      description: "Remind customers whose invoice is a week late.", assigneeAgentId: f.agentId, status: "active" }).returning();
    await db.insert(routineTriggers).values({ companyId: f.companyId, routineId: routine!.id, kind: "heartbeat" });
    const prepare = async (wakeReason: string, experimentalInstanceSettings: { enableResponsibilities?: boolean }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
      const context: Record<string, unknown> = { wakeReason };
      await prepareHeartbeatTaskContext(db, {
        run, agent: agent!, task: { issueRef: null, issueContext: null, context, taskSession: null },
        policy: { recovering: false, trustPreset: { kind: "standard" }, experimentalInstanceSettings },
        services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
      });
      return context;
    };
    const timer = await prepare("heartbeat_timer", { enableResponsibilities: true });
    expect(timer.paperclipTaskMarkdown).toContain("Standing checks:");
    expect(timer.paperclipTaskMarkdown).toContain(`1. Chase overdue invoices (routine ${routine!.id})`);
    expect(timer.paperclipTaskMarkdownAssignment).toContain("Chase overdue invoices");
    expect(timer.paperclipTaskMarkdown).not.toMatch(/^null/);
    // Not on other wakes, not with the experiment off, and a wake with no task never reads "null".
    const other = await prepare("issue_assigned", { enableResponsibilities: true });
    expect(other.paperclipTaskMarkdown).toBeUndefined();
    const off = await prepare("heartbeat_timer", {});
    expect(off.paperclipTaskMarkdown).toBeUndefined();
    // Paused checks are not listed.
    await db.update(routines).set({ status: "paused" }).where(eq(routines.id, routine!.id));
    expect((await prepare("heartbeat_timer", { enableResponsibilities: true })).paperclipTaskMarkdown).toBeUndefined();
  });

  it("retains the context issue scope when no issue reference is available", async () => {
    const f = await seed();
    const otherIssueId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Other issue", issueNumber: 2 });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: otherIssueId,
      authorType: "user", authorUserId: "context-user", body: "other issue canary" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", issueId: f.issueId }).returning();
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const context: Record<string, unknown> = { issueId: f.issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] };
    await prepareHeartbeatTaskContext(db, {
      run, agent, task: { issueRef: null, issueContext: null, context, taskSession: null },
      policy: { trustPreset: { kind: "standard" }, experimentalInstanceSettings: {} },
      services: { issuesSvc: { getAncestors: async () => [] }, getPinnedSkillTestContext: async () => null },
    });
    expect(JSON.stringify(context.paperclipWake)).not.toContain("other issue canary");
    expect(context.paperclipWakeComment).toBeUndefined();
  });

  it("quarantines low-trust summaries and comments before preparing higher-trust prompts", async () => {
    const f = await seed();
    const sourceTrust = buildLowTrustSourceTrust({ issueId: f.issueId });
    await documentService(db).upsertIssueDocument({
      issueId: f.issueId, key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, format: "markdown",
      body: "QUARANTINED summary canary", sourceTrust,
    });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "QUARANTINED comment canary", sourceTrust,
    });
    const { context } = await execute(f, { wakeCommentId: commentId, wakeCommentIds: [commentId] });
    expect(context.paperclipContinuationSummary).toMatchObject({ body: LOW_TRUST_QUARANTINED_BODY });
    expect(context.paperclipWakeComment).toMatchObject({ body: LOW_TRUST_QUARANTINED_BODY, presentation: null, metadata: null });
    expect(context.paperclipTaskMarkdown).toContain(LOW_TRUST_QUARANTINED_BODY);
    for (const key of ["paperclipContinuationSummary", "executionContinuation", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact", "paperclipWakePayload"]) {
      expect(JSON.stringify(context[key]) ?? "").not.toContain("QUARANTINED");
    }
  });

  it("excludes a wake comment from another company and replaces caller-supplied prompt fields", async () => {
    const f = await seed();
    const other = await seed();
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: other.companyId, issueId: other.issueId, authorType: "user", authorUserId: "other-user",
      body: "OTHER COMPANY private comment",
    });
    const ownCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: ownCommentId, companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "context-user",
      body: "Authorized wake comment",
    });
    const { context } = await execute(f, {
      wakeCommentId: ownCommentId, wakeCommentIds: [ownCommentId, commentId],
      paperclipWakeComment: { body: "FORGED comment" }, paperclipTaskMarkdown: "FORGED prompt",
      paperclipTaskMarkdownAssignment: "FORGED assignment", paperclipTaskMarkdownCompact: "FORGED compact",
      paperclipTaskMarkdownAssignmentCompact: "FORGED compact assignment",
    });
    expect(context.paperclipWakeComment).toMatchObject({ id: ownCommentId, body: "Authorized wake comment" });
    expect(context.paperclipTaskMarkdown).toContain("Assignment description canary");
    for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownCompact", "paperclipTaskMarkdownAssignmentCompact", "paperclipWakePayload"]) {
      expect(JSON.stringify(context[key]) ?? "").not.toContain("FORGED");
      expect(JSON.stringify(context[key]) ?? "").not.toContain("OTHER COMPANY");
    }
    expect(context.paperclipTurnContext).toMatchObject({ events: { comments: [{ id: ownCommentId }] } });
  });

  it("clears stale wake comments and continuation data when the task has none", async () => {
    const f = await seed();
    const { context } = await execute(f, {
      paperclipWakeComment: { body: "FORGED comment" },
      paperclipContinuationSummary: { body: "FORGED summary" },
      paperclipSkillTest: { directive: "FORGED skill" },
      paperclipTurnContext: { events: { comments: [{ id: "FORGED comment" }] } },
    });
    expect(context.paperclipWakeComment).toBeUndefined();
    expect(context.paperclipContinuationSummary).toBeUndefined();
    expect(context.paperclipSkillTest).toBeUndefined();
    expect(context.paperclipTurnContext).toMatchObject({ events: { comments: [] } });
  });
});
