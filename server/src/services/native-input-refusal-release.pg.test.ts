// Keep reason: real-PG regression for held deferred wakes bypassing admission and losing wake-only content.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issueComments, issues, agentWakeupRequests, nativeRunFinalizations, issueRecoveryActions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { buildPaperclipWakePayload } from "./heartbeat/run-preparation.js";
import { buildNativeExecutionInput, budgetNativeFreshFallback } from "./native-runtime/native-execution-input.js";
import * as inputBudget from "./native-runtime/native-execution-input.js";
import * as inputRefusal from "./native-input-refusal.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget, nativeToolContractVersionForProfile } from "./native-runtime/native-session-resume.js";
import { buildNativeContinuationPrompt } from "./native-runtime/native-continuation.js";
import { nativeRuntimeContextFixture } from "./native-runtime/runtime-context.test-fixture.js";
import { nativeInputRevision } from "./native-runtime/native-turn-budget.js";
import { commandEnvelopeBytes, NativeTurnPromptExceedsCommandBoundError } from "./native-runtime/native-turn-budget.js";
import { buildNativeModelEnvelope } from "../vendor/paperclip-runner/index.js";
import { readSavedAutomaticWakes } from "./native-runtime/saved-automatic-wakes.js";
import { nativeInputRefusalEvidence, hasUnchangedNativeInputRefusal } from "./native-input-refusal.js";
import { createPostgresWakeQueueAdapter, createWakeAdmissionReader } from "../modules/wake-queue/adapters/postgres.js";
import { issueService } from "./issues.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { recoveryService } from "./recovery/service.js";
import { PaperclipRunnerToolAuthority } from "./native-runtime/paperclip-runner-tool-authority.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
function nativeInput(f: Awaited<ReturnType<typeof fixture>>, runId: string, wakePayload: unknown, taskPrompt = "Answer the repaired task.") {
  return { companyId: f.company.id, agentId: f.agent.id, runId,
    issue: { ...f.issue, workMode: "standard" }, taskPrompt, wakePayload, provider: "pi_rpc" as const,
    boundCommandBytes: true, normalizedSessionId: null,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    runtimeContext: nativeRuntimeContextFixture(), completionContract: { id: "contract", sha256: "a".repeat(64),
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } } };
}
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("refusal-release-"); db = createDb(database.connectionString); }, 120000);
afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
async function fixture(runtimeMode: "native" | "legacy" = "legacy", realRecovery = false) {
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
  }), recovery: {
    escalateStrandedAssignedIssue: async input => {
      if (!realRecovery) return;
      // Same full-row reload as heartbeat's production recovery port; the
      // module snapshot intentionally does not contain recovery's CAS fields.
      const [issueRow] = await db.select().from(issues).where(and(eq(issues.companyId, input.issue.companyId), eq(issues.id, input.issue.id)));
      const [runRow] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.latestRun.companyId), eq(heartbeatRuns.id, input.latestRun.id)));
      await recoveryService(db, { enqueueWakeup: async () => { throw new Error("unexpected recovery wake"); } }).escalateStrandedAssignedIssue({ issue: issueRow, latestRun: runRow, previousStatus: input.previousStatus });
    },
    escalateStrandedRecoveryIssueInPlace: async () => undefined,
  } });
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
// Never OK: deploying an additive tool must not reset a held conversation.
it.each([
  ["pi_rpc", "local", "v19"], ["codex", "remote", "v19"], ["opencode", "remote", "v19"],
  ["pi_rpc", "local", "v20"], ["codex", "remote", "v20"], ["opencode", "remote", "v20"],
  ["pi_rpc", "local", "new"], ["codex", "remote", "new"], ["opencode", "remote", "new"],
] as const)("V17 %s %s %s held-wake catalog keeps the conversation and delivers its saved events", async (provider, target, version) => {
  const f = await fixture();
  for (let n = 0; n < 2; n++) await f.wake("issue_children_completed", { childSummary: `UPGRADE-SAVED-${n}-` + "y".repeat(20_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, agentId: f.agent.id, runId: next.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const sessionId = randomUUID();
  const prior = buildNativeExecutionInput({ ...nativeInput(f, f.run.id, {}), provider, model: "provider/model", normalizedSessionId: sessionId });
  const deployedV19Fingerprint = target === "local"
    ? "sha256:2365e29c560a199f396c638003cf4f3c3b55ca3ce0fbc498d07754950a66659d"
    : provider === "opencode" ? "sha256:310dd0367d7157669e9fbf4c41698372a9977ef94183330317167fe07a8987cb"
      : "sha256:07b116cd7f04b0c9a53b87818a910be32682d5df6181c2019cb1ba8e0077be99";
  const previousRun = { ...f.run, nativeSessionId: sessionId, runnerProfileJson: {
    nativeToolContractFingerprint: version === "v19" ? deployedV19Fingerprint : nativeToolContractFingerprintForTarget(target, provider), nativeExecutionInput: prior,
    sessionCheckpoint: { backendKind: "runner", driverKind: prior.session.driverKind, sessionId: "held-provider-conversation", providerSessionId: "held-provider-conversation",
      identity: { runId: f.run.id, companyId: f.company.id, agentId: f.agent.id, issueId: f.issue.id, sessionId }, cursor: "old", activeTurnId: null, pendingRuntimeRequests: [] },
  } };
  const snapshot = structuredClone(previousRun);
  const modes: boolean[] = [];
  const selected = buildNativeExecutionWithCheckpoint({ previousRun: version === "new" ? null : previousRun,
    normalizedSessionId: sessionId, executionTargetKind: target, sessionContinuity: "continuous", toolRefreshOnResume: true,
    buildExecution: options => {
      modes.push(options.resumedSession);
      return buildNativeExecutionInput({ ...nativeInput(f, next.id, { ...payload,
        executionContinuation: { version: 1, companyId: f.company.id, issueId: f.issue.id, objective: "Answer", objectiveSource: { kind: "description", id: f.issue.id, revision: "1" },
          trigger: { reason: "issue_children_completed", interactionId: null, sourceRunId: f.run.id }, originCommentIds: [], messages: [], completedActions: [], humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null }, resumeDelta: { baseRunId: f.run.id, messages: [] } } }),
        provider, model: "provider/model", ...options, sessionContinuity: "continuous", previousTurn: { runId: f.run.id, task: f.issue } });
    },
  });
  expect(previousRun).toEqual(snapshot);
  if (version !== "new") {
    expect(selected.normalizedSessionId).toBe(sessionId);
    expect(selected.checkpoint).toMatchObject({ sessionId: "held-provider-conversation", identity: { runId: next.id } });
    expect(modes).toEqual([true]);
    expect("continuationPrompt" in selected.execution && selected.execution.continuationPrompt).toBeTruthy();
  } else expect(selected.checkpoint).toBeNull();
  expect(nativeToolContractFingerprintForTarget(target, provider, "v19")).toBe(deployedV19Fingerprint);
  const selectedVersion = version === "v19" ? "v19" : "v20";
  expect(selected.nativeToolContractVersion).toBe(selectedVersion);
  const fingerprint = nativeToolContractFingerprintForTarget(target, provider, selected.nativeToolContractVersion);
  await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id, nativeSessionId: selected.normalizedSessionId, status: "running", startedAt: new Date(),
    runnerProfileJson: { nativeToolContractFingerprint: fingerprint, nativeExecutionInput: selected.execution } }).where(eq(heartbeatRuns.id, next.id));
  await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.issue.id));
  const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id));
  expect(nativeToolContractVersionForProfile(persisted.runnerProfileJson, target, provider)).toBe(selectedVersion);
  const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id, runId: next.id,
    savedAutomaticWakeReaderAvailable: nativeToolContractVersionForProfile(persisted.runnerProfileJson, target, provider) !== "v19" });
  const advertised = authority.definitions().some(tool => tool.name === "read_saved_automatic_wakes");
  expect(advertised).toBe(version !== "v19");
  const prompt = version === "new" ? selected.execution.task.prompt : ("continuationPrompt" in selected.execution ? selected.execution.continuationPrompt! : "");
  if (version === "v19") {
    expect(prompt).not.toContain("read_saved_automatic_wakes");
    expect(selected.execution.task.prompt).not.toContain("read_saved_automatic_wakes");
    expect(prompt).toContain("UPGRADE-SAVED-0-"); expect(prompt).toContain("UPGRADE-SAVED-1-");
    await expect(authority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: {} })).rejects.toThrow("saved_automatic_wakes_reader_not_declared");
  } else {
    expect(prompt).toContain("read_saved_automatic_wakes");
    expect(await authority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: {} })).toMatchObject({ eventCount: 2, offset: 0 });
  }
  const bytes = commandEnvelopeBytes(version !== "new"
    ? buildNativeModelEnvelope(selected.execution, { resumedSession: true })
    : buildNativeModelEnvelope(selected.execution));
  expect(bytes).toBeLessThanOrEqual(500_000);
  console.info(JSON.stringify({ row: "V17-upgrade", provider, target, version, sessionIdBefore: sessionId, sessionIdAfter: selected.normalizedSessionId,
    checkpointRebound: selected.checkpoint?.identity.runId, modes, fingerprint, advertised, savedEventsInline: version === "v19", commandBytes: bytes, runId: next.id }));
  authority.close();
}, 120000);

it.each(["bootstrap", "compact", "prompt-only"] as const)("V17 pre-reader %s turn budgets inline saved events and names every omission", async road => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", { childSummary: `LEGACY-${n}-` + "y".repeat(60_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, { ...payload,
    executionContinuation: { version: 1, companyId: f.company.id, issueId: f.issue.id, objective: "Answer", objectiveSource: { kind: "description", id: f.issue.id, revision: "1" },
      trigger: { reason: "issue_children_completed", interactionId: null, sourceRunId: f.run.id }, originCommentIds: [], messages: [], completedActions: [], humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null }, resumeDelta: { baseRunId: f.run.id, messages: [] } } }),
    nativeToolContractVersion: "v19", resumedSession: road !== "bootstrap", normalizedSessionId: randomUUID(), sessionContinuity: road === "prompt-only" ? "paperclip" : "continuous",
    previousTurn: { runId: f.run.id, task: f.issue } });
  const prompt = road === "bootstrap" ? execution.task.prompt : execution.continuationPrompt!;
  const shown = new Set([...prompt.split("earlier automatic events not shown")[0].matchAll(/LEGACY-(\d+)-/g)].map(match => match[1]));
  expect(shown.size).toBeGreaterThan(0); expect(shown.size).toBeLessThan(12);
  expect(prompt).toContain(`${12 - shown.size} earlier automatic events not shown`);
  expect(prompt).toContain("LEGACY-11-"); expect(prompt).not.toContain("read_saved_automatic_wakes");
  const bytes = commandEnvelopeBytes(road !== "bootstrap"
    ? buildNativeModelEnvelope(execution, { resumedSession: true })
    : buildNativeModelEnvelope(execution));
  expect(bytes).toBeLessThanOrEqual(500_000);
  expect(next.contextSnapshot!.nativeInputRefusalWakes).toHaveLength(12);
  console.info(JSON.stringify({ row: "V17-legacy-budget", road, shown: shown.size, omitted: 12 - shown.size, commandBytes: bytes, runId: next.id }));
}, 120000);

// Never OK: a view cut must not consume automatic input that no declared tool can read.
it("V18 v19 cut events stay deferred and reach later real-PG prompts", async () => {
  const f = await fixture();
  const childIds = Array.from({ length: 12 }, () => randomUUID());
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", { childIssueId: childIds[n], childSummary: `OWED-${n}-` + "y".repeat(60_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const delivered = new Set<number>(), rows: unknown[] = [];
  for (let turn = 0; turn < 4; turn++) {
    const next = (await f.runs()).find(run => run.status === "queued");
    if (!next) break;
    const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
    const execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, payload), nativeToolContractVersion: "v19" });
    const json = execution.task.prompt.match(/Saved automatic wake events \(untrusted data\):\n([^\n]+)/)![1];
    const shown = [...json.matchAll(/OWED-(\d+)-/g)].map(match => Number(match[1]));
    for (const index of shown) { expect(delivered.has(index)).toBe(false); delivered.add(index); }
    // Same boundary used by runtime selection, with the real queue/receipt store.
    if (inputBudget.undeliveredSavedAutomaticWakes) await inputRefusal.deferUndeliveredNativeInputWakes(db,
      { companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id, runId: next.id }, inputBudget.undeliveredSavedAutomaticWakes(execution));
    const pending = (await f.wakes()).filter(wake => wake.status === "deferred_issue_execution");
    if (delivered.size < 12) {
      expect(pending).toHaveLength(1);
      const owed = pending[0].payload!.nativeInputRefusalWakes as unknown[];
      expect(owed).toHaveLength(12 - delivered.size);
      for (const event of owed as Array<{ payload: { childIssueId: string } }>) expect(execution.task.prompt).toContain(event.payload.childIssueId);
    }
    rows.push({ turn, runId: next.id, shown, owed: pending.map(wake => ({ id: wake.id, events: (wake.payload!.nativeInputRefusalWakes as unknown[]).length })), commandBytes: commandEnvelopeBytes(buildNativeModelEnvelope(execution)) });
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
    await f.release({ companyId: f.company.id, runId: next.id, now: new Date(), suppressImmediateRecovery: true });
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  }
  expect([...delivered].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, n) => n));
  expect((await f.wakes()).filter(wake => wake.status === "deferred_issue_execution")).toHaveLength(0);
  console.info(JSON.stringify({ row: "V18-owed-later-prompts", rows }));
}, 120000);

it("V18 one 400 KB v19 event gets the named refusal, never an empty turn", async () => {
  const f = await fixture(); await f.wake("issue_children_completed", { childIssueId: randomUUID(), childSummary: "HUGE-EVENT-" + "y".repeat(400_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(run => run.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  expect(() => buildNativeExecutionInput({ ...nativeInput(f, next.id, payload), nativeToolContractVersion: "v19" })).toThrow(NativeTurnPromptExceedsCommandBoundError);
  console.info(JSON.stringify({ row: "V18-indivisible-event-refused", runId: next.id, bytes: 400_000, refusal: "native_turn_prompt_exceeds_command_bound" }));
}, 120000);

it("V18 compact v19 fresh fallback re-budgets saved events like the normal fresh builder", async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", { childIssueId: randomUUID(), childSummary: `FALLBACK-${n}-` + "y".repeat(60_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(run => run.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const continuation = { version: 1 as const, companyId: f.company.id, issueId: f.issue.id, objective: "Answer", objectiveSource: { kind: "description" as const, id: f.issue.id, revision: "1" },
    trigger: { reason: "issue_children_completed", interactionId: null, sourceRunId: f.run.id }, originCommentIds: [], messages: [], completedActions: [], humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history" as const, throughCommentId: null, summaryThroughCommentId: null }, resumeDelta: { baseRunId: f.run.id, messages: [] } };
  const wake = { ...payload, executionContinuation: continuation };
  const base = { ...nativeInput(f, next.id, wake, "t".repeat(100_000)), nativeToolContractVersion: "v19" as const, normalizedSessionId: randomUUID(), sessionContinuity: "continuous", previousTurn: { runId: f.run.id, task: f.issue } };
  const compact = buildNativeExecutionInput({ ...base, resumedSession: true });
  const normal = buildNativeExecutionInput({ ...base, resumedSession: false });
  const compactBytes = commandEnvelopeBytes(buildNativeModelEnvelope(compact, { resumedSession: true }));
  const staleFreshBytes = commandEnvelopeBytes(buildNativeModelEnvelope(compact));
  expect(staleFreshBytes).toBeGreaterThan(350_000);
  budgetNativeFreshFallback(compact, wake, undefined, undefined, "v19");
  expect(compact.task.prompt).toBe(normal.task.prompt);
  const freshBytes = commandEnvelopeBytes(buildNativeModelEnvelope(compact));
  expect(freshBytes).toBe(commandEnvelopeBytes(buildNativeModelEnvelope(normal)));
  if (inputBudget.undeliveredSavedAutomaticWakes) await inputRefusal.deferUndeliveredNativeInputWakes(db,
    { companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id, runId: next.id }, inputBudget.undeliveredSavedAutomaticWakes(compact));
  const pending = (await f.wakes()).filter(wake => wake.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1);
  console.info(JSON.stringify({ row: "V18-fresh-fallback", runId: next.id, compactBytes, staleFreshBytes, freshBytes, normalFreshBytes: commandEnvelopeBytes(buildNativeModelEnvelope(normal)), owed: (pending[0].payload!.nativeInputRefusalWakes as unknown[]).length }));
}, 120000);

it("V16 12 x 60 KB backlog fits by reference and a later size refusal restores all twelve events to pending", async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", { childSummary: `BIG-${n}-` + "y".repeat(60_000) });
  const heldReceipt = (await f.wakes())[0];
  const heldPayloadBytes = Buffer.byteLength(JSON.stringify(heldReceipt.payload));
  const original = heldReceipt.payload!.nativeInputRefusalWakes;
  expect(heldPayloadBytes).toBeGreaterThan(780_000);
  expect(original).toHaveLength(12);
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(run => run.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, agentId: f.agent.id, runId: next.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const execution = buildNativeExecutionInput(nativeInput(f, next.id, payload));
  expect(commandEnvelopeBytes(buildNativeModelEnvelope(execution))).toBeLessThanOrEqual(500_000);
  expect(execution.task.prompt).toContain("read_saved_automatic_wakes");
  const resumedBytes: number[] = [];
  for (const sessionContinuity of ["continuous", "paperclip"]) {
    const resumed = buildNativeExecutionInput({ ...nativeInput(f, next.id, { ...payload,
      executionContinuation: { version: 1, companyId: f.company.id, issueId: f.issue.id, objective: "Answer", objectiveSource: { kind: "description", id: f.issue.id, revision: "1" },
        trigger: { reason: "issue_children_completed", interactionId: null, sourceRunId: f.run.id }, originCommentIds: [], messages: [], completedActions: [], humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null }, resumeDelta: { baseRunId: f.run.id, messages: [] } } }),
      resumedSession: true, normalizedSessionId: "retained", sessionContinuity, previousTurn: { runId: f.run.id, task: f.issue } });
    expect(resumed.continuationPrompt).toContain("read_saved_automatic_wakes");
    const bytes = commandEnvelopeBytes(buildNativeModelEnvelope(resumed, { resumedSession: true }));
    expect(bytes).toBeLessThanOrEqual(500_000); resumedBytes.push(bytes);
  }
  await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issue.id, status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
  await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.issue.id));
  const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id, runId: next.id });
  expect(authority.definitions().some(tool => tool.name === "read_saved_automatic_wakes")).toBe(true);
  let offset: number | null = 0, text = "", pages = 0;
  do {
    const page = await authority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: { offset } }) as ReturnType<typeof readSavedAutomaticWakes>;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(150_000);
    text += page.data; offset = page.nextOffset; pages++;
  } while (offset !== null);
  expect(JSON.parse(text)).toEqual(original);
  const skillAuthority = new PaperclipRunnerToolAuthority(db, { ...authority.binding, workMode: "skill_test" });
  expect(skillAuthority.definitions().some(tool => tool.name === "read_saved_automatic_wakes")).toBe(true);
  await db.update(heartbeatRuns).set({ contextSnapshot: { ...next.contextSnapshot, paperclipAgentJwtScope: { kind: "skill_test", issueId: f.issue.id } } }).where(eq(heartbeatRuns.id, next.id));
  expect(await skillAuthority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: { offset: 0 } })).toMatchObject({ eventCount: 12, offset: 0 });
  await db.update(heartbeatRuns).set({ contextSnapshot: next.contextSnapshot }).where(eq(heartbeatRuns.id, next.id));
  await expect(authority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: { offset: 0, runId: f.run.id } })).rejects.toThrow();
  await expect(new PaperclipRunnerToolAuthority(db, { ...authority.binding, companyId: randomUUID() }).execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: {} })).rejects.toThrow();
  await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
  await expect(authority.execute({ tool: "read_saved_automatic_wakes", callId: randomUUID(), arguments: {} })).rejects.toThrow();
  await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agent.id));
  await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null }).where(eq(heartbeatRuns.id, next.id));
  const [source] = await db.select().from(issueComments).where(eq(issueComments.id, f.message.id));
  const revision = nativeInputRevision(f.issue, [{ id: source.id, authorType: "user", updatedAt: source.updatedAt.toISOString(), deleted: false }]);
  let error: unknown;
  try { buildNativeExecutionInput({ ...nativeInput(f, next.id, payload, "z".repeat(600_000)), inputRevision: revision }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(NativeTurnPromptExceedsCommandBoundError);
  const evidence = await nativeInputRefusalEvidence(db, next, error, "native_turn_prompt_exceeds_command_bound");
  await db.update(heartbeatRuns).set({ status: "failed", startedAt: new Date(), finishedAt: new Date(), errorCode: "native_turn_prompt_exceeds_command_bound", resultJson: { ...evidence, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, next.id));
  await f.release({ companyId: f.company.id, runId: next.id, now: new Date(), resumeStrandedQueue: true });
  const pending = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1); expect(pending[0].runId).toBeNull(); expect(pending[0].payload!.nativeInputRefusalWakes).toEqual(original);
  await f.wake("issue_children_completed", { childSummary: "later" });
  expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")[0].payload!.nativeInputRefusalWakes).toHaveLength(13);
  expect(await f.runs()).toHaveLength(2);
  console.info(JSON.stringify({ row: "V16-large-backlog", events: 12, heldPayloadBytes, pages, commandBytes: commandEnvelopeBytes(buildNativeModelEnvelope(execution)), resumedBytes, pendingEventsAfterRefusal: 12, pendingEventsAfterWake: 13, runIds: (await f.runs()).map(r => r.id) }));
}, 120000);
it("V16 a size-refused adopter restores the backlog even without another wake", async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", { childSummary: `BIG-${n}-` + "y".repeat(60_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  const [source] = await db.select().from(issueComments).where(eq(issueComments.id, f.message.id));
  const revision = nativeInputRevision(f.issue, [{ id: source.id, authorType: "user", updatedAt: source.updatedAt.toISOString(), deleted: false }]);
  let error: unknown;
  try { buildNativeExecutionInput({ ...nativeInput(f, next.id, {}, "x".repeat(600_000)), inputRevision: revision }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(NativeTurnPromptExceedsCommandBoundError);
  await db.update(heartbeatRuns).set({ status: "failed", startedAt: new Date(), finishedAt: new Date(), errorCode: "native_turn_prompt_exceeds_command_bound", resultJson: { ...await nativeInputRefusalEvidence(db, next, error, "native_turn_prompt_exceeds_command_bound"), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, next.id));
  await f.release({ companyId: f.company.id, runId: next.id, now: new Date(), resumeStrandedQueue: true });
  const pending = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1); expect(pending[0].runId).toBeNull(); expect(pending[0].payload!.nativeInputRefusalWakes).toHaveLength(12);
  console.info(JSON.stringify({ row: "V16-refused-adopter-owed", runId: next.id, pendingRequest: pending[0].id, owedEvents: 12 }));
}, 120000);
it("V16 a small inline backlog switches to references when the rest of the measured turn needs the room", async () => {
  const f = await fixture(); await f.wake("issue_children_completed", { childSummary: "s".repeat(24_000) });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const execution = buildNativeExecutionInput(nativeInput(f, next.id, payload, "t".repeat(320_000)));
  expect(execution.task.prompt).toContain("read_saved_automatic_wakes");
  expect(commandEnvelopeBytes(buildNativeModelEnvelope(execution))).toBeLessThanOrEqual(500_000);
  console.info(JSON.stringify({ row: "V16-small-backlog-near-bound", events: 1, commandBytes: commandEnvelopeBytes(buildNativeModelEnvelope(execution)) }));
}, 120000);
it("V16 the first saved child context is present only once in bootstrap and resumed prompts", async () => {
  const f = await fixture();
  const childIssueSummaries = [{ id: randomUUID(), identifier: "child", title: "child", status: "done", summary: "UNIQUE-SAVED-CHILD" }];
  await f.queue.enqueueWakeup(f.agent.id, { source: "automation", reason: "issue_children_completed", requestedByActorType: "system", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_children_completed", childIssueSummaries } });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const execution = buildNativeExecutionInput(nativeInput(f, next.id, payload));
  const compact = buildNativeContinuationPrompt({ wakePayload: { ...payload, executionContinuation: { version: 1, objective: "Answer", messages: [], resumeDelta: { baseRunId: f.run.id, messages: [] } } }, previousRunId: f.run.id, issue: f.issue, previousIssue: f.issue });
  const promptOnly = buildNativeContinuationPrompt({ wakePayload: payload, promptOnly: true, previousRunId: f.run.id, issue: f.issue, previousIssue: f.issue });
  for (const prompt of [execution.task.prompt, compact, promptOnly]) expect(prompt!.split("UNIQUE-SAVED-CHILD").length - 1).toBe(1);
  console.info(JSON.stringify({ row: "V16-first-event-once", counts: [execution.task.prompt, compact, promptOnly].map(p => p!.split("UNIQUE-SAVED-CHILD").length - 1) }));
}, 120000);
it.each(["ordinary", "agent-comment", "native-review"])("V16 claim-time hold rejects an unchanged queued %s wake and retains its content", async kind => {
  const f = await fixture(); await f.wake("issue_children_completed", { childSummary: "CLAIM-STILL-OWED" });
  const [wake] = await f.wakes();
  const context = { ...wake.payload!._paperclipWakeContext as Record<string, unknown>, issueId: f.issue.id,
    wakeReason: "issue_commented", ...(kind === "agent-comment" ? { wakeCommentIds: [f.message.id] } : {}),
    ...(kind === "native-review" ? { nativeReviewInteractionId: randomUUID(), nativeReviewDecisionId: randomUUID() } : {}) };
  const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "queued",
    invocationSource: "automation", responsibleUserId: f.user, issueId: f.issue.id, wakeupRequestId: wake.id, contextSnapshot: context }).returning();
  await db.update(agentWakeupRequests).set({ status: "queued", runId: queued.id, requestedByActorType: "agent", requestedByActorId: f.agent.id }).where(eq(agentWakeupRequests.id, wake.id));
  await db.update(issues).set({ executionRunId: queued.id }).where(eq(issues.id, f.issue.id));
  expect(await f.queue.claimQueuedRun(queued)).toBeNull();
  expect((await f.runs()).find(r => r.id === queued.id)).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "native_input_refusal_claim_held" });
  expect((await f.wakes())[0]).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: { nativeInputRefusalHold: true } });
  expect(JSON.stringify((await f.wakes())[0].payload)).toContain("CLAIM-STILL-OWED");
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  expect((await f.runs()).filter(r => r.status === "queued")).toHaveLength(1);
  console.info(JSON.stringify({ row: "V16-claim-time-hold", kind, cancelled: queued.id, pendingWake: wake.id, successor: (await f.runs()).find(r => r.status === "queued")!.id }));
}, 120000);
it("V16 review-participant recovery cannot replay a held refusal", async () => {
  const f = await fixture();
  await db.update(issues).set({ status: "in_review", executionState: { status: "pending", currentStageId: randomUUID(), currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: f.agent.id, userId: null }, returnAssignee: { type: "agent", agentId: f.agent.id, userId: null }, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null } }).where(eq(issues.id, f.issue.id));
  await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.run.contextSnapshot, wakeReason: "execution_review_requested" } }).where(eq(heartbeatRuns.id, f.run.id));
  const result = await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  expect(await f.runs()).toHaveLength(1);
  const pending = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1); expect(pending[0].payload!.nativeInputRefusalWakes).toHaveLength(1);
  console.info(JSON.stringify({ row: "V16-review-held", outcome: result.outcome.kind, runCount: 1, pending: pending[0].id }));
}, 120000);
it("V16 real escalation blocks a refusal, repair restores only its own block and delivers once", async () => {
  const f = await fixture("legacy", true);
  await f.wake("issue_children_completed", { childSummary: "OWED-REAL-ESCALATION" });
  const result = await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  const [blocked] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
  const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issue.id));
  expect(result.outcome.kind).toBe("blocked"); expect(blocked.status).toBe("blocked");
  expect(action.evidence.nativeInputRefusalBlock).toMatchObject({ runId: f.run.id, statusVersion: blocked.statusVersion });
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  const [repeatedBlock] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
  const [repeatedAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
  expect(repeatedAction.evidence.nativeInputRefusalBlock).toMatchObject({ runId: f.run.id, statusVersion: repeatedBlock.statusVersion, previousStatus: "in_progress" });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(1);
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const [repaired] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
  const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
  expect(repaired.status).toBe("in_progress"); expect(resolved.status).toBe("resolved"); expect(resolved.outcome).toBe("restored");
  expect(await f.runs()).toHaveLength(2);
  const next = (await f.runs()).find(r => r.id !== f.run.id)!;
  expect(JSON.stringify(next.contextSnapshot)).toContain("OWED-REAL-ESCALATION");
  console.info(JSON.stringify({ row: "V16-real-escalation-repair", before: f.issue.status, escalated: blocked.status, repaired: repaired.status, actionId: action.id, actionStatus: resolved.status, nextRunId: next.id }));
}, 120000);
it("V16 a source repair also clears its own real escalation on fresh admission, without a pre-existing held row", async () => {
  const f = await fixture("legacy", true);
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("blocked");
  await f.repair(); const next = await f.wake("issue_children_completed", { childSummary: "FRESH-REPAIRED" });
  expect(next).not.toBeNull(); expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("in_progress");
  console.info(JSON.stringify({ row: "V16-real-escalation-fresh", nextRun: next!.id }));
}, 120000);
it("V16 a repair cannot undo a later independent blocked decision", async () => {
  const f = await fixture("legacy", true); await f.wake("issue_children_completed", { childSummary: "STILL-OWED" });
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  const [blocked] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
  // A later status decision owns a new version, even if its status is blocked.
  await issueService(db).update(f.issue.id, { status: "blocked", companyGuard: f.company.id });
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("blocked");
  expect(await f.runs()).toHaveLength(1);
  expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(1);
  console.info(JSON.stringify({ row: "V16-independent-block-retained", refusalStatusVersion: blocked.statusVersion, independentStatusVersion: blocked.statusVersion + 1, runCount: 1 }));
}, 120000);
it("V16 reassignment hands held content to the new assignee without bypassing the original repair", async () => {
  const f = await fixture(); await f.wake("issue_children_completed", { childSummary: "OWED-OLD-AGENT" });
  const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "New assignee", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, f.issue.id)); f.deps.getAgent.mockResolvedValue(other);
  const first = await f.queue.enqueueWakeup(other.id, { source: "automation", reason: "issue_assigned", requestedByActorType: "system", payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } });
  expect(first).not.toBeNull(); expect(first!.contextSnapshot?.nativeInputRefusalWakes).toBeUndefined();
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first!.id));
  await f.release({ companyId: f.company.id, runId: first!.id, now: new Date(), suppressImmediateRecovery: true });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const pending = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1); expect(pending[0].agentId).toBe(other.id);
  expect(pending[0].payload!.nativeInputRefusalAgentIds).toContain(f.agent.id); expect(await f.runs()).toHaveLength(2);
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const runs = await f.runs(), delivered = runs.find(r => r.id !== f.run.id && r.id !== first!.id)!;
  expect(runs).toHaveLength(3); expect(delivered.agentId).toBe(other.id); expect(JSON.stringify(delivered.contextSnapshot)).toContain("OWED-OLD-AGENT");
  expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(0);
  console.info(JSON.stringify({ row: "V16-handover", oldAgent: f.agent.id, newAgent: other.id, pendingBeforeRepair: pending[0].id, deliveredRun: delivered.id }));
}, 120000);
it("V16 reassignment merges both assignees' held receipts losslessly before repair", async () => {
  const f = await fixture(); await f.wake("issue_children_completed", { childSummary: "MERGE-OLD" });
  const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Next assignee", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, f.issue.id)); f.deps.getAgent.mockResolvedValue(other);
  await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: other.id, status: "failed", issueId: f.issue.id,
    startedAt: new Date(), finishedAt: new Date(), responsibleUserId: f.user, errorCode: f.run.errorCode, resultJson: f.run.resultJson, contextSnapshot: { issueId: f.issue.id } });
  await f.queue.enqueueWakeup(other.id, { source: "automation", reason: "issue_children_completed", requestedByActorType: "system", payload: { issueId: f.issue.id, childSummary: "MERGE-NEW" }, contextSnapshot: { issueId: f.issue.id } });
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const pending = (await f.wakes()).filter(w => w.status === "deferred_issue_execution");
  expect(pending).toHaveLength(1); expect(pending[0].agentId).toBe(other.id);
  expect(pending[0].payload!.nativeInputRefusalWakes).toHaveLength(2);
  expect(pending[0].payload!.nativeInputRefusalAgentIds).toEqual(expect.arrayContaining([f.agent.id, other.id]));
  expect(await f.runs()).toHaveLength(2);
  await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const queued = (await f.runs()).filter(r => r.status === "queued"); expect(queued).toHaveLength(1); expect(queued[0].agentId).toBe(other.id);
  expect(JSON.stringify(queued[0].contextSnapshot)).toContain("MERGE-OLD"); expect(JSON.stringify(queued[0].contextSnapshot)).toContain("MERGE-NEW");
  expect((await f.wakes()).filter(w => w.status === "deferred_issue_execution")).toHaveLength(0);
  console.info(JSON.stringify({ row: "V16-handover-merge", owners: [f.agent.id, other.id], events: 2, runId: queued[0].id }));
}, 120000);
it.each(["system", "agent", "user"] as const)("V16 unassign then reassign to the same refused agent respects the %s actor", async actor => {
  const f = await fixture("legacy", true);
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  await issueService(db).update(f.issue.id, { assigneeAgentId: null, companyGuard: f.company.id });
  await issueService(db).update(f.issue.id, { assigneeAgentId: f.agent.id, companyGuard: f.company.id });
  const next = await f.queue.enqueueWakeup(f.agent.id, { source: "assignment", reason: "issue_assigned", requestedByActorType: actor,
    requestedByActorId: actor === "user" ? f.user : f.agent.id, payload: { issueId: f.issue.id }, contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } });
  if (actor !== "user") { expect(next).toBeNull(); expect(await f.runs()).toHaveLength(1); }
  else {
    expect(next).not.toBeNull(); let error: unknown;
    try { buildNativeExecutionInput({ ...nativeInput(f, next!.id, {}, f.message.body), inputRevision: f.revision }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(NativeTurnPromptExceedsCommandBoundError);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), startedAt: new Date(), errorCode: f.run.errorCode,
      resultJson: { ...await nativeInputRefusalEvidence(db, next!, error, f.run.errorCode!), executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, next!.id));
    await f.release({ companyId: f.company.id, runId: next!.id, now: new Date() });
    expect(await f.wake("issue_assigned")).toBeNull(); expect(await f.runs()).toHaveLength(2);
  }
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(actor === "user" ? 2 : 1);
  const heldRunCount = (await f.runs()).length;
  if (actor === "user") {
    await f.repair(); await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("in_progress");
    expect(await f.runs()).toHaveLength(3);
  }
  console.info(JSON.stringify({ row: "V16-same-agent-reassignment", actor, attemptRun: next?.id ?? null, heldRunCount, runCountAfterOptionalRepair: (await f.runs()).length }));
}, 120000);
it.each(["unassigned", "reassigned"])("V16 a person's deferred message remains owed through real unassign/reassign with repair while %s and is answered once", async repairTiming => {
  const f = await fixture("legacy", true);
  await f.release({ companyId: f.company.id, runId: f.run.id, now: new Date() });
  expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].status).toBe("blocked");
  const [personWake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "on_demand", reason: "issue_commented",
    requestedByActorType: "user", requestedByActorId: f.user, status: "deferred_issue_execution",
    payload: { issueId: f.issue.id, commentId: f.message.id, _paperclipWakeContext: { issueId: f.issue.id, source: "issue.comment", wakeReason: "issue_commented", wakeCommentIds: [f.message.id] } } }).returning();
  await issueService(db).update(f.issue.id, { assigneeAgentId: null, companyGuard: f.company.id });
  expect((await f.wakes()).find(w => w.id === personWake.id)!.status).toBe("cancelled");
  const owed = (await f.wakes()).filter(w => w.status === "deferred_issue_execution"); expect(owed).toHaveLength(1); expect(owed[0].requestedByActorType).toBe("system");
  if (repairTiming === "unassigned") await f.repair();
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(1);
  const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Answering assignee", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).returning();
  await issueService(db).update(f.issue.id, { assigneeAgentId: other.id, companyGuard: f.company.id }); f.deps.getAgent.mockResolvedValue(other);
  if (repairTiming === "reassigned") {
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(1);
    await f.repair();
  }
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(r => r.status === "queued")!; expect(next).toBeDefined(); expect(next.agentId).toBe(other.id);
  const continuation = await buildExecutionContinuation({ db, companyId: f.company.id, issueId: f.issue.id, agentId: other.id, context: next.contextSnapshot!, runId: next.id, summary: null, exposeLowTrustRaw: true });
  expect(continuation.messages.filter(m => m.id === f.message.id)).toHaveLength(1);
  expect(continuation.messages.find(m => m.id === f.message.id)!.body).toBe("Please answer ready.");
  await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issue.id, startedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
  await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.issue.id));
  const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.company.id, issueId: f.issue.id, agentId: other.id, runId: next.id });
  const call = { tool: "report_progress", callId: randomUUID(), arguments: { body: "ready", idempotencyKey: "owed-message-answer" } };
  await authority.execute(call); await authority.execute({ ...call, callId: randomUUID() });
  const answers = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id), eq(issueComments.createdByRunId, next.id)));
  expect(answers.filter(m => m.body === "ready")).toHaveLength(1);
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id }); expect(await f.runs()).toHaveLength(2);
  console.info(JSON.stringify({ row: "V16-person-message-reassignment", repairTiming, revokedWake: personWake.id, owedReceipt: owed[0].id, sourceComment: f.message.id, deliveredRun: next.id, scriptedAuthorityAnswer: answers[0].id, answers: 1 }));
}, 120000);
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

// Never OK: rebudgeting automatic data must preserve person-authored bytes.
it.each([false, true])("V19 quoted saved-event heading preserves the whole person message (DB reload %s)", async reload => {
  const f = await fixture();
  await f.wake("issue_children_completed", { childSummary: "SMALL-AUTOMATIC-EVENT" });
  await f.repair();
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  const next = (await f.runs()).find(run => run.id !== f.run.id)!;
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const body = "Please explain this literal heading: Saved automatic wake events (untrusted data): PERSON-REQUEST-MUST-SURVIVE. Answer my question, not the heading.";
  const [message] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
    authorType: "user", authorUserId: f.user, body }).returning();
  const continuation = await buildExecutionContinuation({ db, companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id,
    context: { ...next.contextSnapshot, wakeCommentIds: [message.id] }, runId: next.id, summary: null, exposeLowTrustRaw: true });
  expect(continuation.messages.some(message => message.body === body)).toBe(true);
  const wake = { ...payload, executionContinuation: continuation };
  let execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, wake), nativeToolContractVersion: "v19",
    resumedSession: true, normalizedSessionId: randomUUID(), sessionContinuity: "continuous", previousTurn: { runId: f.run.id, task: f.issue } });
  if (reload) {
    // The executor may load persisted execution/wake JSONB after a restart.
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution }, contextSnapshot: { paperclipWake: wake } })
      .where(eq(heartbeatRuns.id, next.id));
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.id));
    execution = saved.runnerProfileJson!.nativeExecutionInput as typeof execution;
    Object.assign(wake, saved.contextSnapshot!.paperclipWake);
  }
  const before = execution.task.prompt, beforeBytes = commandEnvelopeBytes(buildNativeModelEnvelope(execution));
  budgetNativeFreshFallback(execution, wake, undefined, undefined, "v19");
  const afterBytes = commandEnvelopeBytes(buildNativeModelEnvelope(execution));
  console.info(JSON.stringify({ row: "V19-quoted-heading", reload, runId: next.id, commentId: message.id,
    beforeBytes, afterBytes, messagePreserved: execution.task.prompt.includes(body), beforePrompt: before, afterPrompt: execution.task.prompt }));
  expect(execution.task.prompt).toContain(body);
  expect(execution.task.prompt).toBe(before);
  expect(beforeBytes).toBe(4_416);
  expect(afterBytes).toBe(beforeBytes);
}, 120000);

// Never OK: a successor's adoption cannot erase a later fallback's extra debt.
it.each([false, true])("V19 adopted remainder preserves every event exactly once (adopt extra generation %s)", async adoptExtra => {
  const f = await fixture();
  for (let n = 0; n < 12; n++) await f.wake("issue_children_completed", {
    childIssueId: randomUUID(), childSummary: `RACE-${n}-` + "y".repeat(60_000),
  });
  await f.repair();
  await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
  let next = (await f.runs()).find(run => run.status === "queued")!;
  expect(await f.queue.claimQueuedRun(next)).not.toBeNull();
  const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
  const wake = { ...payload, executionContinuation: { version: 1, companyId: f.company.id, issueId: f.issue.id,
    objective: "Answer", objectiveSource: { kind: "description", id: f.issue.id, revision: "1" },
    trigger: { reason: "issue_children_completed", interactionId: null, sourceRunId: f.run.id }, originCommentIds: [], messages: [],
    completedActions: [], humanResponses: [], interactionOutcomes: [], completedWork: null, unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null }, resumeDelta: { baseRunId: f.run.id, messages: [] } } };
  let execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, wake, "t".repeat(100_000)), nativeToolContractVersion: "v19",
    resumedSession: true, normalizedSessionId: randomUUID(), sessionContinuity: "continuous", previousTurn: { runId: f.run.id, task: f.issue } });
  const scope = { companyId: f.company.id, issueId: f.issue.id, agentId: f.agent.id, runId: next.id };
  const defer = () => inputRefusal.deferUndeliveredNativeInputWakes(db, scope, inputBudget.undeliveredSavedAutomaticWakes(execution));
  await defer();
  const owedBefore = (await f.wakes()).find(wake => wake.status === "deferred_issue_execution")!;
  expect(owedBefore.payload!.nativeInputRefusalWakes).toHaveLength(7);
  await f.wake("issue_children_completed", { childIssueId: randomUUID(), childSummary: "ARRIVING-WHILE-FIRST-PREPARING" });
  const adopted = (await f.wakes()).find(wake => wake.id === owedBefore.id)!;
  expect(adopted.status).toBe("coalesced");
  expect(adopted.runId).not.toBe(next.id);
  const successorBefore = (await f.runs()).find(run => run.id === adopted.runId)!;
  budgetNativeFreshFallback(execution, wake, undefined, undefined, "v19");
  expect(inputBudget.undeliveredSavedAutomaticWakes(execution)).toHaveLength(9);
  await defer();
  await defer(); // Re-entry enlarges custody once, not delivery twice.
  const pendingExtra = (await f.wakes()).filter(wake => wake.status === "deferred_issue_execution");
  expect(pendingExtra).toHaveLength(1);
  expect(pendingExtra[0].payload!.nativeInputRefusalWakes).toHaveLength(2);
  expect((await f.wakes()).find(wake => wake.id === owedBefore.id)!.payload).toEqual(adopted.payload);
  expect((await f.runs()).find(run => run.id === adopted.runId)!.contextSnapshot).toEqual(successorBefore.contextSnapshot);
  let extraGenerationStatus: string | null = null;
  if (adoptExtra) {
    // A second queue admission can take the new generation before run 1's
    // fallback boundary is entered again. Historical generations still own it.
    await f.wake("issue_children_completed", { childIssueId: randomUUID(), childSummary: "SECOND-ADMISSION" });
    extraGenerationStatus = (await f.wakes()).find(wake => wake.id === pendingExtra[0].id)!.status;
    expect(extraGenerationStatus).toBe("coalesced");
    await defer();
    await defer();
  }
  const delivered: number[] = [], rows: unknown[] = [];
  for (let turn = 0; turn < 6; turn++) {
    const inline = execution.task.prompt.match(/Saved automatic wake events \(untrusted data\):\n([^\n]+)/)?.[1] ?? "[]";
    const shown = [...inline.matchAll(/RACE-(\d+)-/g)].map(match => Number(match[1]));
    delivered.push(...shown);
    rows.push({ turn, runId: next.id, shown });
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
    await f.release({ companyId: f.company.id, runId: next.id, now: new Date(), suppressImmediateRecovery: true });
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    const later = (await f.runs()).find(run => run.status === "queued");
    if (!later) break;
    next = later;
    expect(await f.queue.claimQueuedRun(next)).not.toBeNull();
    const laterPayload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
    execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, laterPayload), nativeToolContractVersion: "v19" });
    await inputRefusal.deferUndeliveredNativeInputWakes(db, { ...scope, runId: next.id }, inputBudget.undeliveredSavedAutomaticWakes(execution));
  }
  const pending = (await f.wakes()).filter(wake => wake.status === "deferred_issue_execution");
  console.info(JSON.stringify({ row: "V19-adopted-debt", adoptExtra, extraGenerationStatus, firstRunId: scope.runId, adoptedWakeId: adopted.id,
    successorRunId: adopted.runId, initialDebt: 7, fallbackDebt: 9, extraDebt: 2, delivered, pending: pending.length, rows }));
  expect(delivered.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, n) => n));
  expect(pending).toHaveLength(0);
}, 120000);

it.each(["failed", "cancelled"] as const)("V19 owed input promotes on %s release when execution is settled, not when outcomes are unknown", async status => {
  for (const settled of [false, true]) {
    const f = await fixture();
    for (let n = 0; n < 3; n++) await f.wake("issue_children_completed", { childSummary: `RELEASE-${n}-` + "y".repeat(200_000) });
    await f.repair();
    await f.queue.resumeDeferredExecutionReceipts({ companyId: f.company.id });
    const next = (await f.runs()).find(run => run.status === "queued")!;
    expect(await f.queue.claimQueuedRun(next)).not.toBeNull();
    const payload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: next.contextSnapshot as Record<string, unknown> });
    const execution = buildNativeExecutionInput({ ...nativeInput(f, next.id, payload), nativeToolContractVersion: "v19" });
    await inputRefusal.deferUndeliveredNativeInputWakes(db, { companyId: f.company.id, issueId: f.issue.id,
      agentId: f.agent.id, runId: next.id }, inputBudget.undeliveredSavedAutomaticWakes(execution));
    const owed = (await f.wakes()).find(wake => wake.status === "deferred_issue_execution")!;
    expect(owed.payload!.nativeInputRefusalWakes).toHaveLength(2);
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date(), errorCode: status === "failed" ? "adapter_failed" : null,
      resultJson: settled ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null }).where(eq(heartbeatRuns.id, next.id));
    await f.release({ companyId: f.company.id, runId: next.id, now: new Date(), suppressImmediateRecovery: true });
    // No additional wake or deferred sweep: release itself must promote safe debt.
    const successor = (await f.runs()).find(run => run.status === "queued");
    const receipt = (await f.wakes()).find(wake => wake.id === owed.id)!;
    console.info(JSON.stringify({ row: "V19-terminal-release", status, settled, runId: next.id, owedWakeId: owed.id,
      successorRunId: successor?.id ?? null, receiptStatus: receipt.status }));
    if (settled) {
      expect(successor).toBeDefined();
      expect(successor!.wakeupRequestId).toBe(owed.id);
      const laterPayload = await buildPaperclipWakePayload({ db, companyId: f.company.id, contextSnapshot: successor!.contextSnapshot as Record<string, unknown> });
      const later = buildNativeExecutionInput({ ...nativeInput(f, successor!.id, laterPayload), nativeToolContractVersion: "v19" });
      expect(later.task.prompt).toContain("RELEASE-1-");
      expect(later.task.prompt).not.toContain("RELEASE-2-");
    } else {
      // Owed data is not authority to bypass uncertain-execution reconciliation.
      expect(successor).toBeUndefined();
      expect(receipt.status).toBe("deferred_issue_execution");
      expect(receipt.payload!.nativeInputRefusalWakes).toHaveLength(2);
    }
  }
}, 120000);
