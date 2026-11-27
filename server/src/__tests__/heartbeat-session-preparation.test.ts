import express from "express";
import request from "supertest";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { getStorageService } from "../storage/index.js";
import { errorHandler } from "../middleware/index.js";
import { NativeProviderStateIncompatibleError } from "../vendor/paperclip-runner/index.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, PluginWorkspaceOperationError, workspaceOperationErrorData } from "@paperclipai/plugin-sdk";
import * as nativeRuntimeMode from "../services/native-runtime/runtime-mode.js";
import * as sessionFingerprintInputs from "../services/heartbeat/session-fingerprint-inputs.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import * as runtimeSelection from "../services/heartbeat/runtime-selection.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, executionWorkspaces, environments, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, plugins, projects } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareHeartbeatSession, type HeartbeatSessionPreparationInput } from "../services/heartbeat/session-preparation.js";
import { getAdapterSessionCodec } from "../services/heartbeat/run-state.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { companySkillService } from "../services/company-skills.js";
import * as companySkillsModule from "../services/company-skills.js";
import * as sessionMetadata from "../services/heartbeat/workspaces.js";
import { previousSessionMetadata } from "./helpers/previous-session-fingerprint.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { requestTaskRetry } from "../services/task-retry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import * as environmentOrchestrator from "../services/environment-run-orchestrator.js";
import { createPluginWorkspaceFixture } from "./helpers/plugin-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping session preparation tests: ${support.reason}`);

describePostgres("heartbeat session preparation through adapter dispatch", () => {
  const adapterType = "session_preparation_test";
  const captured = new Map<string, AdapterExecutionContext>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let restoreSkillFixture = () => {};

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
    // This synthetic adapter does not consume legacy operational/feedback
    // bundles. Keep the real skill service (including explicit version tests),
    // but exclude that unrelated implicit bundle on every facade and Retry.
    // STALL: avoided in tests; cause not found. Excluding implicit bundles
    // avoids the observed slow copy path, not a production performance fix.
    const createSkills = companySkillService;
    const skillFactory = vi.spyOn(companySkillsModule, "companySkillService").mockImplementation((...args) => {
      const service = createSkills(...args);
      const withRuntimeSkillEntries: typeof service.withRuntimeSkillEntries = (companyId, options, consume) =>
        service.withRuntimeSkillEntries(companyId, { ...options, includeLegacy: false }, consume);
      return { ...service, withRuntimeSkillEntries };
    });
    restoreSkillFixture = () => skillFactory.mockRestore();
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        // Settle the fixture's work so no automatic unfinished-task retry
        // competes with the next explicit session-continuation wake.
        const [issue] = await db.select().from(issues).where(eq(issues.id, String(input.context.issueId)));
        await db.update(issues).set(issue.conversationAgentId ? { status: "todo", conversationState: "waiting" } : { status: "done" })
          .where(eq(issues.id, issue.id));
        const sessionId = typeof input.config.fixtureSessionId === "string" ? input.config.fixtureSessionId : "saved-session";
        return { exitCode: 0, signal: null, timedOut: false, sessionId, sessionParams: { sessionId, adapterState: "preserved" }, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    try {
      await heartbeat?.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
      await db?.$client.end({ timeout: 0 });
      await temporary?.cleanup();
    } finally { restoreSkillFixture(); }
  });

  async function seed(runtimeConfig: Record<string, unknown> = {}, fixtureAdapterType = adapterType) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Session fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Session owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Session reader", adapterType: fixtureAdapterType, status: "idle", adapterConfig: { model: "model-a" }, runtimeConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Session fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown> = {}, expectedStatus = "succeeded", service = heartbeat) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const run = await service.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
      ...(context.source === "execution.reconciled" ? {
        source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored",
        requestedByActorType: "system", requestedByActorId: "execution-recovery",
        idempotencyKey: `execution-reconciliation:${context.recoveryActionId}`,
        payload: { issueId: f.issueId, recoveryActionId: context.recoveryActionId },
      } : {}),
    });
    expect(run).not.toBeNull();
    await service.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe(expectedStatus);
    expect(captured.has(run!.id)).toBe(true);
    return { input: captured.get(run!.id)!, finished };
  }

  it.each(["continuous", "paperclip"])("a Pi workspace change preserves resume fields only in %s mode", async sessionContinuity => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "workspace-continuation-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({ kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity, cwd } }).where(eq(agents.id, f.agentId));
      await execute(f);
      const next = await execute(f, { workspaceSelectionChanged: true });
      expect(next.input.runtime.sessionId).toBe(sessionContinuity === "continuous" ? "saved-session" : null);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: sessionContinuity !== "continuous" } } });
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    { conversation: true, chip: false, held: false, instructionsChanged: false },
    { conversation: true, chip: true, held: false, instructionsChanged: false },
    { conversation: false, chip: false, held: false, instructionsChanged: false },
    { conversation: false, chip: true, held: false, instructionsChanged: false },
    { conversation: true, chip: true, held: true, instructionsChanged: false },
    { conversation: false, chip: true, held: true, instructionsChanged: false },
    { conversation: true, chip: true, held: false, instructionsChanged: true },
  ])("previous-release Pi swap: agent chat=$conversation chip=$chip held=$held instructions changed=$instructionsChanged", async ({ conversation, chip, held, instructionsChanged }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "previous-release-continuation-"));
    const sessionId = randomUUID();
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const metadataInputs: Parameters<typeof sessionMetadata.buildEffectiveRunSessionConfigMetadata>[0][] = [];
    const buildMetadata = sessionMetadata.buildEffectiveRunSessionConfigMetadata;
    const captureMetadata = vi.spyOn(sessionMetadata, "buildEffectiveRunSessionConfigMetadata").mockImplementation(async input => {
      metadataInputs.push(input);
      return buildMetadata(input);
    });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    try {
      const instructionsPath = join(cwd, "AGENTS.md");
      if (instructionsChanged) await writeFile(instructionsPath, "Original instructions\n");
      const config = { provider: "pi_rpc", model: "fixture/model-a", piRpcThinkingLevel: "low", sessionContinuity: "continuous", cwd, fixtureSessionId: sessionId,
        ...(instructionsChanged ? { instructionsRootPath: cwd, instructionsEntryFile: "AGENTS.md", instructionsFilePath: instructionsPath } : {}),
      };
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      await db.update(issues).set({
        status: "todo",
        ...(conversation ? { conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" as const } : {}),
        ...(chip ? { assigneeAdapterOverrides: { adapterConfig: { model: "fixture/model-b", piRpcThinkingLevel: "high" } } } : {}),
      }).where(eq(issues.id, f.issueId));
      const first = await execute(f);
      const metadataInput = metadataInputs[0];
      expect(metadataInput.effectiveAdapterConfig.provider).toBe("pi_rpc");
      if (chip) expect(metadataInput.issueOverrides).toMatchObject({ adapterConfig: { model: "fixture/model-b", piRpcThinkingLevel: "high" } });
      const old = previousSessionMetadata(metadataInput, instructionsChanged ? {
        configured: true, bundleMode: null, entryFile: "AGENTS.md", pathKind: "absolute", readPolicy: "root_bound", readable: true,
        contentHash: `sha256:${createHash("sha256").update("Original instructions\n").digest("hex")}`,
      } : null);
      const current = await buildMetadata(metadataInput);
      const changed = current.categories.filter(category => old.categoryFingerprints[category] !== current.categoryFingerprints[category]);
      expect(changed).toEqual(chip ? ["adapterConfig", "issueOverrides"] : ["adapterConfig"]);
      const [stored] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      const storedParams = sessionMetadata.attachPaperclipSessionMetadataToSessionParams({ sessionId, adapterState: "preserved" }, first.input.config.model as string, old);
      await db.update(agentTaskSessions).set({ sessionParamsJson: storedParams }).where(eq(agentTaskSessions.id, stored.id));
      if (instructionsChanged) await writeFile(instructionsPath, "Updated instructions\n");
      const resumed = await execute(f);
      expect(resumed.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false, taskSessionAvailable: true, taskSessionReused: true } } });
      expect(resumed.input.runtime).toMatchObject({ sessionId, sessionDisplayId: sessionId, sessionParams: { sessionId, adapterState: "preserved" } });
      expect(resumed.finished.sessionIdBefore).toBe(sessionId);
      if (instructionsChanged) expect(resumed.finished.resultJson).toMatchObject({ configFreshness: { session: { changedCategories: ["instructions"] } } });

      // Both releases ship the same runtime-context builder and prompt bytes.
      // Build the saved and next context separately, as at a release boundary.
      const makeExecution = (runId: string) => buildNativeExecutionInput({
        companyId: f.companyId, agentId: f.agentId, runId,
        issue: { id: f.issueId, identifier: "FIX-1", title: "Continue the thread", description: null, workMode: "standard", ...(conversation ? { conversationAgentId: f.agentId } : {}) },
        conversationMode: conversation,
        taskPrompt: "The next message", normalizedSessionId: sessionId,
        workspace: { id: "stable-workspace", cwd, repoUrl: null, repoRef: null, branchName: null },
        provider: "pi_rpc", model: first.input.config.model as string, piRpcThinkingLevel: chip ? "high" : "low",
        runtimeContext: nativeRuntimeContextFixture(),
        completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
          contract: { revision: "1", objective: "Continue the thread", criteria: [{ id: "reply", requirement: "Answer the next message" }] } },
      });
      const priorExecution = makeExecution(first.finished.id);
      const source = { id: first.finished.id, companyId: f.companyId, agentId: f.agentId, nativeSessionId: sessionId,
        runnerProfileJson: { nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", "pi_rpc"), nativeExecutionInput: priorExecution,
          sessionCheckpoint: { backendKind: "runner", driverKind: "pi_rpc", sessionId: "provider-thread-saved-before-upgrade", providerSessionId: "provider-thread-saved-before-upgrade",
            identity: { runId: first.finished.id, sessionId, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId },
            ...(held ? { goal: { status: "paused", objective: "Continue after the held turn" } } : {}) } } };
      const rebound = buildNativeExecutionWithCheckpoint({ previousRun: source, normalizedSessionId: resumed.input.runtime.sessionId!, sessionContinuity: "continuous",
        buildExecution: ({ normalizedSessionId }) => { const next = makeExecution(resumed.finished.id); next.session.normalizedSessionId = normalizedSessionId; return next; } });
      expect(rebound.normalizedSessionId).toBe(sessionId);
      expect(rebound.checkpoint).toMatchObject({ sessionId: "provider-thread-saved-before-upgrade", providerSessionId: "provider-thread-saved-before-upgrade" });
      if (held) expect(rebound.checkpoint?.providerRecoveryPolicy).toBe("same_session_only");
      if (chip && ((!conversation && !held) || instructionsChanged)) {
        await db.update(agentTaskSessions).set({ sessionParamsJson: storedParams }).where(eq(agentTaskSessions.id, stored.id));
        await db.update(issues).set({ assigneeAdapterOverrides: { adapterConfig: {
          model: "fixture/model-b", piRpcThinkingLevel: "high", fixtureOption: "changed",
        } } }).where(eq(issues.id, f.issueId));
        const unrelated = await execute(f);
        expect(unrelated.input.runtime.sessionId).toBeNull();
        expect(unrelated.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionReused: false } } });
      }
    } finally { captureMetadata.mockRestore(); mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    { failure: "native_controller_recovery_missing_evidence:retained_sandbox_binding", fresh: true, org: "example-org", chat: false },
    { failure: "ordinary provider failure", fresh: false, org: "second-org", chat: false },
    { failure: "native_controller_recovery_missing_evidence:retained_sandbox_binding", fresh: false, org: "second-org", chat: true },
  ])("a person's validated continuous-Pi Retry: $org, chat=$chat, fresh=$fresh", async ({ failure, fresh, org, chat }) => {
    const f = await seed(), sessionId = randomUUID();
    await db.update(companies).set({ name: org }).where(eq(companies.id, f.companyId));
    if (chat) await db.update(issues).set({ originKind: "chat_channel" }).where(eq(issues.id, f.issueId));
    try {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model",
        sessionContinuity: "continuous", fixtureSessionId: sessionId } }).where(eq(agents.id, f.agentId));
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
      await db.update(issues).set({ workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "project_primary" } } }).where(eq(issues.id, f.issueId));
      const first = await execute(f);
      await db.update(executionWorkspaces).set({ status: "active", closedAt: null }).where(eq(executionWorkspaces.id, String(first.input.context.executionWorkspaceId)));
      await db.update(heartbeatRuns).set({ status: "failed", error: failure, errorCode: "native_continuation_requires_reconciliation" }).where(eq(heartbeatRuns.id, first.finished.id));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
      const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: f.userId,
        actorSource: "local_implicit", observedRunId: first.finished.id, idempotencyKey: randomUUID() });
      expect(receipt).toMatchObject({ accepted: true, stale: false });
      await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
      await heartbeat.drainActiveRunExecutions();
      const retries = [...captured.values()].filter(input => input.context.taskRetryRequestId === receipt.requestId);
      expect(retries.map(input => input.runtime.sessionId)).toEqual([fresh ? null : sessionId]);
    } finally { await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false }); }
  });
  it.each([
    { failure: "runner_state_identity_mismatch: remote_warm_session_not_idle", chat: false, fresh: true },
    { failure: "runner_state_identity_mismatch: remote_warm_session_not_idle", chat: true, fresh: false },
    { failure: "ordinary model/tool failure", chat: false, fresh: false },
    { failure: "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; warm_recovery_refused=current_run_not_admitted", chat: false, fresh: true },
    { failure: "native_controller_recovery_unsupported:metadata_format", chat: false, fresh: true },
    { failure: "native_continuation_requires_reconciliation", chat: false, fresh: false },
    { failure: "native_controller_recovery_missing_evidence:retained_sandbox_binding", chat: false, fresh: true },
    { failure: "workspace_continuation_source_missing", errorCode: "native_provider_state_incompatible", chat: false, fresh: true },
    { failure: "current_run_not_admitted", chat: false, fresh: true },
  ].flatMap(row => [true, false].map(reconciled => ({ ...row, reconciled }))))("stock reconciliation of a continuous Pi session: $failure, chat=$chat, fresh=$fresh, reconciled=$reconciled", async ({ failure, errorCode, chat, fresh, reconciled }) => {
    const f = await seed(), sessionId = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", fixtureSessionId: sessionId } })
      .where(eq(agents.id, f.agentId));
    if (chat) await db.update(issues).set({ originKind: "chat_channel" }).where(eq(issues.id, f.issueId));
    await execute(f);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId,
      body: "SAVED WORK: use the completed analysis", createdAt: new Date(Date.now() - 1_000) });
    // A refused pre-claim turn does not advance taskSession.lastRunId.
    const [failed] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeSessionId: sessionId, nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(),
      error: failure, errorCode: errorCode ?? "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
    // Fail again if session preparation sends this non-chat recovery into the refused session.
    const adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, execute: async input => {
      if (fresh && input.runtime.sessionId === sessionId) throw new Error("remote_warm_session_not_idle");
      return adapter.execute(input);
    } });
    try {
      const recovery = { ...(reconciled ? { source: "execution.reconciled" } : {}), wakeReason: "issue_recovery_action_restored" };
      const actionId = randomUUID();
      await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "system", returnOwnerAgentId: f.agentId,
        cause: "native_continuation_requires_reconciliation", fingerprint: actionId, nextAction: "Continue saved work",
        evidence: { continuationDelivery: "pending", executionReconciliation: { runId: failed.id,
          providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "The failed warm turn did not run." } },
      });
      const next = await execute(f, { ...recovery, forceFreshSession: true, recoveryActionId: actionId,
        previousRunId: failed.id, retryOfRunId: failed.id });
      expect(next.input.runtime.sessionId).toBe(fresh ? null : sessionId);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: fresh, taskSessionReused: !fresh } } });
      if (fresh) {
        expect(next.input.context.executionContinuation).toMatchObject({ messages: [expect.objectContaining({ body: "SAVED WORK: use the completed analysis" })] });
        expect(next.finished.error).toBeNull();
      }
    } finally { registerServerAdapter(adapter); }
  });

  it.for([
    { laggingPointer: false, laterRefusal: false, unpublished: false },
    { laggingPointer: true, laterRefusal: false, unpublished: false },
    { laggingPointer: false, laterRefusal: true, unpublished: false },
    { laggingPointer: false, laterRefusal: false, unpublished: true },
  ])("allows only one automatic fresh session before success (lagging pointer=$laggingPointer, later refusal=$laterRefusal, unpublished=$unpublished)", { timeout: 30_000 }, async ({ laggingPointer, laterRefusal, unpublished }, { signal, onTestFinished }) => {
    // Each row owns its adapter and facade. A timed-out row's eventual finally
    // must never restore another row's adapter or swap the shared heartbeat.
    const fixtureAdapterType = `${adapterType}_${randomUUID()}`;
    const adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, type: fixtureAdapterType });
    let service = heartbeatService(db);
    onTestFinished(async () => {
      try { await service.drainActiveRunExecutions(); }
      finally { unregisterServerAdapter(fixtureAdapterType); }
    });
    const f = await seed({}, fixtureAdapterType), oldSession = randomUUID(), freshSession = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", fixtureSessionId: oldSession } })
      .where(eq(agents.id, f.agentId));
    const executeIncident = (context: Record<string, unknown> = {}, status = "succeeded") => {
      signal.throwIfAborted();
      return execute(f, context, status, service);
    };
    await executeIncident();
    const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
    const [refused] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeSessionId: oldSession, nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(),
      error: "remote_warm_session_not_idle", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
    const recover = async (sourceRunId: string, expectedStatus = "succeeded") => {
      signal.throwIfAborted();
      const actionId = randomUUID();
      await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "system", returnOwnerAgentId: f.agentId,
        cause: "native_continuation_requires_reconciliation", fingerprint: actionId, nextAction: "Continue saved work",
        evidence: { continuationDelivery: "pending", executionReconciliation: { runId: sourceRunId,
          providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "The failed warm turn did not run." } },
      });
      return executeIncident({ source: "execution.reconciled", wakeReason: "issue_recovery_action_restored", forceFreshSession: true,
        recoveryActionId: actionId, previousRunId: sourceRunId, retryOfRunId: sourceRunId }, expectedStatus);
    };
    let refuseFresh = true;
    let failureText = laterRefusal ? "ordinary model failure" : "remote_warm_session_not_idle";
    registerServerAdapter({ ...adapter, type: fixtureAdapterType, execute: async input => {
      const result = await adapter.execute(input);
      if (!refuseFresh) return result;
      if (unpublished) throw new Error("remote_warm_session_not_idle");
      return { ...result, exitCode: 1, sessionId: freshSession, sessionParams: { sessionId: freshSession },
        errorMessage: failureText };
    } });
    try {
      const first = await recover(refused.id, "failed");
      expect(first.input.runtime.sessionId).toBeNull();
      if (laggingPointer) await db.update(agentTaskSessions).set({ sessionParamsJson: saved.sessionParamsJson,
        sessionDisplayId: oldSession, lastRunId: saved.lastRunId }).where(eq(agentTaskSessions.id, saved.id));
      let latest = first.finished.id;
      failureText = "remote_warm_session_not_idle";
      if (laterRefusal) {
        const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          nativeSessionId: freshSession, nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(),
          error: "remote_warm_session_not_idle", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
        latest = later.id;
      }
      // A new heartbeat facade emulates restart: no in-memory incident state.
      service = heartbeatService(db);
      for (let retry = 0; retry < 2; retry++) {
        const next = await recover(latest, "failed");
        expect(next.input.runtime.sessionId).toBe(unpublished ? oldSession : freshSession);
        if (!unpublished) expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false, taskSessionReused: true } } });
        expect(next.finished.contextSnapshot).toMatchObject({ warmRecoveryNoticeReason: "warm_recovery_fresh_session_already_attempted" });
        latest = next.finished.id;
        // A pre-claim failure may leave the same pointer behind on every retry.
        if (laggingPointer) await db.update(agentTaskSessions).set({ sessionParamsJson: saved.sessionParamsJson,
          sessionDisplayId: oldSession, lastRunId: saved.lastRunId }).where(eq(agentTaskSessions.id, saved.id));
      }
      const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(notices.filter(comment => comment.presentation?.title === "Fresh-session recovery already attempted"))
        .toMatchObject([{ authorType: "system", metadata: { sections: [{ rows: [
          { type: "key_value", label: "Reason", value: "warm_recovery_fresh_session_already_attempted" },
          { type: "run_link", runId: first.finished.id },
        ] }] } }]);
      // Success closes this incident, so a later refusal may get one fresh try.
      refuseFresh = false;
      signal.throwIfAborted();
      const progress = await executeIncident({ forceFreshSession: true, explicitFreshSession: true });
      expect(progress.input.runtime.sessionId).toBeNull();
      const [newRefusal] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        nativeSessionId: progress.finished.sessionIdAfter, nativeIssueId: f.issueId, status: "failed", finishedAt: new Date(),
        error: "remote_warm_session_not_idle", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
      const newIncident = await recover(newRefusal.id);
      expect(newIncident.input.runtime.sessionId).toBeNull();
    } finally {
      try { await service.drainActiveRunExecutions(); }
      finally { unregisterServerAdapter(fixtureAdapterType); }
    }
  });

  async function recoveryNoticeFixture() {
    const f = await seed(), sessionId = randomUUID(), incidentId = randomUUID();
    const runtimeConfig = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous" };
    const [agent] = await db.update(agents).set({ adapterConfig: runtimeConfig }).where(eq(agents.id, f.agentId)).returning();
    const [incident] = await db.insert(heartbeatRuns).values({ id: incidentId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: sessionId, status: "failed",
      createdAt: new Date(Date.now() - 1_000), finishedAt: new Date(), error: "remote_warm_session_not_idle",
      contextSnapshot: { issueId: f.issueId, warmRecoveryFreshSession: { runId: incidentId, retainedSessionId: sessionId } },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "queued", contextSnapshot: { issueId: f.issueId } }).returning();
    const input: HeartbeatSessionPreparationInput = { run, agent,
      task: { context: { forceFreshSession: true, source: "execution.reconciled", wakeReason: "issue_recovery_action_restored" },
        issueRef: { id: f.issueId }, issueContext: null, taskProjectContext: null, workspaceProjectContext: null,
        wakeCommentId: null, acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
      session: { taskSession: null, taskSessionDecodedParams: null, explicitResumeSessionParams: null,
        explicitResumeSessionDisplayId: null, sessionCodec: getAdapterSessionCodec(agent.adapterType) },
      config: { runtimeConfig, agentIdentity: undefined, issueAssigneeOverrides: null, originalAiIssueOverrides: null,
        managedAiRuntime: undefined, aiBinding: undefined, requestedAiBinding: undefined, secretManifest: [],
        runtimeSkillEntries: [], routineEnvContext: { env: null } },
      workspace: { requestedExecutionWorkspaceMode: "shared_workspace", effectiveExecutionWorkspaceMode: "shared_workspace",
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, executionPolicy: {} as never,
        requestedReusableExecutionWorkspaceConfig: null, reusableExistingExecutionWorkspace: null },
      environment: { environmentResolution: { environmentId: null, source: "default" }, selectedEnvironmentId: null,
        selectedEnvironmentForConfig: null }, getLatestAgentConfigRevision: async () => ({
          id: agent.id, changedKeys: [], createdAt: run.createdAt,
        }) };
    return { ...f, incident, input };
  }

  it("publishes the incident notice only after commit, never after rollback", async () => {
    const f = await recoveryNoticeFixture();
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "activity.logged") events.push(event.payload);
    });
    const transaction = db.transaction.bind(db);
    const rollback = vi.spyOn(db, "transaction").mockImplementationOnce((work, config) => transaction(async tx => {
      await work(tx);
      // The real comment, activity and receipt have been inserted, but are not committed.
      expect(await tx.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
      throw new Error("notice commit failed");
    }, config));
    try {
      await prepareHeartbeatSession(db, f.input).catch(() => null);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toHaveLength(0);
      expect(events).toEqual([]);
      rollback.mockRestore();
      await prepareHeartbeatSession(db, f.input);
      await prepareHeartbeatSession(db, f.input);
      expect(events).toHaveLength(1);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId))).toHaveLength(1);
    } finally { rollback.mockRestore(); unsubscribe(); }
  }, 30_000);

  it("a failed incident notice cannot fail recovery and the next attempt tries again", async () => {
    const f = await recoveryNoticeFixture();
    const transaction = db.transaction.bind(db);
    const rollback = vi.spyOn(db, "transaction").mockImplementationOnce((work, config) => transaction(async tx => {
      await work(tx);
      throw new Error("notice commit failed");
    }, config));
    try {
      await expect(prepareHeartbeatSession(db, f.input)).resolves.toMatchObject({
        resetTaskSession: false, taskResumeSessionId: f.incident.nativeSessionId,
      });
      const [incident] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.incident.id));
      expect(incident.contextSnapshot).toMatchObject({ warmRecoveryFreshSession: { runId: incident.id } });
      expect((incident.contextSnapshot?.warmRecoveryFreshSession as Record<string, unknown>).noticeRecorded).toBeUndefined();
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      rollback.mockRestore();
      await prepareHeartbeatSession(db, f.input);
      const [recorded] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.incident.id));
      expect(recorded.contextSnapshot).toMatchObject({ warmRecoveryFreshSession: { noticeRecorded: true } });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    } finally { rollback.mockRestore(); }
  }, 30_000);

  it("an open incident permits stock reset after a non-continuable configuration change", async () => {
    const f = await seed(), sessionId = randomUUID(), incidentId = randomUUID();
    const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", fixtureSessionId: sessionId };
    await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
    await execute(f);
    await db.insert(heartbeatRuns).values({ id: incidentId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: sessionId, status: "failed",
      finishedAt: new Date(), error: "remote_warm_session_not_idle",
      contextSnapshot: { issueId: f.issueId, warmRecoveryFreshSession: { runId: incidentId, retainedSessionId: sessionId } } });
    await db.update(agents).set({ adapterConfig: { ...config, fixtureOption: "changed" } }).where(eq(agents.id, f.agentId));
    const select = runtimeSelection.prepareAndSelectHeartbeatRuntime;
    let selectionSession: runtimeSelection.HeartbeatRuntimeSelectionInput["session"] | undefined;
    const capture = vi.spyOn(runtimeSelection, "prepareAndSelectHeartbeatRuntime").mockImplementation(async (...args) => {
      selectionSession = args[1].session;
      return select(...args);
    });
    try {
      const next = await execute(f, { forceFreshSession: true, wakeReason: "issue_recovery_action_restored" });
      expect(next.input.runtime.sessionId).toBeNull();
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionReused: false } } });
      expect(selectionSession).toMatchObject({ taskResumeSessionId: null, warmRecoveryRetainSessionId: null });
      const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.body).not.toContain("keeps the saved session");
      expect(notices[0]!.body).toContain("Other session-reset rules still apply.");
      process.stdout.write(`RECOVERY_STOCK_RESET_NOTICE ${JSON.stringify({ runId: next.finished.id,
        reset: true, selectionSession, body: notices[0]!.body })}\n`);
    } finally { capture.mockRestore(); }
  }, 30_000);

  it.each(["person Retry", "stock reset"])("ends an S1 incident when %s starts S2 even if S2 fails", async decision => {
    const type = `${adapterType}_${randomUUID()}`, adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, type });
    const service = heartbeatService(db);
    const f = await seed({}, type), s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID(), incidentId = randomUUID();
    const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", fixtureSessionId: s1 };
    try {
      await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
      await execute(f, {}, "succeeded", service);
      await db.insert(heartbeatRuns).values({ id: incidentId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: s1, status: "failed",
        finishedAt: new Date(), error: "remote_warm_session_not_idle",
        contextSnapshot: { issueId: f.issueId, warmRecoveryFreshSession: { runId: incidentId, retainedSessionId: s1 } } });
      let freshSession = s2;
      registerServerAdapter({ ...adapter, type, execute: async input => {
        const result = await adapter.execute(input);
        const sessionId = input.runtime.sessionId ?? freshSession;
        return { ...result, exitCode: 1, sessionId, sessionParams: { sessionId }, errorMessage: "remote_warm_session_not_idle" };
      } });
      if (decision === "stock reset") await db.update(agents).set({ adapterConfig: { ...config, fixtureOption: "changed" } })
        .where(eq(agents.id, f.agentId));
      const later = await execute(f, decision === "person Retry" ? { forceFreshSession: true, explicitFreshSession: true } :
        { forceFreshSession: true, wakeReason: "issue_recovery_action_restored" }, "failed", service);
      expect(later.input.runtime.sessionId).toBeNull();
      expect(later.finished.sessionIdAfter).toBe(s2);
      freshSession = s3;
      const recovery = { forceFreshSession: true, wakeReason: "issue_recovery_action_restored" };
      const next = await execute(f, recovery, "failed", service);
      expect(next.input.runtime.sessionId).not.toBe(s1);
      expect(next.input.runtime.sessionId).toBeNull();
      expect(next.finished.contextSnapshot).toMatchObject({ warmRecoveryFreshSession: {
        runId: next.finished.id, retainedSessionId: s2, refusedRunId: later.finished.id,
      } });
      // Restart the facade: the later session boundary and new incident must be durable.
      const restarted = heartbeatService(db);
      const subsequent = [];
      try {
        for (let retry = 0; retry < 2; retry++) {
          const kept = await execute(f, recovery, "failed", restarted);
          expect(kept.input.runtime.sessionId).toBe(s3);
          expect(kept.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false } } });
          subsequent.push({ runId: kept.finished.id, resumes: kept.input.runtime.sessionId });
        }
      } finally { await restarted.drainActiveRunExecutions(); }
      process.stdout.write(`RECOVERY_LATER_SESSION_BOUNDARY ${JSON.stringify({ decision, s1, s2, s3,
        laterRunId: later.finished.id, nextRunId: next.finished.id, subsequent })}\n`);
    } finally {
      try { await service.drainActiveRunExecutions(); }
      finally { unregisterServerAdapter(type); }
    }
  }, 30_000);

  it.each([
    { failure: "native_controller_recovery_missing_evidence:retained_sandbox_binding", fresh: true },
    { failure: "ordinary provider failure", fresh: false },
    { failure: "remote_warm_session_not_idle", fresh: false },
  ])("task HTTP Retry matches the notice on continuous Pi: $failure, fresh=$fresh", async ({ failure, fresh }) => {
    const f = await seed(), sessionId = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model",
      sessionContinuity: "continuous", fixtureSessionId: sessionId } }).where(eq(agents.id, f.agentId));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await db.update(issues).set({ workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "project_primary" } } }).where(eq(issues.id, f.issueId));
      const first = await execute(f);
      await db.update(executionWorkspaces).set({ status: "active", closedAt: null }).where(eq(executionWorkspaces.id, String(first.input.context.executionWorkspaceId)));
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_continuation_requires_reconciliation", error: failure })
        .where(eq(heartbeatRuns.id, first.finished.id));
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId: f.userId, source: "local_implicit",
        companyIds: [f.companyId], isInstanceAdmin: true }; next(); });
      app.use("/api", issueRoutes(db, getStorageService())); app.use(errorHandler);
      const response = await request(app).post(`/api/issues/${f.issueId}/retry`).send({ observedRunId: first.finished.id, idempotencyKey: randomUUID() });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      await heartbeat.drainActiveRunExecutions();
      const retries = [...captured.values()].filter(input => input.runId !== first.finished.id && input.context.issueId === f.issueId);
      expect(retries.map(input => input.runtime.sessionId)).toEqual([fresh ? null : sessionId]);
      expect(retries.map(input => input.context.explicitFreshSession === true)).toEqual([fresh]);
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retries[0]!.runId));
      expect(finished.status).toBe("succeeded");
      process.stdout.write(`RECOVERY_HTTP_RETRY ${JSON.stringify({ route: "issues", failure, sourceRunId: first.finished.id,
        successorRunId: finished.id, startsNewSession: fresh, resumes: retries[0]!.runtime.sessionId,
        explicitFreshSession: retries[0]!.context.explicitFreshSession === true })}\n`);
    } finally { await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false }); }
  }, 60_000);

  // CHPROBE-7: a different ID is not an authorized fresh-session boundary.
  it("keeps S1 after a plain wake resumes refused S0 through a lagging pointer", async () => {
    const type = `${adapterType}_${randomUUID()}`, adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, type });
    const service = heartbeatService(db);
    const f = await seed({}, type), s0 = randomUUID(), s1 = randomUUID(), incidentId = randomUUID();
    try {
      await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model",
        sessionContinuity: "continuous", fixtureSessionId: s0 } }).where(eq(agents.id, f.agentId));
      await execute(f, {}, "succeeded", service);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      await db.insert(heartbeatRuns).values({ id: incidentId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: s1, status: "failed",
        finishedAt: new Date(), error: "remote_warm_session_not_idle",
        contextSnapshot: { issueId: f.issueId, warmRecoveryFreshSession: { runId: incidentId, retainedSessionId: s0 } } });
      registerServerAdapter({ ...adapter, type, execute: async input => {
        const result = await adapter.execute(input);
        const sessionId = input.runtime.sessionId ?? randomUUID();
        return { ...result, exitCode: 1, sessionId, sessionParams: { sessionId }, errorMessage: "remote_warm_session_not_idle" };
      } });
      for (let round = 0; round < 2; round++) {
        const plain = await execute(f, {}, "failed", service);
        expect(plain.input.runtime.sessionId).toBe(s0);
        expect(plain.finished.sessionIdBefore).toBe(s0);
        expect(plain.finished.sessionIdAfter).toBe(s0);
        expect(plain.finished.contextSnapshot?.explicitFreshSession).not.toBe(true);
        expect(plain.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false } } });
        const recovery = await execute(f, { forceFreshSession: true, wakeReason: "issue_recovery_action_restored" }, "failed", service);
        process.stdout.write(`RECOVERY_PLAIN_OLDER_SESSION ${JSON.stringify({ round, s0, s1, incidentId,
          plainRunId: plain.finished.id, plainResumes: plain.input.runtime.sessionId,
          plainReset: false, recoveryRunId: recovery.finished.id, recoveryResumes: recovery.input.runtime.sessionId,
          recoveryResult: recovery.finished.resultJson, recoveryContext: recovery.finished.contextSnapshot })}\n`);
        expect(recovery.input.runtime.sessionId).toBe(s1);
        expect(recovery.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false } } });
        expect(recovery.finished.contextSnapshot?.warmRecoveryFreshSession).toBeUndefined();
        expect(recovery.finished.contextSnapshot?.warmRecoveryNoticeReason).toBe("warm_recovery_fresh_session_already_attempted");
        await db.update(agentTaskSessions).set({ sessionParamsJson: saved.sessionParamsJson,
          sessionDisplayId: s0, lastRunId: saved.lastRunId }).where(eq(agentTaskSessions.id, saved.id));
      }
      const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.presentation?.title).toBe("Fresh-session recovery already attempted");
    } finally {
      try { await service.drainActiveRunExecutions(); }
      finally { unregisterServerAdapter(type); }
    }
  }, 30_000);

  it.each([
    { authority: "Retry", started: false }, { authority: "reset", started: false },
    { authority: "Retry", started: true }, { authority: "reset", started: true },
    { authority: "credential", started: false }, { authority: "credential", started: true },
    { authority: "wrong credential run", started: true }, { authority: "none", started: true },
  ])("a selected native session ends an incident only with start evidence: $authority, started=$started", async ({ authority, started }) => {
    const f = await recoveryNoticeFixture(), sessionId = randomUUID(), laterId = randomUUID();
    const authorizedStart = started && authority !== "wrong credential run" && authority !== "none";
    const [later] = await db.insert(heartbeatRuns).values({ id: laterId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeSessionId: sessionId, status: "failed", error: "remote_warm_session_not_idle",
      contextSnapshot: { issueId: f.issueId, ...(authority === "Retry" ? { explicitFreshSession: true } : {}) },
      resultJson: { configFreshness: { session: { reset: authority === "reset",
        ...(authority.includes("credential") ? { credentialIdentityResetRunId: authority === "credential" ? laterId : randomUUID() } : {}),
      } } },
    }).returning();
    if (started) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
      runId: later.id, seq: 1, eventType: "session.started", payload: { prpEvent: { normalizedSessionId: sessionId } } });
    // The current run must follow the candidate boundary in durable order.
    const [current] = await db.update(heartbeatRuns).set({ createdAt: new Date(later.createdAt.getTime() + 1) })
      .where(eq(heartbeatRuns.id, f.input.run.id)).returning();
    const next = await prepareHeartbeatSession(db, { ...f.input, run: current });
    expect(next.resetTaskSession).toBe(authorizedStart);
    expect(next.warmRecoveryRetainSessionId).toBe(authorizedStart ? null : f.incident.nativeSessionId);
  });

  // CHPROBE-6: neither a refused nor an ordinary older-session wake is authority.
  it.each([true, false].flatMap(native => [true, false].map(refused => ({ native, refused }))))(
    "keeps the incident across an unauthorized older session: native=$native, refused=$refused", async ({ native, refused }) => {
      const f = await recoveryNoticeFixture(), s0 = randomUUID();
      const [older] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, ...(native ? { nativeSessionId: s0 } : { sessionIdBefore: s0, sessionIdAfter: s0 }),
        status: "failed", error: refused ? "remote_warm_session_not_idle" : "ordinary provider failure",
        resultJson: { configFreshness: { session: { reset: false } } },
      }).returning();
      if (native) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
        runId: older.id, seq: 1, eventType: "session.started", payload: { prpEvent: { normalizedSessionId: s0 } } });
      const [current] = await db.update(heartbeatRuns).set({ createdAt: new Date(older.createdAt.getTime() + 1) })
        .where(eq(heartbeatRuns.id, f.input.run.id)).returning();
      for (let round = 0; round < 2; round++) {
        const next = await prepareHeartbeatSession(db, { ...f.input, run: current });
        expect(next.resetTaskSession).toBe(false);
        expect(next.taskResumeSessionId).toBe(f.incident.nativeSessionId);
        expect(next.warmRecoveryRetainSessionId).toBe(f.incident.nativeSessionId);
      }
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    });

  it("writes the incident notice without deadlocking an issue-then-run lock holder", async () => {
    const f = await recoveryNoticeFixture();
    let issueHeld!: () => void, continueHolder!: () => void, holderPid = 0;
    const held = new Promise<void>(resolve => { issueHeld = resolve; });
    const proceed = new Promise<void>(resolve => { continueHolder = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '8s'`);
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = connection!.pid;
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      issueHeld();
      await proceed;
      // This is the order used by ordinary issue mutation/admission paths.
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.incident.id)).for("update");
    });
    await held;
    const notice = prepareHeartbeatSession(db, f.input);
    const settled = Promise.allSettled([holder, notice]);
    try {
      // Synchronize on a real PostgreSQL lock wait, not a sleep or mocked SQL.
      await expect.poll(async () => {
        const rows = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ${holderPid} = any(pg_blocking_pids(pid))`);
        return rows.length;
      }, { timeout: 5_000, interval: 20 }).toBeGreaterThan(0);
    } finally { continueHolder(); await settled; }
    const outcomes = await settled;
    process.stdout.write(`RECOVERY_NOTICE_LOCK_PG ${JSON.stringify({ issueId: f.issueId, incidentId: f.incident.id,
      holderPid, outcomes: outcomes.map(result => result.status === "fulfilled" ? { status: result.status } : {
        status: result.status, code: result.reason?.cause?.code, message: result.reason?.cause?.message ?? String(result.reason),
      }) })}\n`);
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });

  it("writes one system incident notice and creates zero task wake requests", async () => {
    const f = await recoveryNoticeFixture();
    // Repeated preparation (including another facade/process) shares only the durable receipt.
    await Promise.all([prepareHeartbeatSession(db, f.input), prepareHeartbeatSession(db, {
      ...f.input, task: { ...f.input.task, context: { ...f.input.task.context } },
    })]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toMatchObject([{ authorType: "system", authorAgentId: null, authorUserId: null,
      createdByRunId: null, presentation: { kind: "system_notice", title: "Fresh-session recovery already attempted" } }]);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe("This task's saved session could not be resumed. Paperclip already tried one new session without a successful turn, " +
      "so automatic recovery will not request another new session for this incident. Other session-reset rules still apply. " +
      "Retry on the task starts a new session when the failed run reports that its saved session cannot continue; " +
      "otherwise it tries the saved session again.");
    // TaskChatThread.tsx:955-957 removes system-owned, historical and redundant
    // recovery notices. This is a durable record, not live recovery ownership.
    // status-relevance.ts:74-81 derives historical provenance from all four
    // run fields (or recovery.actionId); none belongs on this dated notice.
    const notice = comments[0]!;
    expect(notice.metadata?.recoveryResponsibility).toBeUndefined();
    expect(notice.metadata?.sourceRunId).toBeUndefined();
    expect(notice.metadata?.recovery?.actionId).toBeUndefined();
    expect(notice.createdByRunId).toBeNull();
    expect(notice).not.toHaveProperty("runId");
    expect(notice.derivedCreatedByRunId).toBeNull();
    // issue-chat-messages.ts:1152-1164 only removes the two live AI/config
    // blocker titles, never this record. Its run remains reachable in details.
    expect(["AI connection needs attention", "Configuration incomplete"]).not.toContain(notice.presentation?.title);
    expect(JSON.stringify(notice.metadata?.sections)).toContain(f.incident.id);
    process.stdout.write(`RECOVERY_VISIBLE_NOTICE_PG ${JSON.stringify(notice)}\n`);
    // Stronger than task/recipient-only: this notice creates no request for
    // ANY agent in its company, regardless of reason or payload routing.
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(0);
    process.stdout.write(`RECOVERY_NOTICE_NO_WAKE_PG ${JSON.stringify({ issueId: f.issueId, incidentId: f.incident.id,
      commentId: comments[0]!.id, authorType: comments[0]!.authorType, presentation: comments[0]!.presentation,
      wakeRequestScope: "entire_company_all_agents", wakeRequestCount: wakes.length })}\n`);
  });

  it("a newer successful run on the exact session blocks an old refusal", async () => {
    const f = await seed(), sessionId = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model", fixtureSessionId: sessionId } })
      .where(eq(agents.id, f.agentId));
    await execute(f);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeSessionId: sessionId,
      nativeIssueId: f.issueId, status: "failed", error: "remote_warm_session_not_idle" });
    await execute(f);
    const next = await execute(f, { wakeReason: "issue_recovery_action_restored", forceFreshSession: true });
    expect(next.input.runtime.sessionId).toBe(sessionId);
  });

  it("keeps a workspace source refusal typed before provider startup", async () => {
    const f = await seed(), type = `${adapterType}_source_refusal`;
    registerServerAdapter({ ...getServerAdapter(adapterType), type,
      execute: async () => { throw new NativeProviderStateIncompatibleError("workspace_continuation_source_missing"); } });
    try {
      await db.update(agents).set({ adapterType: type }).where(eq(agents.id, f.agentId));
      const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(finished).toMatchObject({ status: "failed", errorCode: "native_provider_state_incompatible",
        error: expect.stringContaining("workspace_continuation_source_missing") });
    } finally { unregisterServerAdapter(type); }
  });

  it("reuses unchanged task sessions and strips host freshness metadata before dispatch", async () => {
    const f = await seed();
    const first = await execute(f);
    expect(first.input.runtime.sessionId).toBeNull();
    const stored = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId)).then(rows => rows[0]);
    expect(stored?.sessionParamsJson).toHaveProperty("__paperclipConfigFingerprint");
    const resumed = await execute(f, { paperclipSessionHandoffMarkdown: "stale handoff", paperclipSessionRotationReason: "stale reason", paperclipPreviousSessionId: "stale session" });
    expect(resumed.input.runtime).toMatchObject({ sessionId: "saved-session", sessionDisplayId: "saved-session", taskKey: f.issueId });
    expect(resumed.input.runtime.sessionParams).toMatchObject({ sessionId: "saved-session", adapterState: "preserved" });
    expect(resumed.input.runtime.sessionParams).not.toHaveProperty("__paperclipConfigFingerprint");
    expect(resumed.input.context.paperclipSessionHandoffMarkdown).toBeUndefined();
    expect(resumed.input.context.paperclipSessionRotationReason).toBeUndefined();
    expect(resumed.input.context.paperclipPreviousSessionId).toBeUndefined();
    expect(resumed.finished.sessionIdBefore).toBe("saved-session");
  });

  it("keeps a default-attached project policy stable after binding a repository-free workspace", async () => {
    const f = await seed();
    const storage = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, storage.pluginId));
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson, workspaceProvider: {
      ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
    } } }).where(eq(plugins.id, storage.pluginId));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Directory project", executionWorkspacePolicy: { enabled: true, storageProviderPluginId: storage.pluginId } }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
    try {
      const first = await execute(f);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound.executionWorkspaceId).toEqual(expect.any(String));
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe("saved-session");
      expect(next.input.config.workspaceStrategy).toEqual(first.input.config.workspaceStrategy);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: {
        session: { reset: false, taskSessionReused: true, changedCategories: [] },
        workspace: { action: "reuse", workspaceReused: true, changedCategories: [], activeWorkspaceId: bound.executionWorkspaceId },
      } });
    } finally { await db.delete(plugins).where(eq(plugins.id, storage.pluginId)); }
  });

  it.each([
    { settings: null, retry: false },
    { settings: { mode: "isolated_workspace" }, retry: false },
    { settings: { workspaceStrategy: { type: "git_worktree", branchTemplate: "work" } }, retry: false },
    { settings: null, retry: true },
    { settings: null, retry: true, refuse: true },
  ])("keeps a default-attached repository policy stable through binding ($settings, Retry: $retry, refusal: $refuse)", async ({ settings, retry, refuse }) => {
    const f = await seed();
    const storage = await createPluginWorkspaceFixture(db, f.companyId);
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, storage.pluginId));
    const [environment] = await db.insert(environments).values({ name: `Storage tasks ${storage.pluginId}`, driver: "plugin", status: "active",
      config: { pluginKey: plugin.pluginKey, driverKey: "tasks", driverConfig: {} } }).returning();
    await db.update(plugins).set({ manifestJson: { ...plugin.manifestJson,
      capabilities: [...plugin.manifestJson.capabilities, "environment.drivers.register"],
      environmentDrivers: [{ driverKey: "tasks", displayName: "Tasks", supportsTasks: true, configSchema: { type: "object" },
        ...(refuse ? { freshWorkspaceVersion: 1 as const } : {}) }],
      workspaceProvider: { ...plugin.manifestJson.workspaceProvider!, defaultForProjects: { mode: "isolated_workspace", strategy: "git_worktree" },
        ...(retry ? { workspaceVerificationVersion: 1 as const } : {}),
        ...(refuse ? { freshWorkspaceVersion: 1 as const } : {}) },
    } }).where(eq(plugins.id, storage.pluginId));
    await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, f.agentId));
    await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, storageProviderPluginId: storage.pluginId } }).where(eq(projects.id, storage.input.projectId));
    await db.update(issues).set({ projectId: storage.input.projectId, projectWorkspaceId: storage.input.projectWorkspaceId,
      executionWorkspaceSettings: settings,
    }).where(eq(issues.id, f.issueId));
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true, enableIsolatedWorkspacesByDefault: true });
    const cwd = await mkdtemp(join(tmpdir(), "session-provider-fixture-"));
    const realizedBase = new Map<string, string | null | undefined>();
    const createOrchestrator = environmentOrchestrator.environmentRunOrchestrator;
    const realization = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...createOrchestrator(...args),
      // These tests dispatch a synthetic adapter; substitute only the provider
      // transport while preserving the configured storage/task-driver identity.
      acquireForRun: async input => createOrchestrator(...args).acquireForRun({ ...input, selectedEnvironmentId: input.localEnvironmentId }),
      realizeForRun: async input => {
        realizedBase.set(input.heartbeatRunId, input.executionWorkspace.baseRefSha);
        input.executionWorkspace.cwd = cwd;
        return { lease: input.lease, persistedExecutionWorkspace: input.persistedExecutionWorkspace,
          workspaceRealization: {}, executionTarget: null, remoteExecution: null };
      },
    }));
    const mode = refuse ? vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
    }) : undefined;
    const credentialAcquisition = vi.spyOn(aiRuntime, "prepareManagedAiRuntime");
    if (refuse) {
      const account = await aiConnectionService(db).save(f.companyId, f.userId, {
        provider: "openai", method: "api_key", ownership: "personal", name: "Retry fixture",
        apiKey: "fixture-key", agentIds: [], allAgents: true,
      }, "fixture-key");
      await db.update(agents).set({ adapterType: "paperclip_runner",
        adapterConfig: { provider: "codex", model: "model-a" },
        runtimeConfig: { aiConnection: { provider: "openai", method: "api_key", mode: "delegated",
          connectionId: account.connectionId, grantId: account.grantId } },
      }).where(eq(agents.id, f.agentId));
      registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    }
    const originalHeartbeat = heartbeat;
    const storageWorkers = {
      ...storage.workers,
      call: async (...args: Parameters<typeof storage.workers.call>) => {
        const result = await storage.workers.call(...args) as Record<string, unknown>;
        const request = storage.calls.at(-1)!;
        if (request.operation.verifyExisting) {
          if (refuse) throw new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Checkout unavailable",
            data: workspaceOperationErrorData(new PluginWorkspaceOperationError("binding_mismatch")),
          });
          return { ...result, created: false };
        }
        if (refuse && result.kind === "prepared" && request.operation.fresh) return { ...result, branchName: "work" };
        return result;
      },
    };
    heartbeat = heartbeatService(db, { pluginWorkerManager: storageWorkers as PluginWorkerManager });
    try {
      const first = await execute(f);
      const [bound] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(bound.executionWorkspaceId).toEqual(expect.any(String));
      expect(bound.executionWorkspacePreference).toBe("reuse_existing");
      expect(bound.executionWorkspaceSettings).toEqual({ ...settings, mode: "isolated_workspace" });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      expect([...captured.values()].filter(input => input.context.issueId === f.issueId)).toHaveLength(1);
      expect(workspace).toMatchObject({ providerType: "plugin", strategyType: "git_worktree" });
      if (retry) {
        await db.update(heartbeatRuns).set({ status: "failed", errorCode: "setup_failed" })
          .where(eq(heartbeatRuns.id, first.finished.id));
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
        const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId,
          actorId: f.userId, actorSource: "local_implicit", observedRunId: first.finished.id, idempotencyKey: randomUUID() });
        expect(receipt.accepted).toBe(true);
        credentialAcquisition.mockClear();
        await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
        await heartbeat.drainActiveRunExecutions();
        const [resumed] = [...captured.values()].filter(input => input.context.issueId === f.issueId && input.runId !== first.finished.id);
        if (refuse) {
          expect(resumed?.runtime.sessionId).toBeNull();
          const finished = await heartbeat.getRun(resumed.runId);
          expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
          expect(credentialAcquisition).toHaveBeenCalledTimes(1);
          const [afterRetry] = await db.select().from(issues).where(eq(issues.id, f.issueId));
          expect(afterRetry.executionWorkspaceId).not.toBe(workspace.id);
          const [fresh] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, afterRetry.executionWorkspaceId!));
          expect(fresh).toMatchObject({ mode: "isolated_workspace", metadata: {
            workspaceProviderFresh: { previousWorkspaceId: workspace.id, sourceRunId: first.finished.id },
          } });
          expect(storage.calls.filter(call => call.runId === resumed.runId && call.operation.kind === "prepare"))
            .toMatchObject([{ executionWorkspaceId: workspace.id, operation: { verifyExisting: true } },
              { executionWorkspaceId: fresh.id, operation: { fresh: { previousWorkspaceId: workspace.id } } }]);
          return;
        }
        expect(resumed?.context.paperclipWorkspace).toMatchObject({ branchName: workspace.branchName });
        expect(realizedBase.get(first.finished.id)).toBe("a".repeat(40));
        expect(realizedBase.get(resumed.runId)).toBe(realizedBase.get(first.finished.id));
        const preparations = storage.calls.filter(call => call.runId === resumed.runId && call.operation.kind === "prepare");
        expect(preparations).toHaveLength(2);
        expect(preparations[0]).toMatchObject({ executionWorkspaceId: workspace.id, operation: { verifyExisting: true } });
        expect(preparations[1]).toMatchObject({ executionWorkspaceId: workspace.id });
        expect(preparations[1].operation.verifyExisting).toBeUndefined();
        const [afterRetry] = await db.select().from(issues).where(eq(issues.id, f.issueId));
        expect(afterRetry.executionWorkspaceId).toBe(workspace.id);
        return;
      }
      for (let turn = 0; turn < 2; turn++) {
        const next = await execute(f);
        expect(next.input.runtime.sessionId).toBe("saved-session");
        expect(next.input.config.workspaceStrategy).toEqual(first.input.config.workspaceStrategy);
        expect(next.finished.resultJson).toMatchObject({ configFreshness: {
          session: { reset: false, taskSessionReused: true, changedCategories: [] },
          workspace: { action: "reuse", workspaceReused: true, changedCategories: [], activeWorkspaceId: bound.executionWorkspaceId },
        } });
      }
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, allowIssueOverride: false, storageProviderPluginId: storage.pluginId } }).where(eq(projects.id, storage.input.projectId));
      const changed = await execute(f);
      expect(changed.input.runtime.sessionId).toBeNull();
      expect(changed.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, changedCategories: ["workspaceConfig"] } } });
      const [retained] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, bound.executionWorkspaceId!));
      expect(retained.metadata?.workspaceProviderOwner).toBe(storage.pluginId);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      heartbeat = originalHeartbeat;
      realization.mockRestore();
      credentialAcquisition.mockRestore();
      mode?.mockRestore();
      if (refuse) unregisterServerAdapter("paperclip_runner");
      await rm(cwd, { recursive: true, force: true });
      await db.delete(plugins).where(eq(plugins.id, storage.pluginId));
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false, enableIsolatedWorkspacesByDefault: false });
    }
  });

  it.each([
    { key: "model", continuity: "continuous", retain: true, conversation: true },
    { key: "piRpcThinkingLevel", continuity: "continuous", retain: true, conversation: true },
    { key: "model", continuity: "continuous", retain: true, conversation: false },
    { key: "piRpcThinkingLevel", continuity: "continuous", retain: true, conversation: false },
    { key: "model", continuity: "paperclip", retain: false },
    { key: "piRpcThinkingLevel", continuity: "paperclip", retain: false },
    { key: "provider", continuity: "continuous", retain: false },
    { key: "adapterType", continuity: "continuous", retain: false },
  ])("held configuration: changed $key in $continuity (agent chat=$conversation) retains session: $retain", async ({ key, continuity, retain, conversation }) => {
    const { agentService } = await import("../services/agents.js");
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "hold-config-continuation-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const config = { provider: "pi_rpc", model: "fixture/model-a", piRpcThinkingLevel: "low", sessionContinuity: continuity, cwd };
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      if (conversation) await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
      await execute(f);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      expect(saved.sessionParamsJson?.sessionId).toBe("saved-session");
      const nextConfig = { ...config, ...(key === "adapterType" ? {} : {
        [key]: key === "model" ? "fixture/model-b" : key === "provider" ? "codex" : "high",
      }) };
      await agentService(db).update(f.agentId, { adapterConfig: nextConfig,
        ...(key === "adapterType" ? { adapterType } : {}) });
      const [retained] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      if (retain) expect(retained?.id).toBe(saved.id);
      else if (key !== "piRpcThinkingLevel") expect(retained).toBeUndefined();
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe(retain ? "saved-session" : null);
      if (key !== "adapterType") expect(next.input.config[key]).toBe(nextConfig[key as keyof typeof nextConfig]);
      expect(next.finished.sessionIdBefore).toBe(retain ? "saved-session" : null);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        ...(retain ? { reset: false } : {}), taskSessionReused: retain,
      } } });
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    { continuity: "continuous", conversation: true, retain: true },
    { continuity: "continuous", conversation: false, retain: true },
    { continuity: "paperclip", conversation: true, retain: false },
    { continuity: "paperclip", conversation: false, retain: false },
  ])("idle issue override: model then level in $continuity (agent chat=$conversation) retains session: $retain", async ({ continuity, conversation, retain }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "issue-config-continuation-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const config = { provider: "pi_rpc", model: "fixture/model-a", piRpcThinkingLevel: "low", sessionContinuity: continuity, cwd };
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      if (conversation) await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
      await execute(f);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      for (const adapterConfig of [
        { model: "fixture/model-b", piRpcThinkingLevel: "low" },
        { model: "fixture/model-b", piRpcThinkingLevel: "high" },
        { model: "fixture/model-b", piRpcThinkingLevel: "high", env: { CONTEXT_NOTE: "new" } },
      ]) {
        const [idle] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        expect(idle.status).toBe("idle");
        await db.update(issues).set({ assigneeAdapterOverrides: { adapterConfig }, updatedAt: new Date() }).where(eq(issues.id, f.issueId));
        const [before] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
        expect(before.id).toBe(saved.id);
        const next = await execute(f);
        expect(next.input.config).toMatchObject(adapterConfig);
        expect(next.input.runtime.sessionId).toBe(retain ? "saved-session" : null);
        expect(next.input.runtime.sessionParams).toEqual(retain ? { sessionId: "saved-session", adapterState: "preserved" } : null);
        expect(next.finished.sessionIdBefore).toBe(retain ? "saved-session" : null);
        expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
          reset: !retain, taskSessionAvailable: true, taskSessionReused: retain,
        } } });
      }
      await db.update(issues).set({ assigneeAdapterOverrides: { adapterConfig: {
        model: "fixture/model-b", piRpcThinkingLevel: "high", fixtureOption: "changed",
      } } }).where(eq(issues.id, f.issueId));
      const unrelated = await execute(f);
      expect(unrelated.input.runtime.sessionId).toBeNull();
      expect(unrelated.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: true, taskSessionAvailable: true, taskSessionReused: false,
        changedCategories: expect.arrayContaining(["issueOverrides"]),
      } } });
      const [unchanged] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(unchanged.adapterConfig).toEqual(config);
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([false, true])("old-shape chip fingerprint: changed non-model override=%s resets only when changed", async changed => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "chip-fingerprint-compat-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const adapterConfig = { model: "fixture/model-b", piRpcThinkingLevel: "high", fixtureOption: "original" };
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
        provider: "pi_rpc", model: "fixture/model-a", sessionContinuity: "continuous", cwd,
      } }).where(eq(agents.id, f.agentId));
      await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active",
        assigneeAdapterOverrides: { adapterConfig },
      }).where(eq(issues.id, f.issueId));
      // The previous release hashed issue overrides without dropping model and level.
      const oldShape = vi.spyOn(sessionFingerprintInputs, "paperclipRunnerSessionIssueOverrides").mockImplementation(overrides => overrides);
      try { await execute(f); } finally { oldShape.mockRestore(); }
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      if (changed) await db.update(issues).set({ assigneeAdapterOverrides: {
        adapterConfig: { ...adapterConfig, fixtureOption: "different" },
      } }).where(eq(issues.id, f.issueId));
      const next = await execute(f);
      expect(next.input.config).toMatchObject({ ...adapterConfig, fixtureOption: changed ? "different" : "original" });
      expect(next.input.runtime.sessionId).toBe(changed ? null : "saved-session");
      expect(next.finished.sessionIdBefore).toBe(changed ? null : "saved-session");
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: changed, taskSessionAvailable: true, taskSessionReused: !changed,
        changedCategories: changed ? expect.arrayContaining(["issueOverrides"]) : [],
      } } });
      const [updated] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      expect(updated.sessionParamsJson?.__paperclipConfigFingerprint).not.toBe(saved.sessionParamsJson?.__paperclipConfigFingerprint);
      if (!changed) {
        const followup = await execute(f);
        expect(followup.input.runtime.sessionId).toBe("saved-session");
        expect(followup.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: false, taskSessionReused: true } } });
      }
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each(["continuous", "paperclip"])("held configuration: an INSTRUCTIONS save continues Pi only in continuous mode (%s)", async sessionContinuity => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "pi-instructions-freshness-"));
    const { resolveManagedInstructionsRoot } = await import("../services/agent-instructions.js");
    const instructionsRoot = resolveManagedInstructionsRoot({ id: f.agentId, companyId: f.companyId, name: "Session reader", adapterConfig: {} });
    await mkdir(instructionsRoot, { recursive: true });
    const instructionsFilePath = join(instructionsRoot, "INSTRUCTIONS.md");
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    try {
      await writeFile(instructionsFilePath, "Original instructions.\n");
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: {
        provider: "pi_rpc", model: "fixture/model-a", sessionContinuity, cwd, instructionsFilePath,
        instructionsRootPath: instructionsRoot, instructionsEntryFile: "INSTRUCTIONS.md", instructionsBundleMode: "managed",
      } }).where(eq(agents.id, f.agentId));
      const { agentInstructionRevisionService } = await import("../services/agent-instruction-revisions.js");
      const revisions = agentInstructionRevisionService(db);
      const actor = { type: "board" as const, source: "local_implicit" as const, userId: f.userId };
      const target = { companyId: f.companyId, agentId: f.agentId };
      const before = await revisions.readCurrent(target, actor);
      await execute(f);
      await revisions.commit({ ...target, entryFile: "INSTRUCTIONS.md", content: "Changed instructions.\n",
        baseRevisionId: before!.revision.id, source: "board" }, actor);
      const next = await execute(f);
      const retain = sessionContinuity === "continuous";
      expect(next.input.runtime.sessionId).toBe(retain ? "saved-session" : null);
      expect(next.finished.sessionIdBefore).toBe(retain ? "saved-session" : null);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: !retain, taskSessionReused: retain, changedCategories: ["instructions"],
        resetReasons: ["effective run configuration changed: instructions"],
      } } });
    } finally {
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner");
      await rm(cwd, { recursive: true, force: true });
      await rm(instructionsRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["pi_rpc", undefined, true], ["pi_rpc", "paperclip", false],
    ["codex", undefined, false], ["codex", "continuous", true],
  ])("does not replay comments already carried by full continuation in whole mode (%s, %s)", async (provider, sessionContinuity, whole) => {
    const f = await seed();
    await db.update(agents).set({ adapterConfig: { model: "model-a", provider, sessionContinuity } }).where(eq(agents.id, f.agentId));
    const body = "HISTORY:" + "z".repeat(6_000);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId, body });
    const next = await execute(f);
    if (whole) {
      expect(next.input.context.paperclipFreshSessionHandoffMarkdown).toBeUndefined();
      expect(next.input.context.executionContinuation).toMatchObject({ coverage: { kind: "full_task_history" },
        messages: [expect.objectContaining({ body })] });
    } else {
      expect(next.input.context.paperclipFreshSessionHandoffMarkdown).toEqual(expect.any(String));
      expect(String(next.input.context.paperclipFreshSessionHandoffMarkdown)).not.toContain(body);
    }
  });

  it("excludes the current wake and all coalesced comments from dispatched fresh history", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "model-a" } }).where(eq(agents.id, f.agentId));
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issueComments).values(ids.map((id, i) => ({ id, companyId: f.companyId, issueId: f.issueId,
      authorUserId: f.userId, body: ["EARLIER HISTORY", "QUEUED CURRENT REQUEST", "LATEST CURRENT REQUEST"][i],
      createdAt: new Date(Date.now() - 3_000 + i * 1_000) })));
    const next = await execute(f, { wakeCommentId: ids[2], commentId: ids[2], wakeCommentIds: ids.slice(1) });
    expect(next.input.context.paperclipFreshSessionHandoffMarkdown).toBeUndefined();
    expect(next.input.context.executionContinuation).toMatchObject({ coverage: { kind: "full_task_history" },
      messages: ids.map(id => expect.objectContaining({ id })) });
  });

  it.each([
    { key: "env", before: { CONTEXT_NOTE: "old" }, after: { CONTEXT_NOTE: "new" }, retain: true },
    { key: "lifecycleMode", before: "per_turn", after: "warm", retain: false },
    { key: "idleTimeoutMs", before: 60_000, after: 120_000, retain: false },
    { key: "fixtureOption", before: "old", after: "new", retain: false },
    { key: "fixtureOption", before: "old", after: "new", retain: false, environmentChanged: true },
    { key: "instructionsFilePath", before: "old.md", after: "new.md", retain: false },
  ])("per-key Pi freshness: $key retains session only when allowed ($retain, environment changed=$environmentChanged)", async ({ key, before, after, retain, environmentChanged }) => {
    for (const sessionContinuity of ["continuous", "paperclip"]) {
      const f = await seed(), sessionId = randomUUID(), cwd = await mkdtemp(join(tmpdir(), "pi-key-freshness-"));
      const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
        kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
      registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
      try {
        const adapterConfig = { provider: "pi_rpc", model: "fixture/model", sessionContinuity, fixtureSessionId: sessionId, cwd, [key]: before };
        await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig }).where(eq(agents.id, f.agentId));
        await execute(f);
        await db.update(agents).set({ adapterConfig: { ...adapterConfig, [key]: after,
          ...(environmentChanged ? { env: { CONTEXT_NOTE: "new" } } : {}),
        } }).where(eq(agents.id, f.agentId));
        const next = await execute(f);
        const continued = sessionContinuity === "continuous" && retain;
        if (key === "env") expect((next.input.config.env as Record<string, unknown>).CONTEXT_NOTE).toBe("new");
        else expect(next.input.config[key]).toEqual(after);
        expect(next.input.runtime.sessionId).toBe(continued ? sessionId : null);
        expect(next.finished.sessionIdBefore).toBe(continued ? sessionId : null);
        expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
          reset: !continued, taskSessionAvailable: true, taskSessionReused: continued,
        } } });
      } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
    }
  });

  it.each(["environment", "environmentEnv", "projectEnv"])("continues actual %s changes only for continuous Pi", async key => {
    for (const sessionContinuity of ["continuous", "paperclip"]) {
      const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "pi-environment-freshness-"));
      const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
        kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
      registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
      const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      try {
        await db.update(environments).set({ config: { image: "old" }, envVars: { CONTEXT_NOTE: "old" } }).where(eq(environments.id, environment.id));
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Session project", env: { PROJECT_NOTE: "old" } }).returning();
        await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
        await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
          adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity, cwd },
        }).where(eq(agents.id, f.agentId));
        await execute(f);
        if (key === "projectEnv") await db.update(projects).set({ env: { PROJECT_NOTE: "new" } }).where(eq(projects.id, project.id));
        else await db.update(environments).set(key === "environment" ? { config: { image: "new" } } : { envVars: { CONTEXT_NOTE: "new" } })
          .where(eq(environments.id, environment.id));
        const next = await execute(f), retain = sessionContinuity === "continuous";
        expect(next.input.runtime.sessionId).toBe(retain ? "saved-session" : null);
        expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
          reset: !retain, taskSessionAvailable: true, taskSessionReused: retain,
          changedCategories: expect.arrayContaining([key === "environment" ? "environment" : "envBindings"]),
        } } });
      } finally {
        await db.update(environments).set({ config: environment.config, envVars: environment.envVars }).where(eq(environments.id, environment.id));
        mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it.each([false, true])("pre-filter environment fingerprint preserves unchanged inputs, not unknown changes (%s)", async changed => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "pi-env-fingerprint-compat-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const adapterConfig = { provider: "pi_rpc", model: "fixture/model", cwd, env: { CONTEXT_NOTE: "original" } };
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig }).where(eq(agents.id, f.agentId));
      const currentFilter = sessionFingerprintInputs.paperclipRunnerSessionAdapterConfig;
      const oldFilter = vi.spyOn(sessionFingerprintInputs, "paperclipRunnerSessionAdapterConfig")
        .mockImplementation(config => currentFilter(config, true, true));
      try { await execute(f); } finally { oldFilter.mockRestore(); }
      if (changed) await db.update(agents).set({ adapterConfig: { ...adapterConfig, fixtureOption: "changed" } }).where(eq(agents.id, f.agentId));
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe(changed ? null : "saved-session");
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: changed, taskSessionAvailable: true, taskSessionReused: !changed,
      } } });
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    { provider: "pi_rpc", sessionContinuity: "continuous", changed: true, oldShape: false, adapterChanged: false, retain: true },
    { provider: "pi_rpc", sessionContinuity: "continuous", changed: false, oldShape: true, adapterChanged: false, retain: true },
    { provider: "pi_rpc", sessionContinuity: "paperclip", changed: true, oldShape: false, adapterChanged: false, retain: false },
    { provider: "codex", sessionContinuity: "continuous", changed: true, oldShape: false, adapterChanged: false, retain: false },
    { provider: "pi_rpc", sessionContinuity: "continuous", changed: true, oldShape: false, adapterChanged: true, retain: false },
  ])("skill version continuation: $provider/$sessionContinuity changed=$changed old shape=$oldShape adapter changed=$adapterChanged retains=$retain", async ({ provider, sessionContinuity, changed, oldShape, adapterChanged, retain }) => {
    const f = await seed(), sessionId = randomUUID(), cwd = await mkdtemp(join(tmpdir(), "pi-skill-continuation-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    try {
      const skills = companySkillService(db);
      const skill = await skills.createLocalSkill(f.companyId, { name: "Shared company instructions", markdown: "# Shared skill\nOriginal version.\n" });
      const adapterConfig = { provider, sessionContinuity, model: "fixture/model", fixtureSessionId: sessionId, cwd,
        paperclipSkillSync: { desiredSkills: [skill.key] } };
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig }).where(eq(agents.id, f.agentId));
      // Save the exact pre-deploy composition, including skills in adapterConfig.
      const currentFilter = sessionFingerprintInputs.paperclipRunnerSessionAdapterConfig;
      const oldFilter = oldShape ? vi.spyOn(sessionFingerprintInputs, "paperclipRunnerSessionAdapterConfig")
        .mockImplementation(config => ({ ...currentFilter(config), paperclipRuntimeSkills: config.paperclipRuntimeSkills,
          ...(config.paperclipSkillSync !== undefined ? { paperclipSkillSync: config.paperclipSkillSync } : {}),
          ...(config.paperclipConnectorSkillDigest !== undefined ? { paperclipConnectorSkillDigest: config.paperclipConnectorSkillDigest } : {}),
        })) : undefined;
      let first: Awaited<ReturnType<typeof execute>>;
      try { first = await execute(f); } finally { oldFilter?.mockRestore(); }
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      expect(first.input.config.paperclipRuntimeSkills).toEqual([expect.objectContaining({ key: skill.key, versionId: skill.currentVersionId })]);
      if (changed) await skills.updateFile(f.companyId, skill.id, "SKILL.md", "# Shared skill\nUpdated version.\n");
      if (adapterChanged) await db.update(agents).set({ adapterConfig: { ...adapterConfig, provider: "codex" } }).where(eq(agents.id, f.agentId));
      const next = await execute(f);
      const delivered = next.input.config.paperclipRuntimeSkills as Array<{ key: string; versionId: string }>;
      expect(delivered).toEqual([expect.objectContaining({ key: skill.key, versionId: expect.any(String) })]);
      expect(delivered[0]!.versionId === skill.currentVersionId).toBe(!changed);
      expect(next.input.runtime.sessionId).toBe(retain ? sessionId : null);
      expect(next.finished.sessionIdBefore).toBe(retain ? sessionId : null);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: !retain, taskSessionAvailable: true, taskSessionReused: retain,
        changedCategories: changed ? (retain ? ["runtimeSkills"] : expect.arrayContaining(["adapterConfig", "runtimeSkills"])) : [],
      } } });
      if (retain) {
        const [retained] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
        expect(retained.id).toBe(saved.id);
        expect(next.input.runtime.sessionParams).toMatchObject({ sessionId, adapterState: "preserved" });
      }
    } finally { mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true }); }
  });

  it.each([
    { category: "instructions", retain: true },
    { category: "adapterConfig", retain: false },
    { category: "environment", retain: true },
    { category: "envBindings", retain: true },
    { category: "runtimeSkills", retain: true },
    { category: "agentRuntimeConfig", retain: false },
    { category: "workspaceConfig", retain: false },
    { category: "secrets", retain: false },
    { category: "issueOverrides", retain: false },
    { category: "adapter", retain: false },
    { category: "instructions,runtimeSkills", retain: true },
    { category: "adapterConfig,runtimeSkills", retain: false },
    { category: "instructions", retain: true, workspaceChanged: true },
    { category: "environment", retain: true, workspaceChanged: true },
    { category: "runtimeSkills", retain: true, workspaceChanged: true },
    { category: "missing", retain: false },
    { category: "version", retain: false },
    { category: "fingerprint", retain: false, workspaceChanged: true },
  ])("continuous Pi freshness $category (workspace changed=$workspaceChanged) retains session: $retain", async ({ category, retain, workspaceChanged }) => {
    const f = await seed(), sessionId = randomUUID();
    const cwd = workspaceChanged ? await mkdtemp(join(tmpdir(), "workspace-freshness-")) : undefined;
    const mode = workspaceChanged ? vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({ kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION }) : undefined;
    if (workspaceChanged) registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    try {
      await db.update(agents).set({ ...(workspaceChanged ? { adapterType: "paperclip_runner" } : {}), adapterConfig: { provider: "pi_rpc", model: "fixture/model", fixtureSessionId: sessionId, ...(cwd ? { cwd } : {}) } }).where(eq(agents.id, f.agentId));
      await execute(f);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      const params = structuredClone(saved.sessionParamsJson!);
      params.__paperclipConfigFingerprint = "old-config";
      if (category === "missing") delete params.__paperclipConfigFingerprintVersion;
      else if (category === "version") params.__paperclipConfigFingerprintVersion = 999;
      else if (category !== "fingerprint") for (const key of category.split(",")) (params.__paperclipConfigCategoryFingerprints as Record<string, string>)[key] = "old-category";
      await db.update(agentTaskSessions).set({ sessionParamsJson: params }).where(eq(agentTaskSessions.id, saved.id));
      const next = await execute(f, { workspaceSelectionChanged: workspaceChanged === true });
      expect(next.input.runtime.sessionId).toBe(retain ? sessionId : null);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: !retain, taskSessionReused: retain } } });
    } finally {
      mode?.mockRestore();
      if (workspaceChanged) unregisterServerAdapter("paperclip_runner");
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts fresh when effective model configuration changes and persists the reason", async () => {
    const f = await seed();
    await execute(f);
    await db.update(agents).set({ adapterConfig: { model: "model-b" } }).where(eq(agents.id, f.agentId));
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.finished.sessionIdBefore).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { reset: true, taskSessionAvailable: true, taskSessionReused: false } } });
  });

  it("refreshes tools with a fresh session when the selected adapter cannot refresh on resume", async () => {
    const f = await seed();
    await execute(f);
    const next = await execute(f, { refreshTools: true });
    expect(next.input.context.forceFreshSession).toBe(true);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: { resetReasons: ["forceFreshSession was requested"] } } });
  });

  it("rotates a session at the configured run threshold and supplies a handoff", async () => {
    const f = await seed({ sessionCompaction: { enabled: true, maxSessionRuns: 1 } });
    await execute(f);
    await execute(f);
    const next = await execute(f);
    expect(next.input.runtime.sessionId).toBeNull();
    expect(next.input.runtime.sessionParams).toBeNull();
    expect(next.input.context.paperclipPreviousSessionId).toBe("saved-session");
    expect(next.input.context.paperclipSessionRotationReason).toBe("session exceeded 1 runs");
    expect(next.input.context.paperclipSessionHandoffMarkdown).toEqual(expect.any(String));
    expect(next.finished.sessionIdBefore).toBeNull();
  });
});
