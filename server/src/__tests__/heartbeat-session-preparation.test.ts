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
import { connect, createServer as createNetServer } from "node:net";
import { environmentRoutes } from "../routes/environments.js";
import { instanceSettingsRoutes } from "../routes/instance-settings.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { companySecrets } from "@paperclipai/db";
import { projectRoutes } from "../routes/projects.js";
import { projectGitAuthorizationService } from "../services/project-git-authorization.js";
import { projectService } from "../services/projects.js";
import { agentService } from "../services/agents.js";
import { routineService } from "../services/routines.js";
import { createRoutineSchema } from "@paperclipai/shared";
import { environmentService } from "../services/environments.js";
import { readExecutionConfigurationRows, assertExecutionConfigurationCurrent } from "../services/heartbeat/execution-configuration-fence.js";
import { currentControllerBootId } from "../services/controller-process-identity.js";
import * as cloudInstance from "../services/cloud-instance.js";
import * as heldConfiguration from "../services/native-runtime/held-native-turn.js";
import * as executionConfiguration from "../services/heartbeat/execution-configuration.js";
import * as configurationSupersession from "../services/heartbeat/configuration-supersession.js";
import { currentControllerProcess } from "../services/controller-process-identity.js";
import { spawn } from "node:child_process";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { secretService } from "../services/secrets.js";
import { SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "../services/environment-custom-image-runtime.js";
import { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } from "../services/run-identity.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, companyMemberships, companySecretBindings, userSecretDeclarations, nativeRunFinalizations, routines, routineRuns, builtInManagedResources, createDb, executionWorkspaces, environments, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, plugins, projects, type Db } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { prepareHeartbeatSession, type HeartbeatSessionPreparationInput } from "../services/heartbeat/session-preparation.js";
import * as sessionPreparation from "../services/heartbeat/session-preparation.js";
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
import { materializeNativeAgentBlockerContinuation, materializeNativeEnvironmentBlockerRetry } from "../services/native-runtime/native-provider-capacity-retry.js";
import { NATIVE_AGENT_BLOCKER_HINT } from "../services/native-runtime/native-agent-blocker.js";
import { NATIVE_ENVIRONMENT_BLOCKER_HINT } from "../services/native-runtime/native-environment-blocker.js";
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
  const dispatchCounts = new Map<string, number>();
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let restoreSkillFixture = () => {};

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
    expect((await instanceSettingsService(db).getExperimentalReadOnly()).autoFreshSessionOnRecovery).toBe(false);
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
    // Record committed lifecycle transitions, not just the final task status.
    await db.execute(sql`create table configuration_status_probe (issue_id uuid, status text)`);
    await db.execute(sql`create function configuration_status_probe_record() returns trigger language plpgsql as $$
      begin insert into configuration_status_probe values (new.id, new.status); return new; end $$`);
    await db.execute(sql`create trigger configuration_status_probe_trigger after update of status on issues
      for each row execute function configuration_status_probe_record()`);
    registerServerAdapter({
      type: adapterType,
      supportsLocalAgentJwt: false,
      execute: async (input) => {
        captured.set(input.runId, input);
        dispatchCounts.set(input.runId, (dispatchCounts.get(input.runId) ?? 0) + 1);
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

  // Existing v7 automatic-fresh rows exercise the explicitly opted-in behavior.
  beforeEach(async () => { await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: true }); });

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

  it.each([
    { lane: "agent", provider: "pi_rpc", fresh: false },
    { lane: "environment", provider: "pi_rpc", fresh: false },
    { lane: "agent", provider: "codex", fresh: true },
    { lane: "environment", provider: "codex", fresh: true },
  ])("native blocker retry session: lane=$lane provider=$provider fresh=$fresh", async ({ lane, provider, fresh }) => {
    const f = await seed(), sessionId = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider, model: "fixture/model",
      sessionContinuity: provider === "pi_rpc" ? "continuous" : "paperclip", fixtureSessionId: sessionId } })
      .where(eq(agents.id, f.agentId));
    const first = await execute(f);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: f.issueId,
      nativeSessionId: sessionId, status: "failed", error: "Agent-reported blocker" })
      .where(eq(heartbeatRuns.id, first.finished.id));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    const materialize = lane === "agent" ? materializeNativeAgentBlockerContinuation : materializeNativeEnvironmentBlockerRetry;
    const retryId = await db.transaction(tx => materialize({ tx: tx as unknown as Db,
      ...f, runId: first.finished.id }));
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    const context = retry.contextSnapshot!;
    expect(context.forceFreshSession).toBe(true);
    expect(context.livenessContinuationInstruction).toBe(lane === "agent" ? NATIVE_AGENT_BLOCKER_HINT : NATIVE_ENVIRONMENT_BLOCKER_HINT);
    // Advance only this durable retry's deadline; dispatch the actual materialized run.
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() - 1_000) }).where(eq(heartbeatRuns.id, retryId));
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(finished.status, finished.error ?? undefined).toBe("succeeded");
    const input = captured.get(retryId)!;
    expect(input).toBeDefined();
    process.stdout.write(`BLOCKER-SESSION ${JSON.stringify({ lane, provider, sourceRunId: first.finished.id, retryRunId: retryId,
      savedSessionId: sessionId, resumedSessionId: input.runtime.sessionId, forceFreshSession: context.forceFreshSession,
      explicitFreshSession: context.explicitFreshSession ?? null, message: retry.error, hint: context.livenessContinuationInstruction,
      freshness: finished.resultJson?.configFreshness })}\n`);
    expect(input.runtime.sessionId).toBe(fresh ? null : sessionId);
    expect(finished.resultJson).toMatchObject({ configFreshness: { session: { reset: fresh, taskSessionReused: !fresh } } });
    expect(input.context.livenessContinuationInstruction).toBe(context.livenessContinuationInstruction);
    if (provider === "pi_rpc") expect(context.explicitFreshSession).not.toBe(true);
    expect(retry.error).toBe(lane === "agent"
      ? "The agent reported a blocker it owns. Paperclip continues the task once."
      : "The agent reported a blocker in its execution environment, tools or platform. Paperclip continues the task.");
    expect(context.livenessContinuationInstruction).toContain("Paperclip continued this task after that blocker. Earlier attempts may already have completed some steps:");
    expect(context.livenessContinuationInstruction).not.toContain("fresh session");
  });

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
    { failure: "runner_state_identity_mismatch: remote_warm_session_not_idle", chat: false, fresh: false },
    { failure: "runner_state_identity_mismatch: remote_warm_session_not_idle", chat: true, fresh: false },
    { failure: "ordinary model/tool failure", chat: false, fresh: false },
    { failure: "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; warm_recovery_refused=current_run_not_admitted", chat: false, fresh: false },
    { failure: "native_controller_recovery_unsupported:metadata_format", chat: false, fresh: false },
    { failure: "native_continuation_requires_reconciliation", chat: false, fresh: false },
    { failure: "native_controller_recovery_missing_evidence:retained_sandbox_binding", chat: false, fresh: true },
    { failure: "workspace_continuation_source_missing", errorCode: "native_provider_state_incompatible", chat: false, fresh: true },
    { failure: "current_run_not_admitted", chat: false, fresh: false },
  ].flatMap(row => [true, false].flatMap(reconciled => [true, false].map(enabled => ({
    ...row, fresh: row.fresh && enabled, reconciled, enabled,
  })))))("stock reconciliation of a continuous Pi session: $failure, chat=$chat, fresh=$fresh, reconciled=$reconciled, enabled=$enabled", async ({ failure, errorCode, chat, fresh, reconciled, enabled }) => {
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: enabled });
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
      expect(Boolean(next.finished.contextSnapshot?.warmRecoveryFreshSession)).toBe(fresh);
      process.stdout.write(`AUTO-FRESH-SCOPE ${JSON.stringify({ failure, errorCode, chat, reconciled, enabled,
        sourceRunId: failed.id, recoveryRunId: next.finished.id, savedSessionId: sessionId,
        resumes: next.input.runtime.sessionId, reset: fresh })}\n`);
      if (fresh) {
        expect(next.input.context.executionContinuation).toMatchObject({ messages: [expect.objectContaining({ body: "SAVED WORK: use the completed analysis" })] });
        expect(next.finished.error).toBeNull();
      }
    } finally { registerServerAdapter(adapter); }
  });

  it.each([false, true])("AUTO-FRESH-SWITCH / CHB1: gate-7 recovery with autoFreshSessionOnRecovery=%s", async enabled => {
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: enabled });
    const type = `${adapterType}_${randomUUID()}`, adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, type });
    const service = heartbeatService(db), f = await seed({}, type), s0 = randomUUID(), s1 = randomUUID();
    await db.update(agents).set({ adapterConfig: { provider: "pi_rpc", model: "fixture/model",
      sessionContinuity: "continuous", fixtureSessionId: s0 } }).where(eq(agents.id, f.agentId));
    try {
      await execute(f, {}, "succeeded", service);
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: f.userId,
        body: "SAVED BEFORE MUTE-BOX: carry this completed work into recovery." });
      registerServerAdapter({ ...adapter, type, execute: async input => {
        const result = await adapter.execute(input), sessionId = input.runtime.sessionId ?? s1;
        return { ...result, exitCode: 1, sessionId, sessionParams: { sessionId },
          errorMessage: "native_controller_recovery_missing_evidence:retained_sandbox_binding" };
      } });
      let previous = (await execute(f, {}, "failed", service)).finished.id;
      const resumes: unknown[] = [], runs: string[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const actionId = randomUUID();
        await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
          kind: "active_run_watchdog", status: "resolved", ownerType: "system", returnOwnerAgentId: f.agentId,
          cause: "native_continuation_requires_reconciliation", fingerprint: actionId, nextAction: "Continue saved work",
          evidence: { continuationDelivery: "pending", executionReconciliation: { runId: previous,
            providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "The warm turn did not run." } } });
        const next = await execute(f, { source: "execution.reconciled", wakeReason: "issue_recovery_action_restored",
          forceFreshSession: true, recoveryActionId: actionId, previousRunId: previous, retryOfRunId: previous }, "failed", service);
        resumes.push(next.input.runtime.sessionId); runs.push(next.finished.id);
        expect(next.input.runtime.sessionId).toBe(enabled ? (attempt === 0 ? null : s1) : s0);
        if (enabled && attempt === 0) {
          expect(JSON.stringify(next.input.context.executionContinuation)).toContain("SAVED BEFORE MUTE-BOX");
          expect(next.finished.contextSnapshot?.warmRecoveryFreshSession).toBeDefined();
        } else expect(next.finished.contextSnapshot?.warmRecoveryFreshSession).toBeUndefined();
        previous = next.finished.id;
      }
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      const notices = comments.filter(c => c.presentation?.title === "Fresh-session recovery already attempted");
      expect(notices).toHaveLength(enabled ? 1 : 0);
      // The setting does not disable an explicit fresh request (the person's way out).
      const explicit = await execute(f, { forceFreshSession: true, explicitFreshSession: true }, "failed", service);
      expect(explicit.input.runtime.sessionId).toBeNull();
      process.stdout.write(`AUTO-FRESH-SWITCH ${JSON.stringify({ enabled, s0, s1, runs, resumes,
        notices: notices.length, explicitRunId: explicit.finished.id, explicitResumes: explicit.input.runtime.sessionId })}\n`);
    } finally { await service.drainActiveRunExecutions(); unregisterServerAdapter(type); }
  }, 60_000);

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
      error: "native_controller_recovery_missing_evidence:retained_sandbox_binding", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
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
        error: "native_controller_recovery_missing_evidence:retained_sandbox_binding", errorCode: "adapter_failed", contextSnapshot: { issueId: f.issueId } }).returning();
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
        return { ...result, exitCode: 1, sessionId, sessionParams: { sessionId },
          errorMessage: "native_controller_recovery_missing_evidence:retained_sandbox_binding" };
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
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: false });
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
      issueId: f.issueId, nativeSessionId: sessionId, status: "failed", error: "native_controller_recovery_missing_evidence:retained_sandbox_binding",
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

  it.each([true, false].flatMap(native => ["compatible", "stock reset", "changed credential"].map(independent => ({ native, independent }))))(
    "C34A8-CREDENTIAL-LAG: ordinary S2 with lagging S1, native=$native independent=$independent", async ({ native, independent }) => {
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: false });
    const f = await recoveryNoticeFixture(), s1 = f.incident.nativeSessionId!, s2 = randomUUID(), laterId = randomUUID();
    const baseline = await prepareHeartbeatSession(db, f.input);
    const [later] = await db.insert(heartbeatRuns).values({ id: laterId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: native ? s2 : null, sessionIdAfter: native ? null : s2,
      status: "failed", error: "ordinary provider failure", resultJson: { configFreshness: { session: {
        reset: false, credentialIdentityResetRunId: laterId } } } }).returning();
    if (native) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
      runId: later.id, seq: 1, eventType: "session.started", payload: { prpEvent: { normalizedSessionId: s2 } } });
    const [current] = await db.update(heartbeatRuns).set({ createdAt: new Date(later.createdAt.getTime() + 1) })
      .where(eq(heartbeatRuns.id, f.input.run.id)).returning();
    const [taskSession] = await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: f.input.agent.adapterType,
      taskKey: f.issueId, lastRunId: f.incident.id, sessionDisplayId: s1,
      sessionParamsJson: sessionMetadata.attachPaperclipSessionMetadataToSessionParams({ sessionId: s1,
        paperclipAiCredentialIdentity: "fixture-account:0" }, baseline.configuredModel, baseline.sessionConfigMetadata),
    }).returning();
    const next = await prepareHeartbeatSession(db, { ...f.input, run: current,
      task: { ...f.input.task, context: { forceFreshSession: true, source: "execution.reconciled" } },
      session: { ...f.input.session, taskSession, taskSessionDecodedParams: { sessionId: s1 } },
      config: { ...f.input.config,
        runtimeConfig: { ...f.input.config.runtimeConfig, ...(independent === "stock reset" ? { fixtureOption: "changed" } : {}) },
        managedAiRuntime: independent === "changed credential" ? { identity: "fixture-account", sessionIdentity: "fixture-account:1" } as never : undefined },
    });
    process.stdout.write(`C34A8-CREDENTIAL-LAG ${JSON.stringify({ native, independent, s1, s2, laterRunId: later.id, nextRunId: current.id,
      resumes: next.taskResumeSessionId, previous: next.previousSessionParams?.sessionId, reset: next.resetTaskSession,
      pin: next.warmRecoveryRetainSessionId })}\n`);
    expect(next.resetTaskSession).toBe(independent === "stock reset");
    expect(next.warmRecoveryRetainSessionId).toBeNull();
    if (independent === "compatible") {
      if (native) expect(next.taskResumeSessionId).toBe(s2);
      expect(next.previousSessionParams?.sessionId).toBe(s2);
    } else {
      expect(next.taskResumeSessionId).toBeNull();
      expect(next.previousSessionParams?.sessionId).not.toBe(s2);
    }
  });

  it.each(["stock", "credential"].flatMap(authority => ["matching", "none", "resumed", "wrong session"].map(evidence => ({ authority, evidence }))))(
    "CHV7-THROW: S2 survives adapter THROW with $authority receipt, evidence=$evidence", async ({ authority, evidence }) => {
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: false });
    const started = evidence === "matching";
    const type = `${adapterType}_${randomUUID()}`, adapter = getServerAdapter(adapterType);
    registerServerAdapter({ ...adapter, type });
    const service = heartbeatService(db), f = await seed({}, type), s1 = randomUUID(), s2 = randomUUID(), incidentId = randomUUID();
    const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", fixtureSessionId: s1 };
    try {
      await db.update(agents).set({ adapterConfig: config }).where(eq(agents.id, f.agentId));
      await execute(f, {}, "succeeded", service);
      const [saved] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId));
      await db.insert(heartbeatRuns).values({ id: incidentId, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: s1, status: "failed", finishedAt: new Date(),
        error: "remote_warm_session_not_idle", contextSnapshot: { issueId: f.issueId,
          warmRecoveryFreshSession: { runId: incidentId, retainedSessionId: s1 } } });
      // Authority comes from real preparation, NOT explicitFreshSession or an adapter result.
      if (authority === "stock") {
        await db.update(agents).set({ adapterConfig: { ...config, fixtureOption: "changed" } }).where(eq(agents.id, f.agentId));
      } else {
        await db.update(agentTaskSessions).set({ sessionParamsJson: { ...saved.sessionParamsJson,
          paperclipAiCredentialIdentity: "fixture-account:0" } }).where(eq(agentTaskSessions.id, saved.id));
      }
      // Replace only account acquisition with fixture labels; no account or secret is accessed.
      const managedAiRuntime = authority === "credential" ? { identity: "fixture-account", sessionIdentity: "fixture-account:1" } as never : undefined;
      registerServerAdapter({ ...adapter, type, execute: async input => {
        await adapter.execute(input);
        await db.update(heartbeatRuns).set({ nativeSessionId: s2, nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, input.runId));
        if (evidence !== "none") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
          runId: input.runId, seq: 1_000_000, eventType: evidence === "resumed" ? "session.resumed" : "session.started",
          payload: { prpEvent: { normalizedSessionId: evidence === "wrong session" ? randomUUID() : s2 } } });
        throw new Error("ordinary provider failure (thrown by adapter)");
      } });
      let preparationInput!: HeartbeatSessionPreparationInput;
      const prepare = prepareHeartbeatSession;
      const capture = vi.spyOn(sessionPreparation, "prepareHeartbeatSession").mockImplementation(async (database, input) => {
        preparationInput = { ...input, config: { ...input.config, managedAiRuntime } };
        return prepare(database, preparationInput);
      });
      const resolve = sessionPreparation.resolveHeartbeatAdapterSession;
      const adapterSession = vi.spyOn(sessionPreparation, "resolveHeartbeatAdapterSession").mockImplementation(input =>
        resolve({ ...input, session: { ...input.session, managedAiRuntime } }));
      let failed: Awaited<ReturnType<typeof execute>>;
      try { failed = await execute(f, {}, "failed", service); }
      finally { capture.mockRestore(); adapterSession.mockRestore(); }
      expect(failed.finished.error).toBe("ordinary provider failure (thrown by adapter)");
      expect(failed.input.runtime.sessionId).toBeNull();
      expect(failed.input.context.explicitFreshSession).not.toBe(true);
      // Deliberately lag publication on S1, keeping the post-failure configuration
      // and identity metadata so no independent reset masks the resume decision.
      const [afterFailure] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, saved.id));
      const [lagging] = await db.update(agentTaskSessions).set({ sessionDisplayId: s1,
        sessionParamsJson: { ...afterFailure.sessionParamsJson, sessionId: s1 },
      }).where(eq(agentTaskSessions.id, saved.id)).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, status: "queued", createdAt: new Date(failed.finished.createdAt.getTime() + 1) }).returning();
      const next = await prepareHeartbeatSession(db, { ...preparationInput, run,
        task: { ...preparationInput.task, context: { forceFreshSession: true, source: "execution.reconciled" } },
        session: { ...preparationInput.session, taskSession: lagging, taskSessionDecodedParams: { sessionId: s1 } } });
      process.stdout.write(`CHV7-THROW ${JSON.stringify({ authority, evidence, started, s1, s2, failedRunId: failed.finished.id, nextRunId: run.id,
        receipt: failed.finished.resultJson?.configFreshness ?? null, resumes: next.taskResumeSessionId,
        previous: next.previousSessionParams?.sessionId, reset: next.resetTaskSession, pin: next.warmRecoveryRetainSessionId })}\n`);
      if (started) expect(failed.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: authority === "stock", credentialIdentityResetRunId: authority === "credential" ? failed.finished.id : null } } });
      else expect(failed.finished.resultJson?.configFreshness).toBeUndefined();
      expect(next.resetTaskSession).toBe(false);
      expect(next.taskResumeSessionId).toBe(started ? s2 : s1);
      expect(next.previousSessionParams?.sessionId).toBe(started ? s2 : s1);
      // Also traverse actual legacy dispatch on a restarted facade, not only
      // preparation's previousSessionParams. Neither recovery may request S3.
      await db.update(heartbeatRuns).set({ status: "failed", error: "preparation probe ended", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.id));
      registerServerAdapter({ ...adapter, type, execute: async input => {
        const result = await adapter.execute(input), sessionId = input.runtime.sessionId ?? randomUUID();
        return { ...result, exitCode: 1, sessionId, sessionParams: { sessionId }, errorMessage: "ordinary provider failure" };
      } });
      const restarted = heartbeatService(db);
      try {
        const resumed = await execute(f, { forceFreshSession: true, wakeReason: "issue_recovery_action_restored" }, "failed", restarted);
        expect(resumed.input.runtime.sessionId).toBe(started ? s2 : s1);
        expect(resumed.finished.contextSnapshot?.warmRecoveryFreshSession).toBeUndefined();
        process.stdout.write(`CHV7-THROW-DISPATCH ${JSON.stringify({ authority, evidence, s1, s2,
          failedRunId: failed.finished.id, recoveryRunId: resumed.finished.id, resumes: resumed.input.runtime.sessionId })}\n`);
      } finally { await restarted.drainActiveRunExecutions(); }
    } finally { try { await service.drainActiveRunExecutions(); } finally { unregisterServerAdapter(type); } }
  }, 60_000);

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

  it.each(["environment", "project", "agent"] as const)("secret rotation ends held runs using its %s binding, not unrelated runs", async targetType => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "held-secret-binding-"));
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    try {
      const secrets = secretService(db);
      const secret = await secrets.create(f.companyId, { name: "Held revision", key: "HELD_REVISION", provider: "local_encrypted", value: randomUUID() });
      const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Held project" }).returning();
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
      const targetId = targetType === "environment" ? environment.id : targetType === "project" ? project.id : f.agentId;
      await secrets.syncEnvBindingsForTarget(f.companyId, { targetType, targetId }, {
        HELD_REVISION: { type: "secret_ref", secretId: secret.id, version: "latest" },
      });
      const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated holder" }).returning();
      const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Unrelated hold", assigneeAgentId: otherAgent.id }).returning();
      const [held, other] = await db.insert(heartbeatRuns).values([
        { companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running",
          contextSnapshot: { paperclipEnvironment: { id: environment.id }, paperclipWorkspace: { projectId: project.id } }, resultJson: { retained: "receipt" } },
        { companyId: f.companyId, agentId: otherAgent.id, nativeIssueId: otherIssue.id, runtimeMode: "native", status: "running",
          contextSnapshot: { paperclipEnvironment: { id: randomUUID() } }, resultJson: { retained: "other receipt" } },
      ]).returning();
      await secrets.rotate(secret.id, { value: randomUUID() });
      expect((await heartbeat.getRun(held.id))?.resultJson).toEqual({ retained: "receipt", heldNativeConfigurationEnd: true });
      expect((await heartbeat.getRun(other.id))?.resultJson).toEqual({ retained: "other receipt" });
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.companyId, f.companyId));
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.companyId, f.companyId));
      await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Real project PATCH, binding rewrite and durable fence must commit/roll back together.
  it.each([false, true])("project environment save fences its held consumer atomically (rollback=%s)", async rollback => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "project-env-transaction-"));
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    let fail: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const secrets = secretService(db);
      const secret = await secrets.create(f.companyId, { name: "Project revision", key: "PROJECT_REVISION", provider: "local_encrypted", value: randomUUID() });
      const reference = { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const };
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Held project",
        env: { CONTEXT_NOTE: "old", PROJECT_REVISION: reference } }).returning();
      await secrets.syncEnvBindingsForTarget(f.companyId, { targetType: "project", targetId: project.id }, project.env);
      const [beforeBinding] = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, project.id));
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
        runtimeMode: "native", status: "running", contextSnapshot: { paperclipWorkspace: { projectId: project.id } } }).returning();
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", projectRoutes(db)); app.use(errorHandler);
      const fence = heldConfiguration.requestHeldNativeConfigurationEndForTargets;
      fail = rollback ? vi.spyOn(heldConfiguration, "requestHeldNativeConfigurationEndForTargets").mockImplementation(async (tx, targets) => {
        await fence(tx, targets); throw new Error("injected fence rollback");
      }) : undefined;
      const response = await request(app).patch(`/api/projects/${project.id}`).send({ env: { CONTEXT_NOTE: "new", PROJECT_REVISION: reference } });
      expect(response.status).toBe(rollback ? 500 : 200);
      expect((await db.select().from(projects).where(eq(projects.id, project.id)))[0].env?.CONTEXT_NOTE).toEqual(rollback ? "old" : { type: "plain", value: "new" });
      const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, project.id));
      expect(bindings).toHaveLength(1);
      expect(bindings[0].id === beforeBinding.id).toBe(rollback);
      expect(bindings[0].secretId).toBe(secret.id);
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(rollback ? undefined : true);
    } finally {
      fail?.mockRestore();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("environment save does not fence a native run with no admitted environment", async () => {
    const f = await seed();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
    app.use("/api", environmentRoutes(db)); app.use(errorHandler);
    try {
      expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`)
        .send({ envVars: { CONTEXT_NOTE: "current" } })).status).toBe(200);
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBeUndefined();
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
    }
  });

  it("instance environment save only fences exact admitted consumers", async () => {
    const first = await seed(), second = await seed();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: first.userId }; next(); });
    app.use("/api", environmentRoutes(db)); app.use(errorHandler);
    const cases = [
      { name: "exact active consumer", owner: first, contextSnapshot: { paperclipEnvironment: { id: environment.id } }, nativePhase: "provider_running", createdAt: new Date(0), resultJson: {}, close: true },
      { name: "recent missing environment first company", owner: first, contextSnapshot: {}, nativePhase: null, createdAt: new Date(), resultJson: {}, close: false },
      { name: "recent missing environment second company", owner: second, contextSnapshot: {}, nativePhase: null, createdAt: new Date(), resultJson: {}, close: false },
      { name: "old missing environment", owner: second, contextSnapshot: {}, nativePhase: null, createdAt: new Date(Date.now() - 60 * 60_000), resultJson: {}, close: false },
      { name: "provider running without environment", owner: second, contextSnapshot: {}, nativePhase: "provider_running", createdAt: new Date(), resultJson: {}, close: false },
      { name: "first turn dispatched without environment", owner: second, contextSnapshot: {}, nativePhase: null, createdAt: new Date(), resultJson: { firstTurnDispatchCommitted: true }, close: false },
      { name: "other environment", owner: second, contextSnapshot: { paperclipEnvironment: { id: randomUUID() } }, nativePhase: null, createdAt: new Date(), resultJson: {}, close: false },
    ];
    const issueIds = cases.map(() => randomUUID());
    await db.insert(issues).values(cases.map((row, index) => ({ id: issueIds[index], companyId: row.owner.companyId,
      title: row.name, assigneeAgentId: row.owner.agentId })));
    const runs = await db.insert(heartbeatRuns).values(cases.map((row, index) => ({ companyId: row.owner.companyId, agentId: row.owner.agentId,
      nativeIssueId: issueIds[index], runtimeMode: "native", status: "running", contextSnapshot: row.contextSnapshot,
      nativePhase: row.nativePhase, createdAt: row.createdAt, resultJson: row.resultJson }))).returning();
    try {
      // The query company resolves secret bindings only. The instance save's
      // held-consumer target deliberately has no companyId and spans companies.
      const saved = await request(app).patch(`/api/environments/${environment.id}?companyId=${first.companyId}`)
        .send({ envVars: { CONTEXT_NOTE: "current instance value" } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      for (const [index, row] of cases.entries()) {
        const after = await heartbeat.getRun(runs[index].id);
        expect(after?.resultJson?.heldNativeConfigurationEnd === true, row.name).toBe(row.close);
        expect(after?.resultJson?.personStop, row.name).toBeUndefined();
      }
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(and(eq(heartbeatRuns.companyId, first.companyId), eq(heartbeatRuns.agentId, first.agentId)));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(and(eq(heartbeatRuns.companyId, second.companyId), eq(heartbeatRuns.agentId, second.agentId)));
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
    }
  });

  it.each(["identity", "previous-release manifest"])("user secret rotation fences the admitted owner after steering changes the responsible user (%s)", async identitySource => {
    const f = await seed(), other = await seed(), cwd = await mkdtemp(join(tmpdir(), "admitted-secret-owner-"));
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    try {
      const secrets = secretService(db);
      await secrets.createUserSecretDefinition(f.companyId, { key: "context_revision", name: "Context revision", provider: "local_encrypted" });
      await secrets.syncEnvBindingsForTarget(f.companyId, { targetType: "agent", targetId: f.agentId }, {
        CONTEXT_REVISION: { type: "user_secret_ref", key: "context_revision", version: "latest" },
      });
      const secret = await secrets.createCurrentUserSecretValue(f.companyId, f.userId, { definitionKey: "context_revision", value: randomUUID() });
      const admitted = await secrets.resolveEnvBindings(f.companyId, {
        CONTEXT_REVISION: { type: "user_secret_ref", key: "context_revision", version: "latest" },
      }, { consumerType: "agent", consumerId: f.agentId, actorType: "agent", actorId: f.agentId, responsibleUserId: f.userId });
      expect(admitted.manifest.map(entry => entry.secretId)).toEqual([secret.id]);
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
        runtimeMode: "native", status: "running", responsibleUserId: f.userId,
        contextSnapshot: identitySource === "identity" ? { paperclipSecretIdentity: { responsibleUserId: f.userId } }
          : { paperclipSecrets: { manifest: admitted.manifest } } }).returning();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: other.userId, principalType: "user", status: "active", membershipRole: "member" });
      await initializeRunIdentity(db, { companyId: f.companyId, runId: run.id, issueId: f.issueId, responsibleUserId: f.userId, cause: "instruction" });
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: other.userId, body: "Continue with this instruction" }).returning();
      const steered = await reserveSteeredIdentity(db, { companyId: f.companyId, runId: run.id, issueId: f.issueId, messageId: comment.id });
      expect(steered).not.toBeNull();
      await db.transaction(async tx => {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
        await acceptSteeredIdentity(tx, steered!);
      });
      expect((await heartbeat.getRun(run.id))?.responsibleUserId).toBe(other.userId);
      await secrets.rotate(secret.id, { value: randomUUID() });
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Every mutable plain-env source, through both actual dispatch handoffs.
  // Only provider I/O is substituted; preparation, saves and PG fencing are real.
  it.each([
    { source: "agent", native: false }, { source: "agent", native: true },
    { source: "issue", native: false }, { source: "issue", native: true },
    { source: "live routine", native: false }, { source: "live routine", native: true },
    { source: "pinned routine", native: false }, { source: "pinned routine", native: true },
    { source: "project selector", native: false }, { source: "project selector", native: true },
    { source: "environment selector", native: false }, { source: "environment selector", native: true },
  ] as const)("v6 plain launch content: $source save after preparation (native=$native)", async ({ source, native }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "plain-launch-content-"));
    const mode = native ? undefined : vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const nativeValues: unknown[] = [];
    const provider = native ? vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      nativeValues.push(input.runnerEnvironment?.CONTEXT_NOTE);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", resultJson: {} };
    }) : undefined;
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd,
        ...(source === "agent" || source === "environment selector" ? { env: { CONTEXT_NOTE: { type: "plain", value: source === "agent" ? "old" : "current" } } } : {}) };
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      if (source === "issue") await db.update(issues).set({ assigneeAdapterOverrides: {
        adapterConfig: { env: { CONTEXT_NOTE: { type: "plain", value: "old" } } },
      } }).where(eq(issues.id, f.issueId));
      const selectorProjects = source === "project selector" ? await db.insert(projects).values([
        { companyId: f.companyId, name: "Original project", env: { CONTEXT_NOTE: "old" } },
        { companyId: f.companyId, name: "Current project", env: { CONTEXT_NOTE: "current" } },
      ]).returning() : [];
      if (selectorProjects.length) await db.update(issues).set({ projectId: selectorProjects[0].id }).where(eq(issues.id, f.issueId));
      const [localEnvironment] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const routinesSvc = routineService(db);
      const routine = source.includes("routine") ? await routinesSvc.create(f.companyId, createRoutineSchema.parse({
        title: "Launch content", assigneeAgentId: f.agentId, env: { CONTEXT_NOTE: "old" },
      }), { userId: f.userId }) : null;
      if (routine) {
        const [routineRun] = source === "pinned routine" ? await db.insert(routineRuns).values({
          companyId: f.companyId, routineId: routine.id, source: "manual", routineRevisionId: routine.latestRevisionId,
          responsibleUserId: f.userId,
        }).returning() : [];
        await db.update(issues).set({ originKind: "routine_execution", originId: routine.id, originRunId: routineRun?.id ?? null }).where(eq(issues.id, f.issueId));
      }
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      let preparations = 0;
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations !== 1) return result;
        expect(result.prepared).toBe(true);
        if (source === "agent") await agentService(db).update(f.agentId, { adapterConfig: {
          ...config, env: { CONTEXT_NOTE: { type: "plain", value: "current" } },
        } });
        else if (source === "issue") await db.update(issues).set({ assigneeAdapterOverrides: {
          adapterConfig: { env: { CONTEXT_NOTE: { type: "plain", value: "current" } } },
        } }).where(eq(issues.id, f.issueId));
        else if (source === "project selector") await db.update(issues).set({ projectId: selectorProjects[1].id }).where(eq(issues.id, f.issueId));
        else if (source === "environment selector") await db.update(agents).set({ defaultEnvironmentId: localEnvironment.id }).where(eq(agents.id, f.agentId));
        else await routinesSvc.update(routine!.id, { env: { CONTEXT_NOTE: "current" } }, { userId: f.userId });
        return result;
      });
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(starting!.id);
      expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
      const pinned = source === "pinned routine";
      expect(preparations).toBe(pinned ? 1 : 2);
      if (pinned) expect(finished?.resultJson?.configurationSupersession).toBeUndefined();
      else expect(finished?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
      const values = native ? nativeValues : [(captured.get(starting!.id)?.config.env as Record<string, unknown> | undefined)?.CONTEXT_NOTE];
      expect(values).toEqual([pinned ? "old" : "current"]);
      expect(native ? provider!.mock.calls.length : dispatchCounts.get(starting!.id)).toBe(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, starting!.wakeupRequestId!))).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore(); provider?.mockRestore(); mode?.mockRestore();
      unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { selector: "instance default", native: false }, { selector: "instance default", native: true },
    { selector: "issue environment", native: false }, { selector: "issue environment", native: true },
    { selector: "managed sandbox switch", native: false }, { selector: "managed sandbox switch", native: true },
    { selector: "managed slot", native: false }, { selector: "managed slot", native: true },
    { selector: "forced Kubernetes slot", native: false }, { selector: "forced Kubernetes slot", native: true },
    { selector: "issue trust preset", native: false }, { selector: "issue trust preset", native: true },
    { selector: "settings during handoff", native: false }, { selector: "settings during handoff", native: true },
  ] as const)("v9 selection freshness: $selector after preparation (native=$native)", async ({ selector, native }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "selection-freshness-"));
    const settings = instanceSettingsService(db), original = await settings.get();
    const local = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const lowTrust = selector === "issue environment";
    const trustChange = selector === "issue trust preset";
    const inHandoff = selector === "settings during handoff";
    const slot = selector === "managed slot" || selector === "forced Kubernetes slot";
    const marker = selector === "forced Kubernetes slot" ? "managedKubernetesSandbox" : "managedByPaperclip";
    const envs = await db.insert(environments).values([
      { name: `Selection A ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: selector === "forced Kubernetes slot" ? "kubernetes" : "fixture" }, envVars: { CONTEXT_NOTE: "old" },
        metadata: slot ? { [marker]: true } : null },
      { name: `Selection B ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: selector === "forced Kubernetes slot" ? "kubernetes" : "fixture" }, envVars: { CONTEXT_NOTE: "current" },
        metadata: selector === "managed sandbox switch" ? { managedByPaperclip: true } : null },
    ]).returning();
    const mode = native ? undefined : vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const values: unknown[] = [], selections: unknown[] = [];
    const fixture = getServerAdapter(adapterType);
    registerServerAdapter({ ...fixture, type: "paperclip_runner", execute: async input => {
      values.push((input.config.env as Record<string, unknown>)?.CONTEXT_NOTE); return fixture.execute(input);
    } });
    const provider = native ? vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      values.push(input.runnerEnvironment?.CONTEXT_NOTE);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", resultJson: {} };
    }) : undefined;
    // Only allocation/realization/provider I/O is substituted. Selection, trust
    // resolution, preparation, committed settings writes and dispatch fences use PG.
    const createOrchestrator = environmentOrchestrator.environmentRunOrchestrator;
    const transport = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...createOrchestrator(...args),
      acquireForRun: async input => {
        selections.push(input.selectedEnvironmentId);
        const result = await createOrchestrator(...args).acquireForRun({ ...input, selectedEnvironmentId: input.localEnvironmentId });
        return { ...result, environment: (await environmentService(db).getById(input.selectedEnvironmentId!))! };
      },
      realizeForRun: async input => ({ lease: input.lease, persistedExecutionWorkspace: input.persistedExecutionWorkspace,
        workspaceRealization: {}, executionTarget: null, remoteExecution: null }),
    }));
    const originalHeartbeat = heartbeat;
    heartbeat = heartbeatService(db);
    const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
    let preparations = 0, pause: ReturnType<typeof vi.spyOn> | undefined;
    let fenceReached!: () => void, releaseFence!: () => void;
    const reached = new Promise<void>(resolve => { fenceReached = resolve; });
    const release = new Promise<void>(resolve => { releaseFence = resolve; });
    const trustPolicy = { mode: "normal", commentRequired: false, stages: [], trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
      trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId,
        issueIds: [f.issueId], allowedAgentIds: [f.agentId], allowedToolClasses: [], allowedSecretBindingIds: [] } } };
    try {
      await settings.updateGeneral({ executionMode: selector === "forced Kubernetes slot" ? "kubernetes" : "any" });
      await settings.updateExperimental({ enableManagedSandboxOnly: selector === "managed slot", remoteWorkspaceStorageEnabled: false, enableIsolatedWorkspaces: true });
      await settings.update({ defaultEnvironmentId: selector === "instance default" || trustChange || inHandoff ? envs[0].id : null });
      await db.update(environments).set({ envVars: { CONTEXT_NOTE: "old" } }).where(eq(environments.id, local.id));
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: null,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", ...(lowTrust || trustChange ? {} : { cwd }) } }).where(eq(agents.id, f.agentId));
      if (lowTrust || trustChange) await db.update(issues).set({
        ...(lowTrust ? { executionPolicy: trustPolicy } : {}),
        executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "project_primary" }, environmentId: envs[trustChange ? 1 : 0].id },
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "task_directory" } },
      }).where(eq(issues.id, f.issueId));
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations === 1) {
          expect(result.prepared).toBe(true);
          if (inHandoff && result.prepared) {
            const fence = result.assertConfigurationCurrent;
            result.assertConfigurationCurrent = async (...fenceArgs) => {
              const checked = await fence(...fenceArgs);
              fenceReached(); await release;
              return checked;
            };
          } else if (selector === "instance default") await settings.update({ defaultEnvironmentId: envs[1].id });
          else if (lowTrust) await db.update(issues).set({ executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "project_primary" }, environmentId: envs[1].id } }).where(eq(issues.id, f.issueId));
          else if (slot) {
            await db.transaction(async tx => {
              await tx.update(environments).set({ metadata: null }).where(eq(environments.id, envs[0].id));
              await tx.update(environments).set({ metadata: { [marker]: true }, updatedAt: new Date() }).where(eq(environments.id, envs[1].id));
            });
          } else if (trustChange) await db.update(issues).set({ executionPolicy: trustPolicy }).where(eq(issues.id, f.issueId));
          else await settings.updateExperimental({ enableManagedSandboxOnly: true });
        }
        return result;
      });
      const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      expect(run, JSON.stringify(await db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error,
        reason: agentWakeupRequests.reason }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId)))).not.toBeNull();
      if (inHandoff) {
        await Promise.race([reached, heartbeat.drainActiveRunExecutions().then(() => { throw new Error("No fence reached"); })]);
        const start = performance.now();
        await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '1000ms'`);
          await settings.update({ defaultEnvironmentId: envs[1].id }, { db: tx });
        });
        const ms = performance.now() - start;
        process.stdout.write(`V10_SETTINGS_SAVE ${JSON.stringify({ native, ms })}\n`);
        expect(ms).toBeLessThan(1000);
        releaseFence();
      }
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(run!.id);
      expect(finished?.status, JSON.stringify({ error: finished?.error, preparations, selections })).toBe("succeeded");
      if (inHandoff) {
        expect(values).toEqual(["old"]);
        expect(finished?.resultJson?.configurationSupersession).toBeUndefined();
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
        const next = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
          requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
          payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
        await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(next!.id))?.status).toBe("succeeded");
        expect(values).toEqual(["old", "current"]);
      } else {
        expect(values).toEqual(["current"]);
        expect(finished?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
      }
      expect(preparations).toBe(2);
      expect(selections.at(-1)).toBe(envs[1].id);
    } finally {
      releaseFence();
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore(); transport.mockRestore(); provider?.mockRestore(); mode?.mockRestore();
      heartbeat = originalHeartbeat;
      unregisterServerAdapter("paperclip_runner");
      await db.update(environments).set({ metadata: null }).where(inArray(environments.id, envs.map(env => env.id)));
      await settings.updateGeneral({ executionMode: original.general.executionMode ?? "any" });
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
      await settings.updateExperimental({ enableManagedSandboxOnly: original.experimental.enableManagedSandboxOnly,
        remoteWorkspaceStorageEnabled: original.experimental.remoteWorkspaceStorageEnabled, enableIsolatedWorkspaces: original.experimental.enableIsolatedWorkspaces });
      await db.update(environments).set({ envVars: local.envVars }).where(eq(environments.id, local.id));
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Same post-final-compare pause as "settings during handoff" above. Plain
  // agent env saves belong to the next fresh admission; secret versions retain
  // their SHARE fence until handoff. Only provider I/O is substituted.
  it.each([
    { change: "remove plain", native: false }, { change: "remove plain", native: true },
    { change: "change plain", native: false }, { change: "change plain", native: true },
    { change: "rotate secret", native: false }, { change: "rotate secret", native: true },
  ] as const)("post-compare agent env: $change during handoff (native=$native)", async ({ change, native }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "post-compare-agent-env-"));
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    const secretControl = change === "rotate secret";
    const mode = native ? undefined : vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const values: unknown[] = [], unchanged: unknown[] = [], hasK: boolean[] = [], preparedEnvs: Record<string, unknown>[] = [];
    const fixture = getServerAdapter(adapterType);
    registerServerAdapter({ ...fixture, type: "paperclip_runner", execute: async input => {
      const env = input.config.env as Record<string, unknown>;
      values.push(env.K); unchanged.push(env.UNCHANGED); hasK.push(Object.hasOwn(env, "K"));
      expect(input.config).toMatchObject({ provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd });
      return fixture.execute(input);
    } });
    const provider = native ? vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      values.push(input.runnerEnvironment?.K); unchanged.push(input.runnerEnvironment?.UNCHANGED);
      hasK.push(Object.hasOwn(input.runnerEnvironment ?? {}, "K"));
      expect(input.execution.provider.model).toBe("fixture/model");
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", resultJson: {} };
    }) : undefined;
    const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
    let preparations = 0, fencePid = 0;
    let pause: ReturnType<typeof vi.spyOn> | undefined, rotation: Promise<unknown> | undefined;
    let fenceReached!: () => void, releaseFence!: () => void;
    const reached = new Promise<void>(resolve => { fenceReached = resolve; });
    const release = new Promise<void>(resolve => { releaseFence = resolve; });
    try {
      const secrets = secretService(db);
      const secret = secretControl ? await secrets.create(f.companyId, {
        name: "Post-compare control", key: "POST_COMPARE_CONTROL", provider: "local_encrypted", value: "old",
      }) : null;
      const env = { K: secret ? { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const }
        : { type: "plain" as const, value: "old" }, UNCHANGED: { type: "plain" as const, value: "steady" } };
      const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd, env };
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      if (secret) await secrets.syncEnvBindingsForTarget(f.companyId, { targetType: "agent", targetId: f.agentId }, env);
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        preparations++;
        expect(result.prepared).toBe(true);
        if (result.prepared) {
          preparedEnvs.push(result.configuredTaskEnvironment);
          if (preparations === 1) {
            const fence = result.assertConfigurationCurrent;
            result.assertConfigurationCurrent = async (...fenceArgs) => {
              const checked = await fence(...fenceArgs);
              const [backend] = await (fenceArgs[0] as typeof db).execute(sql`select pg_backend_pid() as pid`);
              fencePid = Number(backend.pid);
              fenceReached(); await release;
              return checked;
            };
          }
        }
        return result;
      });
      const wake = () => heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      const run = await wake();
      expect(run).not.toBeNull();
      await Promise.race([reached, heartbeat.drainActiveRunExecutions().then(() => { throw new Error("No final compare reached"); })]);
      expect(values).toEqual([]);
      const start = performance.now();
      let saveMs: number | undefined, blockedMs: number | undefined;
      if (secret) {
        let committed = false, blockedAt = 0;
        rotation = secrets.rotate(secret.id, { value: "new" }, { userId: f.userId }).then(result => {
          committed = true; saveMs = performance.now() - start; blockedMs = performance.now() - blockedAt;
          return result;
        });
        // Observe the actual writer blocked by THIS dispatch transaction, not
        // an assumed delay or an unrelated database lock.
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and ${fencePid} = any(pg_blocking_pids(pid))
            and query ilike '%update%company_secrets%'`);
          expect(waiting).toHaveLength(1);
        }, { timeout: 10_000, interval: 10 });
        blockedAt = performance.now();
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(committed).toBe(false);
        expect(values).toEqual([]);
        releaseFence();
        await Promise.all([rotation, heartbeat.drainActiveRunExecutions()]);
        expect(blockedMs).toBeGreaterThanOrEqual(150);
      } else {
        const nextEnv = change === "remove plain" ? { UNCHANGED: env.UNCHANGED }
          : { ...env, K: { type: "plain", value: "new" } };
        await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '1000ms'`);
          await tx.update(agents).set({ adapterConfig: { ...config, env: nextEnv } }).where(eq(agents.id, f.agentId));
        });
        saveMs = performance.now() - start;
        expect(saveMs).toBeLessThan(1000);
        expect(values).toEqual([]); // save committed while handoff is still paused
        expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].adapterConfig).toEqual({ ...config, env: nextEnv });
        releaseFence(); await heartbeat.drainActiveRunExecutions();
      }
      const totalMs = performance.now() - start;
      const first = await heartbeat.getRun(run!.id);
      expect(first?.status, first?.error ?? undefined).toBe("succeeded");
      expect(first?.resultJson?.configurationSupersession).toBeUndefined();
      expect(values).toEqual(["old"]);
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
      const next = await wake(); expect(next).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const second = await heartbeat.getRun(next!.id);
      expect(second?.status, second?.error ?? undefined).toBe("succeeded");
      expect(second?.resultJson?.configurationSupersession).toBeUndefined();
      expect(values).toEqual(["old", change === "remove plain" ? undefined : "new"]);
      expect(unchanged).toEqual(["steady", "steady"]);
      expect(hasK).toEqual([true, change !== "remove plain"]);
      expect(preparations).toBe(2);
      expect(preparedEnvs[0]).toEqual({ K: "old", UNCHANGED: "steady" });
      expect(preparedEnvs[1]).toEqual({ ...(change === "remove plain" ? {} : { K: "new" }), UNCHANGED: "steady" });
      process.stdout.write(`POST_COMPARE_AGENT_ENV ${JSON.stringify({ change, native, saveMs, blockedMs, firstHandoffMs: totalMs, preparations, values, hasK })}\n`);
    } finally {
      releaseFence(); await rotation?.catch(() => {}); await heartbeat.drainActiveRunExecutions();
      pause?.mockRestore(); provider?.mockRestore(); mode?.mockRestore(); unregisterServerAdapter("paperclip_runner");
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([false, true])("v8 model-change seam: preparation-window change launches old model once, next message uses new (native=%s)", async native => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "model-change-seam-"));
    const values: unknown[] = [];
    const mode = native ? undefined : vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const fixture = getServerAdapter(adapterType);
    registerServerAdapter({ ...fixture, type: "paperclip_runner", execute: async input => {
      values.push(input.config.model); return fixture.execute(input);
    } });
    const provider = native ? vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      values.push(input.execution.provider.model);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", resultJson: {} };
    }) : undefined;
    const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
    let preparations = 0;
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const config = { provider: "pi_rpc", model: "fixture/model-a", sessionContinuity: "continuous", cwd };
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations === 1) await db.update(agents).set({ adapterConfig: { ...config, model: "fixture/model-b" } }).where(eq(agents.id, f.agentId));
        return result;
      });
      for (let message = 0; message < 2; message++) {
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
        const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
          payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
        await heartbeat.drainActiveRunExecutions();
        const finished = await heartbeat.getRun(run!.id);
        expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
        expect(finished?.resultJson?.configurationSupersession).toBeUndefined();
      }
      expect(values).toEqual(["fixture/model-a", "fixture/model-b"]);
      expect(preparations).toBe(2);
    } finally {
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore(); provider?.mockRestore(); mode?.mockRestore();
      unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  // Real agent/settings services commit in both old windows. Only provisioner/provider I/O is substituted.
  it.each(["before final compare", "after final compare"].flatMap(window =>
    ["agent env", "agent default", "instance default"].flatMap(source =>
      [false, true].map(native => ({ window, source, native }))),
  ))("v11 committed save: $source $window (native=$native)", async ({ window, source, native }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "v11-save-window-"));
    const settings = instanceSettingsService(db), original = await settings.get();
    const envs = await db.insert(environments).values([
      { name: `V11 old ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" }, envVars: { CONTEXT_NOTE: "old" } },
      { name: `V11 new ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" }, envVars: { CONTEXT_NOTE: "current" } },
    ]).returning();
    const values: unknown[] = [], holds: boolean[] = [];
    const mode = native ? undefined : vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const fixture = getServerAdapter(adapterType);
    registerServerAdapter({ ...fixture, type: "paperclip_runner", execute: async input => {
      values.push((input.config.env as Record<string, unknown>)?.CONTEXT_NOTE); return fixture.execute(input);
    } });
    const provider = native ? vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      values.push(input.runnerEnvironment?.CONTEXT_NOTE);
      holds.push((await heldConfiguration.readHeldNativeTurnWork(db, input.execution.binding))?.endRequested === true);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "saved-session", resultJson: {} };
    }) : undefined;
    const createOrchestrator = environmentOrchestrator.environmentRunOrchestrator;
    const transport = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...createOrchestrator(...args), acquireForRun: async input => {
        const result = await createOrchestrator(...args).acquireForRun({ ...input, selectedEnvironmentId: input.localEnvironmentId });
        return { ...result, environment: (await environmentService(db).getById(input.selectedEnvironmentId!))! };
      }, realizeForRun: async input => ({ lease: input.lease, persistedExecutionWorkspace: input.persistedExecutionWorkspace,
        workspaceRealization: {}, executionTarget: null, remoteExecution: null }),
    }));
    const originalHeartbeat = heartbeat;
    heartbeat = heartbeatService(db);
    const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
    let preparations = 0, pause: ReturnType<typeof vi.spyOn> | undefined;
    let reached!: () => void, release!: () => void;
    let saving: Promise<unknown> | undefined, saveDeadline: ReturnType<typeof setTimeout> | undefined;
    const paused = new Promise<void>(resolve => { reached = resolve; }), resumed = new Promise<void>(resolve => { release = resolve; });
    const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd,
      ...(source === "agent env" ? { env: { CONTEXT_NOTE: { type: "plain", value: "old" } } } : {}) };
    try {
      await settings.updateGeneral({ executionMode: "any" });
      await settings.updateExperimental({ enableManagedSandboxOnly: false, remoteWorkspaceStorageEnabled: false });
      await settings.update({ defaultEnvironmentId: envs[0].id });
      await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config,
        defaultEnvironmentId: source === "instance default" ? null : envs[0].id }).where(eq(agents.id, f.agentId));
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations === 1 && result.prepared) {
          const fence = result.assertConfigurationCurrent;
          result.assertConfigurationCurrent = async (tx, issueId, lockIssue) => {
            if (window === "before final compare") return fence(tx, issueId, async () => { reached(); await resumed; await lockIssue(); });
            await fence(tx, issueId, lockIssue); reached(); await resumed;
          };
        }
        return result;
      });
      const wake = () => heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      const run = await wake(); expect(run).not.toBeNull();
      await Promise.race([paused, heartbeat.drainActiveRunExecutions().then(() => { throw new Error("No fence pause reached"); })]);
      const start = performance.now();
      saving = source === "agent env" ? agentService(db).update(f.agentId, { adapterConfig: { ...config, env: { CONTEXT_NOTE: { type: "plain", value: "current" } } } })
        : source === "agent default" ? agentService(db).update(f.agentId, { defaultEnvironmentId: envs[1].id })
        : settings.update({ defaultEnvironmentId: envs[1].id });
      await Promise.race([saving, new Promise((_, reject) => { saveDeadline = setTimeout(() => reject(new Error("Save could not commit during the paused handoff")), 1500); })]);
      clearTimeout(saveDeadline);
      const saveMs = performance.now() - start;
      expect(values).toEqual([]); release(); await heartbeat.drainActiveRunExecutions();
      const first = await heartbeat.getRun(run!.id);
      expect(first?.status, first?.error ?? undefined).toBe("succeeded");
      const early = window === "before final compare";
      if (early) {
        expect(values).toEqual(["current"]);
        expect(first?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
        if (native) expect(holds).toEqual([false]);
      } else {
        expect(values).toEqual(["old"]);
        // At attachment/hold start the committed save must retire this old admission.
        if (native) expect(holds).toEqual([true]);
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
        const next = await wake(); await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(next!.id))?.status).toBe("succeeded");
        expect(values).toEqual(["old", "current"]);
        if (native) expect(holds).toEqual([true, false]);
      }
      expect(preparations).toBe(2);
      process.stdout.write(`V11_SAVE_WINDOW ${JSON.stringify({ window, source, native, saveMs, preparations, values, holds })}\n`);
    } finally {
      clearTimeout(saveDeadline); release(); await saving?.catch(() => {}); await heartbeat.drainActiveRunExecutions(); pause?.mockRestore(); transport.mockRestore(); provider?.mockRestore(); mode?.mockRestore();
      heartbeat = originalHeartbeat;
      unregisterServerAdapter("paperclip_runner");
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
      await settings.updateGeneral({ executionMode: original.general.executionMode ?? "any" });
      await settings.updateExperimental({ enableManagedSandboxOnly: original.experimental.enableManagedSandboxOnly,
        remoteWorkspaceStorageEnabled: original.experimental.remoteWorkspaceStorageEnabled });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["agent env", "agent default"])("v11 %s save commits before native attachment; the saved admission closes without replacing its session", async source => {
    const f = await seed(), sessionId = randomUUID();
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [next] = await db.insert(environments).values({ name: `V11 late ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    const config = { provider: "pi_rpc", sessionContinuity: "continuous", env: { CONTEXT_NOTE: { type: "plain", value: "old" } } };
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config, defaultEnvironmentId: local.id }).where(eq(agents.id, f.agentId));
    const snapshot = await readExecutionConfigurationRows(db, { companyId: f.companyId, environmentId: local.id, projectId: null,
      plainSources: { agentId: f.agentId, agentEnv: config.env, agentDefaultEnvironmentId: local.id, issue: null, liveRoutine: null } });
    const contextSnapshot = { issueId: f.issueId, paperclipEnvironment: { id: local.id }, paperclipHeldConfiguration: {
      agentEnvFingerprint: snapshot.agentEnvFingerprint, agentDefaultEnvironmentId: local.id, selection: null } };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      nativeSessionId: sessionId, runtimeMode: "legacy", status: "running", contextSnapshot }).returning();
    try {
      if (source === "agent env") await agentService(db).update(f.agentId, { adapterConfig: { ...config, env: { CONTEXT_NOTE: { type: "plain", value: "current" } } } });
      else await agentService(db).update(f.agentId, { defaultEnvironmentId: next.id });
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBeUndefined();
      await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, run.id));
      expect((await heldConfiguration.readHeldNativeTurnWork(db, { ...f, runId: run.id }))?.endRequested).toBe(true);
      const after = await heartbeat.getRun(run.id);
      expect(after?.resultJson?.heldNativeConfigurationEnd).toBe(true);
      expect(after?.resultJson?.personStop).toBeUndefined();
      expect(after?.nativeSessionId).toBe(sessionId);
      expect(after?.contextSnapshot).toEqual(contextSnapshot);
    } finally { await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id)); }
  });

  it.each([false, true])("v11 instance default save retires only its prepared consumers, atomically; recovery sees the same close (previous release=%s)", async previousRelease => {
    const inherited = await seed(), own = await seed();
    const settings = instanceSettingsService(db), original = await settings.get();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [changedEnvironment] = await db.insert(environments).values({ name: `V11 settings ${inherited.companyId}`,
      driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    const runs: string[] = [];
    try {
      await settings.update({ defaultEnvironmentId: null });
      for (const f of [inherited, own]) {
        await db.update(agents).set({ defaultEnvironmentId: f === own ? environment.id : null }).where(eq(agents.id, f.agentId));
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
          runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: environment.id },
            ...(!previousRelease ? { paperclipHeldConfiguration: {
              selection: { localEnvironmentId: environment.id, executionMode: "any", managedSandboxOnly: false,
                ...(f === inherited ? { instanceDefaultEnvironmentId: null } : {}) },
            } } : {}) } }).returning();
        runs.push(run.id);
      }
      await expect(db.transaction(async tx => {
        await settings.update({ defaultEnvironmentId: changedEnvironment.id }, { db: tx });
        expect((await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runs[0])))[0].resultJson?.heldNativeConfigurationEnd).toBe(true);
        throw new Error("rollback-settings");
      })).rejects.toThrow("rollback-settings");
      expect((await heartbeat.getRun(runs[0]))?.resultJson?.heldNativeConfigurationEnd).toBeUndefined();
      await settings.update({ defaultEnvironmentId: changedEnvironment.id });
      expect((await heartbeat.getRun(runs[0]))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
      expect((await heartbeat.getRun(runs[1]))?.resultJson?.heldNativeConfigurationEnd).toBeUndefined();
      // Simulate a save that committed before admission/recovery attached:
      // no producer flag survives, but the admitted snapshot still does.
      const admitted = (await heartbeat.getRun(runs[0]))?.contextSnapshot;
      await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, runs[0]));
      expect((await heldConfiguration.readHeldNativeTurnWork(db, { ...inherited, runId: runs[0] }))?.endRequested).toBe(true);
      expect((await heartbeat.getRun(runs[0]))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
      expect((await heartbeat.getRun(runs[0]))?.contextSnapshot).toEqual(admitted);
      expect((await heldConfiguration.readHeldNativeTurnWork(db, { ...own, runId: runs[1] }))?.endRequested).toBe(false);
    } finally {
      if (runs.length) await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, runs));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  });

  it.each([false, true])("v12 real configuration close settles the run delivered to the page without a false failure (busy=%s)", async busy => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "v12-real-close-"));
    const { type: _type, ...fixture } = getServerAdapter(adapterType);
    registerServerAdapter({ ...fixture, type: "paperclip_runner" });
    const config = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd,
      env: { CONTEXT_NOTE: { type: "plain", value: "old" } } };
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: config }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId,
      conversationState: "active" }).where(eq(issues.id, f.issueId));
    const execute = nativeExecutor.executePaperclipNativeSession;
    const queue: import("@paperclipai/paperclip-runner").PrpEvent[] = [];
    let wake: (() => void) | undefined, closed = false, started = false, emit: ((kind: string, item?: string) => void) | undefined;
    const interrupt = vi.fn(async () => { emit!("turn.completed"); });
    const provider = vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async input => {
      const sessionId = input.execution.session.normalizedSessionId ?? randomUUID();
      const identity = { ...input.execution.binding, sessionId };
      let seq = 0;
      emit = (eventType, itemId) => { queue.push({ schema: "paperclip.prp.event.v1", schemaVersion: 1,
        sourceKind: "runner", sourceInstanceId: input.runnerInstanceId, sourceSeq: ++seq, sourceEventId: `event-${seq}`,
        emittedAt: new Date().toISOString(), priority: 0, normalizedSessionId: sessionId,
        runId: input.execution.binding.runId, turnId: "answer", eventType,
        ...(itemId ? { itemId } : {}), payload: eventType === "item.completed"
          ? { kind: "agentMessage", channel: "final", text: "Old answer finished.", answers: [] } : { origin: "provider" },
      } as import("@paperclipai/paperclip-runner").PrpEvent); wake?.(); };
      const capabilities = { resume: false, typedEvents: true, steering: true, interruption: true, structuredResult: true };
      const session: import("@paperclipai/paperclip-runner").NativeSession = {
        identity: () => identity, capabilities: async () => capabilities,
        snapshot: async () => ({ backendKind: "mock", driverKind: "pi_rpc", sessionId, identity,
          activeTurnId: "answer", pendingRuntimeRequests: [] }),
        async *events() { while (!closed) { if (queue.length) yield queue.shift()!;
          else await new Promise<void>(resolve => { wake = resolve; }); } },
        startTurn: async () => { started = true; emit!("turn.started"); if (!busy) emit!("item.completed", "answer-final"); return { turnId: "answer" }; },
        result: async () => null, interrupt, cancel: () => ({ cleanup: Promise.resolve() }),
        close: async () => { closed = true; wake?.(); },
      };
      return execute({ ...input, useRunnerd: false, backend: {
        descriptor: async () => ({ kind: "mock", name: "v12-real-close", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }),
        openSession: async () => session,
      } });
    });
    let runId: string | undefined;
    try {
      const run = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        requestedByActorType: "user", requestedByActorId: f.userId, manualUserWake: true,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      runId = run!.id;
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 15_000 });
      if (!busy) await vi.waitFor(async () => expect((await db.select().from(issueComments)
        .where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorAgentId, f.agentId)))).length).toBe(1));
      await agentService(db).update(f.agentId, { adapterConfig: { ...config, env: { CONTEXT_NOTE: { type: "plain", value: "current" } } } });
      if (busy) {
        expect(await nativeExecutor.closeHeldNativeTurn(runId)).toBe(false);
        expect(interrupt).not.toHaveBeenCalled();
        emit!("item.completed", "answer-final");
      }
      // Drive the same idle close as the observer. The actual runtime consumes
      // the driver's clean turn.completed; heartbeat, not this row, saves status.
      await vi.waitFor(async () => { await nativeExecutor.closeHeldNativeTurn(runId!); expect(interrupt).toHaveBeenCalledOnce(); }, { timeout: 10_000 });
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(runId);
      expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
      expect(finished?.resultJson?.heldNativeTurnCloseReason).toBe("configuration_changed");
      expect(finished?.resultJson?.personStop).toBeUndefined();
      expect(finished?.error).toBeNull();
      process.stdout.write(`V12_PAGE_CLOSE ${JSON.stringify({ busy, runId, status: finished?.status,
        terminal: finished?.resultJson?.nativeTerminal, personStop: finished?.resultJson?.personStop ?? null,
        error: finished?.error, closeReason: finished?.resultJson?.heldNativeTurnCloseReason })}\n`);
    } finally {
      if (!closed && emit) emit("turn.completed");
      await heartbeat.drainActiveRunExecutions(); closed = true; wake?.(); provider.mockRestore();
      unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it("v12 settings save bounds in-transaction consumers and defers locked overflow to the late hold check", async () => {
    const f = await seed(), settings = instanceSettingsService(db), original = await settings.get();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [nextEnvironment] = await db.insert(environments).values({ name: `V12 bound ${f.companyId}`,
      driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    await settings.update({ defaultEnvironmentId: null });
    const consumers = await db.insert(issues).values(Array.from({ length: 34 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1200-4000-8000-${f.companyId.slice(-12)}`,
      companyId: f.companyId, title: `Bound consumer ${index}`, status: "in_progress", assigneeAgentId: f.agentId,
    }))).returning();
    const runs = await db.insert(heartbeatRuns).values(consumers.map(issue => ({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: issue.id, runtimeMode: "native", status: "running", contextSnapshot: { issueId: issue.id,
        paperclipEnvironment: { id: environment.id }, paperclipHeldConfiguration: { selection: {
          localEnvironmentId: environment.id, executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null,
        } } } }))).returning();
    let unlock!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, consumers[33].id)).for("no key update");
      locked(); await new Promise<void>(resolve => { unlock = resolve; });
    });
    let save: Promise<unknown> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await acquired;
      const started = performance.now();
      save = settings.update({ defaultEnvironmentId: nextEnvironment.id });
      const outcome = await Promise.race([save.then(() => "saved"), new Promise<string>(resolve => {
        timer = setTimeout(() => resolve("blocked-on-overflow"), 1_500);
      })]);
      expect(outcome).toBe("saved");
      const saved = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runs.map(run => run.id)));
      expect(saved.filter(run => run.resultJson?.heldNativeConfigurationEnd === true)).toHaveLength(32);
      const overflow = runs.find(run => run.nativeIssueId === consumers[33].id)!;
      expect(saved.find(run => run.id === overflow.id)?.resultJson?.heldNativeConfigurationEnd).not.toBe(true);
      unlock(); await blocker;
      const lateAt = performance.now();
      expect((await heldConfiguration.readHeldNativeTurnWork(db, { ...f, issueId: consumers[33].id, runId: overflow.id }))?.endRequested).toBe(true);
      process.stdout.write(`V12_SETTINGS_BOUND ${JSON.stringify({ companyId: f.companyId, agentId: f.agentId,
        overflowRunId: overflow.id, overflowIssueId: consumers[33].id, consumers: runs.length, processed: 32, overflow: 2,
        saveMs: performance.now() - started, lateMs: performance.now() - lateAt })}\n`);
    } finally {
      clearTimeout(timer); unlock?.(); await blocker; await save;
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, runs.map(run => run.id)));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  });

  it("v12 ch11-lock: settings save and issue-then-agent repair share issue-before-agent lock order", async () => {
    const f = await seed(), settings = instanceSettingsService(db), original = await settings.get();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [next] = await db.insert(environments).values({ name: `V12 lock ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    await settings.update({ defaultEnvironmentId: null });
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      nativeIssueId: f.issueId, runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId,
        paperclipEnvironment: { id: environment.id }, paperclipHeldConfiguration: { selection: {
          localEnvironmentId: environment.id, executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null,
        } } } }).returning();
    let acquired!: () => void, repairAgent!: () => void, repairPid = 0;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const go = new Promise<void>(resolve => { repairAgent = resolve; });
    const repair = db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      repairPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0].pid);
      acquired(); await go;
      await tx.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, f.agentId));
    });
    const failure = (error: unknown) => {
      const codes: string[] = [];
      for (let cause = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
        if ("code" in cause) codes.push(String(cause.code));
      }
      return JSON.stringify({ error: String(error), codes });
    };
    const repairOutcome = repair.then(() => "committed", failure);
    let saving: Promise<string> | undefined;
    try {
      await locked;
      const started = performance.now();
      saving = settings.update({ defaultEnvironmentId: next.id }).then(() => "committed", failure);
      // Witness the real wait, not a sleep. On v11 the runtime trigger has
      // already locked the agent when the save waits on this issue.
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and ${repairPid} = any(pg_blocking_pids(pid))`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 10 });
      repairAgent();
      const outcomes = await Promise.all([saving, repairOutcome]);
      process.stdout.write(`V12_CH11_LOCK_OUTCOMES ${JSON.stringify({ outcomes, ms: performance.now() - started })}\n`);
      expect(outcomes).toEqual(["committed", "committed"]);
      expect((await settings.getReadOnly())?.defaultEnvironmentId).toBe(next.id);
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
      process.stdout.write(`V12_CH11_LOCK ${JSON.stringify({ ...f, runId: run.id, outcomes, ms: performance.now() - started })}\n`);
    } finally {
      repairAgent(); await repairOutcome; await saving;
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  });

  // Replay the designer's real cycle: settings owns issue -> waits at singleton;
  // agent owns agent -> records binding -> waits at issue. No injected SQLSTATE.
  it.each([false, true])("v15 real deadlock publishes one committed binding event (status PATCH=%s)", async withStatus => {
    const configModule = await import("../services/agent-configuration.js");
    const prepare = configModule.prepareAgentConfiguration;
    const f = await seed(), settings = instanceSettingsService(db), original = await settings.get();
    const local = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const [next] = await db.insert(environments).values({ name: `V15 replay ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    await settings.update({ defaultEnvironmentId: null });
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agentId));
    // Metadata only: no provider, key material or credential access is needed.
    const [secret] = await db.insert(companySecrets).values({ companyId: f.companyId, key: "REPLAY_REF", name: "Replay metadata", managedMode: "external_reference" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running",
      contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: local.id }, paperclipHeldConfiguration: { selection: { localEnvironmentId: local.id, executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null } } } }).returning();
    const events: unknown[] = [], codes: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "activity.logged" && event.payload.action === "secret.binding.created") events.push(event);
    });
    let attempts = 0, agentPid = 0;
    const observe = vi.spyOn(configModule, "prepareAgentConfiguration").mockImplementation(async (...args) => {
      if (args[1].id === f.agentId) { attempts++; agentPid = Number((await args[0].execute(sql`select pg_backend_pid() as pid`))[0].pid); }
      return prepare(...args);
    });
    const transaction = db.transaction.bind(db);
    const errors = vi.spyOn(db, "transaction").mockImplementation(((...args: Parameters<Db["transaction"]>) => transaction(...args).catch(error => {
      for (let cause = error; cause && typeof cause === "object"; cause = cause.cause) if (cause.code) codes.push(String(cause.code));
      throw error;
    })) as Db["transaction"]);
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { acquired = resolve; });
    const holder = db.transaction(async tx => { await tx.execute(sql`select id from instance_settings for update`); acquired(); await gate; });
    let saving: Promise<unknown> | undefined, agentSave: Promise<unknown> | undefined;
    try {
      await held;
      saving = settings.update({ defaultEnvironmentId: next.id });
      await vi.waitFor(async () => {
        const locked = await db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("no key update", { noWait: true }); return false; }).catch(() => true);
        expect(locked).toBe(true);
      }, { timeout: 5_000, interval: 10 });
      const patch = { adapterConfig: { model: "model-a", env: { REPLAY_REF: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const } } } };
      agentSave = (withStatus ? createAgentLifecycle(db).updateAndTransition(f.agentId, "pause", patch) : agentService(db).update(f.agentId, patch))
        .then(() => "committed", error => ({ error: String(error) }));
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where pid = ${agentPid} and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5_000, interval: 10 });
      release(); await holder;
      const outcomes = await Promise.all([saving.then(() => "committed"), agentSave]);
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.agentId), eq(activityLog.action, "secret.binding.created")));
      const [after] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      process.stdout.write(`V15_REAL_DEADLOCK_PUBLICATION ${JSON.stringify({ ...f, runId: run.id, secretId: secret.id, withStatus, attempts, codes, outcomes, liveEvents: events.length, activityRows: rows.length, activityIds: rows.map(row => row.id), events, defaultSaved: (await settings.getReadOnly())?.defaultEnvironmentId === next.id, agentStatus: after.status })}\n`);
      expect(codes).toContain("40P01");
      expect(attempts).toBe(2);
      expect(outcomes).toEqual(["committed", "committed"]);
      expect(events).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect((await settings.getReadOnly())?.defaultEnvironmentId).toBe(next.id);
      expect(after.adapterConfig).toMatchObject({ env: { REPLAY_REF: { secretId: secret.id } } });
      if (withStatus) expect(after.status).toBe("paused");
    } finally {
      release(); await holder; await saving; await agentSave; unsubscribe(); observe.mockRestore(); errors.mockRestore();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  }, 30_000);

  it("ch14-unwrapped-race: 150 real settings saves and status-carrying agent PATCH saves commit", async () => {
    const settings = instanceSettingsService(db), original = await settings.get();
    const f = await seed(), filler = await seed({});
    const local = await environmentService(db).ensureLocalEnvironment(f.companyId);
    await db.insert(agents).values(Array.from({ length: 150 }, (_, i) => ({ companyId: filler.companyId, name: `CH14 race filler ${i}`, adapterType, status: "idle" as const, adapterConfig: { model: "model-a" } })));
    await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running",
      contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: local.id }, paperclipHeldConfiguration: { selection: { localEnvironmentId: local.id, executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null } } } }).returning();
    const outcomes: unknown[] = [];
    try {
      for (let k = 0; k < 150; k++) {
        await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, run.id));
        const [next] = await db.insert(environments).values({ name: `CH14 unwrapped race ${f.companyId} ${k}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
        const [before] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        const command = before.status === "paused" ? "resume" : "pause";
        const saves = await Promise.allSettled([
          settings.update({ defaultEnvironmentId: next.id }),
          new Promise(resolve => setTimeout(resolve, (k % 6) * 2)).then(() => createAgentLifecycle(db).updateAndTransition(f.agentId, command, { adapterConfig: { model: "model-a", env: { CONTEXT_NOTE: { type: "plain", value: `urace-${k}` } } } })),
        ]);
        const [after] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        // Lifecycle completion is asynchronous; the durable command's manual
        // hold, not an immediate ready/idle worker result, is the save contract.
        expect(after.lifecycleHolds.includes("manual")).toBe(command === "pause");
        outcomes.push({ round: k, outcomes: saves.map(value => value.status === "fulfilled" ? "committed" : String(value.reason)), envSaved: JSON.stringify(after.adapterConfig).includes(`urace-${k}`), status: after.status, command, manualHold: after.lifecycleHolds.includes("manual"), defaultSaved: (await settings.getReadOnly())?.defaultEnvironmentId === next.id });
      }
      process.stdout.write(`CH14_UNWRAPPED_RACE ${JSON.stringify({ ...f, runId: run.id, rounds: 150, outcomes })}\n`);
      expect(outcomes).toEqual(Array.from({ length: 150 }, (_, round) => expect.objectContaining({ round, outcomes: ["committed", "committed"], envSaved: true, defaultSaved: true })));
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  }, 280_000);

  // Known limit, NOT a promise of three-writer recovery. Reuse CH14_DOUBLE's
  // two witnessed real cycles, through the actual settings route/error handler.
  it("CH14_DOUBLE known limit: two deadlocks return an HTTP error, never a saved settings receipt", async () => {
    const configModule = await import("../services/agent-configuration.js");
    const prepare = configModule.prepareAgentConfiguration;
    const settings = instanceSettingsService(db), original = await settings.get();
    const fs = [await seed({}), await seed({})];
    const local = await environmentService(db).ensureLocalEnvironment(fs[0].companyId);
    const [next] = await db.insert(environments).values({ name: `CH14 double ${randomUUID()}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    await settings.update({ defaultEnvironmentId: null });
    const runs: string[] = [];
    for (const f of fs) {
      await db.update(agents).set({ defaultEnvironmentId: null }).where(eq(agents.id, f.agentId));
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running",
        contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: local.id }, paperclipHeldConfiguration: { selection: { localEnvironmentId: local.id, executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null } } } }).returning();
      runs.push(run.id);
    }
    const gates = fs.map(() => { let release!: () => void, reached!: () => void; const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { reached = r; }); return { release, reached, gate, ready, pid: 0, passes: 0 }; });
    const pause = vi.spyOn(configModule, "prepareAgentConfiguration").mockImplementation(async (...args) => {
      const i = fs.findIndex(f => f.agentId === args[1].id);
      if (i >= 0) { const g = gates[i]; g.passes++; if (g.passes === 1) { g.pid = Number((await args[0].execute(sql`select pg_backend_pid() as pid`))[0].pid); g.reached(); await g.gate; } }
      return prepare(...args);
    });
    const lockConsumers = heldConfiguration.lockHeldNativeSettingsConsumers; let settingsAttempts = 0;
    const count = vi.spyOn(heldConfiguration, "lockHeldNativeSettingsConsumers").mockImplementation(tx => { settingsAttempts++; return lockConsumers(tx); });
    const app = express(); app.use(express.json());
    app.use((req, _res, nextMiddleware) => { req.actor = { type: "board", source: "local_implicit", isInstanceAdmin: true, userId: fs[0].userId }; nextMiddleware(); });
    const routeErrorCodes: string[] = [];
    app.use("/api", instanceSettingsRoutes(db));
    app.use((error: unknown, _req: express.Request, _res: express.Response, nextMiddleware: express.NextFunction) => {
      for (let cause = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
        if ("code" in cause) routeErrorCodes.push(String(cause.code));
      }
      nextMiddleware(error);
    });
    app.use(errorHandler);
    const agentSaves = fs.map(f => agentService(db).update(f.agentId, { adapterConfig: { model: "model-a", env: { CONTEXT_NOTE: { type: "plain", value: "double" } } } })
      .then(() => "committed", error => String(error)));
    let response: request.Response | undefined, saving: Promise<void> | undefined;
    try {
      await Promise.all(gates.map(g => g.ready));
      saving = request(app).patch("/api/instance/settings").send({ defaultEnvironmentId: next.id }).then(value => { response = value; });
      const released = new Set<number>(), steps: unknown[] = [];
      for (let step = 0; step < 2; step++) {
        let idx = -1;
        await vi.waitFor(async () => {
          const rows = await db.execute(sql`select pg_blocking_pids(pid) as blockers from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
          const blockers = rows.flatMap(row => (row.blockers as number[]).map(Number));
          idx = gates.findIndex((g, j) => !released.has(j) && blockers.includes(g.pid));
          expect(idx).toBeGreaterThanOrEqual(0);
        }, { timeout: 5_000, interval: 10 });
        released.add(idx); steps.push({ step, blockedOnAgent: idx, settingsAttempt: settingsAttempts }); gates[idx].release();
      }
      gates.forEach(g => g.release()); await saving;
      const agentResults = await Promise.all(agentSaves);
      const defaultSaved = (await settings.getReadOnly())?.defaultEnvironmentId === next.id;
      process.stdout.write(`CH14_DOUBLE ${JSON.stringify({ limit: "KNOWN LIMIT, NOT FIXED", fixtures: fs, runs, steps, settingsAttempts, agentAttempts: gates.map(g => g.passes), agentResults, defaultSaved, route: { status: response?.status, body: response?.body, errorCodes: routeErrorCodes } })}\n`);
      expect(settingsAttempts).toBe(2);
      expect(agentResults).toEqual(["committed", "committed"]);
      expect(defaultSaved).toBe(false);
      expect(routeErrorCodes).toContain("40P01");
      expect(response?.status).toBe(500);
      expect(response?.body).toEqual({ error: "Internal server error" });
    } finally {
      gates.forEach(g => g.release()); await saving; await Promise.all(agentSaves); pause.mockRestore(); count.mockRestore();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, runs));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  }, 30_000);

  it("v14 inverse lock: real agent save paused after its agent lock and settings save both commit", async () => {
    const configModule = await import("../services/agent-configuration.js");
    const prepare = configModule.prepareAgentConfiguration;
    const f = await seed(), settings = instanceSettingsService(db), original = await settings.get();
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    const [next] = await db.insert(environments).values({ name: `V14 inverse ${f.companyId}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    await settings.update({ defaultEnvironmentId: null });
    await db.update(agents).set({ defaultEnvironmentId: null, adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: environment.id },
        paperclipHeldConfiguration: { selection: { executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: null } } } }).returning();
    let release!: () => void, acquired!: () => void, agentPid = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { acquired = resolve; });
    const pause = vi.spyOn(configModule, "prepareAgentConfiguration").mockImplementationOnce(async (...args) => {
      agentPid = Number((await args[0].execute(sql`select pg_backend_pid() as pid`))[0].pid);
      acquired(); await gate; return prepare(...args);
    });
    const failure = (error: unknown) => {
      const codes: string[] = [];
      for (let cause = error; cause && typeof cause === "object"; cause = (cause as { cause?: unknown }).cause) {
        if ("code" in cause) codes.push(String(cause.code));
      }
      return { error: String(error), codes };
    };
    const agentSave = agentService(db).update(f.agentId, { adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous",
      env: { CONTEXT_NOTE: { type: "plain", value: "current" } } } }).then(() => "committed", failure);
    let settingsSave: Promise<unknown> | undefined;
    try {
      await locked;
      settingsSave = settings.update({ defaultEnvironmentId: next.id }).then(() => "committed", failure);
      await vi.waitFor(async () => {
        const waits = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and ${agentPid} = any(pg_blocking_pids(pid))`);
        expect(waits.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 10 });
      release();
      const outcomes = await Promise.all([settingsSave, agentSave]);
      process.stdout.write(`V14_INVERSE_LOCK ${JSON.stringify({ ...f, runId: run.id, agentPid, outcomes })}\n`);
      expect(outcomes).toEqual(["committed", "committed"]);
      expect((await settings.getReadOnly())?.defaultEnvironmentId).toBe(next.id);
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
    } finally {
      release(); await agentSave; await settingsSave; pause.mockRestore();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  });

  it("v14 concurrent real agent and settings saves commit in 30 of 30 rounds", async () => {
    const f = await seed(), settings = instanceSettingsService(db), original = await settings.get();
    const envs = await db.insert(environments).values(["before", "after"].map(name => ({ name: `V14 ${name} ${f.companyId}`,
      driver: "sandbox", status: "active", config: { provider: "fixture" } }))).returning();
    await settings.update({ defaultEnvironmentId: envs[0].id });
    await db.update(agents).set({ defaultEnvironmentId: null, adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    await db.insert(agents).values(Array.from({ length: 150 }, (_, index) => ({ companyId: f.companyId, name: `Runtime hook ${index}`, adapterType: "process", adapterConfig: { command: "true" } })));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId: f.issueId, paperclipEnvironment: { id: envs[0].id },
        paperclipHeldConfiguration: { selection: { executionMode: "any", managedSandboxOnly: false, instanceDefaultEnvironmentId: envs[0].id } } } }).returning();
    const outcomes: unknown[] = [];
    try {
      for (let round = 0; round < 30; round++) {
        await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, run.id));
        const target = envs[(round + 1) % 2].id;
        const saves = await Promise.allSettled([
          settings.update({ defaultEnvironmentId: target }),
          agentService(db).update(f.agentId, { adapterConfig: { provider: "pi_rpc", sessionContinuity: "continuous",
            env: { CONTEXT_NOTE: { type: "plain", value: `round-${round}` } } } }),
        ]);
        outcomes.push({ round, outcomes: saves.map(value => value.status === "fulfilled" ? "committed" : String(value.reason)) });
        if (saves.every(value => value.status === "fulfilled")) {
          expect((await settings.getReadOnly())?.defaultEnvironmentId).toBe(target);
          expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
        }
      }
      process.stdout.write(`V14_CONCURRENT_LOCK ${JSON.stringify({ ...f, runId: run.id, outcomes })}\n`);
      expect(outcomes).toEqual(Array.from({ length: 30 }, (_, round) => ({ round, outcomes: ["committed", "committed"] })));
    } finally {
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
    }
  });

  it.each(["default", "executionMode", "managedOnly"] as const)("v14 retries the complete %s settings save once after rolled-back 40P01", async kind => {
    const settings = instanceSettingsService(db), original = await settings.get();
    const [target] = await db.insert(environments).values({ name: `V14 retry ${randomUUID()}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    const transaction = db.transaction.bind(db);
    let attempts = 0;
    const injected = new Error("rolled-back deadlock victim", { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });
    const spy = vi.spyOn(db, "transaction").mockImplementation(((callback: Parameters<Db["transaction"]>[0], ...options: unknown[]) =>
      transaction(async tx => {
        attempts++;
        const result = await callback(tx);
        if (attempts === 1) throw injected; // Real PG rolls back ALL of this save.
        return result;
      }, ...options as [])) as Db["transaction"]);
    try {
      if (kind === "default") expect((await settings.update({ defaultEnvironmentId: target.id })).defaultEnvironmentId).toBe(target.id);
      if (kind === "executionMode") expect((await settings.updateGeneral({ executionMode: "kubernetes" })).general.executionMode).toBe("kubernetes");
      if (kind === "managedOnly") expect((await settings.updateExperimental({ enableManagedSandboxOnly: !original.experimental.enableManagedSandboxOnly })).experimental.enableManagedSandboxOnly).toBe(!original.experimental.enableManagedSandboxOnly);
      expect(attempts).toBe(2);
      process.stdout.write(`V14_SETTINGS_RETRY ${JSON.stringify({ kind, targetEnvironmentId: target.id, attempts, sqlState: "40P01" })}\n`);
    } finally {
      spy.mockRestore();
      await settings.update({ defaultEnvironmentId: original.defaultEnvironmentId });
      await settings.updateGeneral({ executionMode: original.general.executionMode });
      await settings.updateExperimental({ enableManagedSandboxOnly: original.experimental.enableManagedSandboxOnly });
    }
  });

  it.each(["40P01", "08006", "40001", "55P03"])("v14 settings transaction retry is bounded and only for 40P01 (%s)", async code => {
    const settings = instanceSettingsService(db), original = await settings.get();
    const [target] = await db.insert(environments).values({ name: `V14 reject ${randomUUID()}`, driver: "sandbox", status: "active", config: { provider: "fixture" } }).returning();
    const transaction = db.transaction.bind(db);
    const injected = new Error("transaction failure", { cause: Object.assign(new Error(code), { code }) });
    let attempts = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(((callback: Parameters<Db["transaction"]>[0], ...options: unknown[]) =>
      transaction(async tx => { attempts++; await callback(tx); throw injected; }, ...options as [])) as Db["transaction"]);
    try {
      await expect(settings.update({ defaultEnvironmentId: target.id })).rejects.toBe(injected);
      expect(attempts).toBe(code === "40P01" ? 2 : 1);
      expect((await settings.getReadOnly())?.defaultEnvironmentId).toBe(original.defaultEnvironmentId);
      process.stdout.write(`V14_SETTINGS_RETRY_LIMIT ${JSON.stringify({ code, targetEnvironmentId: target.id, attempts, defaultUnchanged: true })}\n`);
    } finally { spy.mockRestore(); }
  });

  it("v6 agent env save fences an admitted held turn in the save transaction", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous" } }).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issueId } }).returning();
    try {
      await agentService(db).update(f.agentId, { adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", env: { CONTEXT_NOTE: "current" } } });
      expect((await heartbeat.getRun(run.id))?.resultJson?.heldNativeConfigurationEnd).toBe(true);
      expect((await heartbeat.getRun(run.id))?.resultJson?.personStop).toBeUndefined();
    } finally { await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id)); }
  });

  async function seedPendingConfiguration() {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", nativeIssueId: f.issueId,
      controllerBootId: currentControllerBootId(), contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.issueId));
    expect(await configurationSupersession.parkConfigurationSupersession(db, run)).toBe(true);
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
    return { ...f, run };
  }

  it("v6 recovery spaces substantive attempts despite three rapid passes", async () => {
    const f = await seedPendingConfiguration();
    let cleanups = 0;
    try {
      for (let pass = 0; pass < 3; pass++) await configurationSupersession.recoverConfigurationSupersessions(db, {
        runIds: [f.run.id], isExecuting: () => false,
        cleanup: async () => { cleanups++; throw new Error("cleanup still pending"); }, resume: async () => { throw new Error("unexpected resume"); },
      });
      expect(cleanups).toBe(1);
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "scheduled_retry", resultJson: { configurationSupersession: { recoveryAttempts: 1 } } });
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it.each(["backend terminated", "serialization", "deadlock", "wrapped connection", "08006", "08004", "57P01", "57P02", "57P03"] as const)("v6 recovery DB unavailable: %s does not spend an attempt", async failure => {
    const f = await seedPendingConfiguration();
    const errors: string[] = [];
    let fail = true, resumed = 0;
    const recover = () => configurationSupersession.recoverConfigurationSupersessions(db, {
      runIds: [f.run.id], isExecuting: () => false,
      cleanup: async () => {
        if (!fail) return;
        try {
          if (failure === "backend terminated") await db.transaction(async tx => { await tx.execute(sql`select pg_terminate_backend(pg_backend_pid())`); });
          else if (failure === "serialization") await db.execute(sql`do $$ begin raise exception 'retry transaction' using errcode = '40001'; end $$`);
          else if (failure === "deadlock") await db.execute(sql`do $$ begin raise exception 'retry transaction' using errcode = '40P01'; end $$`);
          else if (failure.length === 5) await db.execute(sql.raw(`do $$ begin raise exception 'database availability failure' using errcode = '${failure}'; end $$`));
          else {
            try { await db.transaction(async tx => { await tx.execute(sql`select pg_terminate_backend(pg_backend_pid())`); }); }
            catch (cause) { throw new Error("database operation unavailable", { cause }); }
          }
        } catch (error) {
          const codes: string[] = []; let cause: unknown = error;
          while (cause && typeof cause === "object") { const value = cause as { code?: string; cause?: unknown }; if (value.code) codes.push(value.code); cause = value.cause; }
          errors.push(...codes); throw error;
        }
      }, resume: async () => { resumed++; },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
        await recover();
        const pending = await heartbeat.getRun(f.run.id);
        expect(pending?.status).toBe("scheduled_retry");
        expect(pending?.resultJson?.configurationSupersession).not.toHaveProperty("recoveryAttempts");
      }
      expect(errors).toHaveLength(3);
      expect(errors.every(code => failure === "serialization" ? code === "40001" : failure === "deadlock" ? code === "40P01" : failure.length === 5 ? code === failure : ["CONNECTION_CLOSED", "57P01"].includes(code))).toBe(true);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      fail = false;
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
      await recover();
      expect(resumed).toBe(1);
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "queued", resultJson: { configurationSupersession: { state: "ready" } } });
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it.each(["ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT", "EPIPE", "40001", "40P01", "57P01", "08006", "CONNECTION_CLOSED", "spoofed PostgresError"])(
    "v8 non-database cleanup code %s spends its bounded budget", async code => {
      const f = await seedPendingConfiguration();
      try {
        for (let pass = 0; pass < 3; pass++) {
          await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
          await configurationSupersession.recoverConfigurationSupersessions(db, { runIds: [f.run.id], isExecuting: () => false,
            cleanup: async () => { throw new Error("runner lease release unavailable", { cause: Object.assign(new Error("runner failure"),
              code === "spoofed PostgresError" ? { code: "40001", name: "PostgresError", severity: "ERROR" } : { code }) }); },
            resume: async () => { throw new Error("unexpected resume"); } });
        }
        expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete",
          resultJson: { configurationSupersession: { recoveryAttempts: 3 } } });
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toContain("Owner: Session owner; Agent: Session reader.");
      } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
    });

  it.each(["08P01", "53400", "53300", "55P03"])("v8 genuine non-availability database state %s stops after three failures", async code => {
    const f = await seedPendingConfiguration();
    try {
      for (let pass = 0; pass < 3; pass++) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
        await configurationSupersession.recoverConfigurationSupersessions(db, { runIds: [f.run.id], isExecuting: () => false,
          cleanup: async () => { await db.execute(sql.raw(`do $$ begin raise exception 'permanent database failure' using errcode = '${code}'; end $$`)); },
          resume: async () => { throw new Error("unexpected resume"); } });
      }
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "failed", resultJson: { configurationSupersession: { recoveryAttempts: 3 } } });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it("v8 an unreachable runner host ends within the cap with a person-named notice", async () => {
    const f = await seedPendingConfiguration();
    const server = createNetServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected fixture port");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const startedAt = Date.now(), codes: string[] = [];
    try {
      for (let pass = 0; pass < 3; pass++) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
        await configurationSupersession.recoverConfigurationSupersessions(db, { runIds: [f.run.id], isExecuting: () => false,
          cleanup: () => new Promise<void>((resolve, reject) => {
            const socket = connect({ host: "127.0.0.1", port: address.port });
            socket.once("connect", () => { socket.destroy(); resolve(); });
            socket.once("error", error => { socket.destroy(); codes.push((error as NodeJS.ErrnoException).code!); reject(error); });
          }), resume: async () => { throw new Error("unexpected resume"); } });
      }
      expect(codes).toEqual(["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"]);
      expect(Date.now() - startedAt).toBeLessThan(15 * 60_000);
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("Owner: Session owner; Agent: Session reader.");
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it.each(["database still failing", "healthy after pause", "cleanup now failing"] as const)("v9 deadline recovery: %s", async cause => {
    const f = await seedPendingConfiguration();
    let cleanups = 0, resumed = 0;
    const recover = () => configurationSupersession.recoverConfigurationSupersessions(db, { runIds: [f.run.id], isExecuting: () => false,
      cleanup: async () => {
        cleanups++;
        if (cleanups > 1 && cause === "healthy after pause") return;
        if (cleanups > 1 && cause === "cleanup now failing") throw new Error("runner cleanup failed");
        await db.transaction(async tx => { await tx.execute(sql`select pg_terminate_backend(pg_backend_pid())`); });
      }, resume: async () => { resumed++; } });
    try {
      await recover();
      const pending = await heartbeat.getRun(f.run.id);
      expect(pending?.resultJson?.configurationSupersession).not.toHaveProperty("recoveryAttempts");
      expect(pending?.resultJson?.configurationSupersession).toHaveProperty("availabilityFailureAt");
      // Age the durable first-failure timestamp, not the wall clock or the
      // due scheduler: simulate a stopped server missing all intervening passes.
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0), resultJson: {
        ...pending!.resultJson, configurationSupersession: { ...pending!.resultJson!.configurationSupersession as object,
          availabilityFailureAt: new Date(Date.now() - 15 * 60_000 - 1).toISOString() },
      } }).where(eq(heartbeatRuns.id, f.run.id));
      await recover();
      expect(cleanups).toBe(2);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      if (cause === "healthy after pause") {
        expect(resumed).toBe(1);
        expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "queued", resultJson: { configurationSupersession: { state: "ready" } } });
        expect(comments).toHaveLength(0);
      } else {
        expect(resumed).toBe(0);
        expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete",
          resultJson: { configurationIncomplete: { reason: cause === "database still failing" ? "configuration_recovery_unavailable" : "configuration_recovery_stalled" },
            configurationSupersession: { state: "recovery_exhausted" } } });
        expect(comments).toHaveLength(1);
        expect(comments[0].body).toContain(cause === "database still failing" ? "a database operation still failed" : "execution ownership or cleanup still failed");
        expect(comments[0].body).not.toContain("restore database access");
        expect(comments[0].body).not.toContain("three recovery attempts");
        expect(comments[0].body).toContain("Owner: Session owner; Agent: Session reader.");
      }
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it("v6 retryable requeue transaction errors do not spend recovery attempts", async () => {
    const f = await seedPendingConfiguration();
    let resumed = 0;
    const recover = () => configurationSupersession.recoverConfigurationSupersessions(db, {
      runIds: [f.run.id], isExecuting: () => false, cleanup: async () => {}, resume: async () => { resumed++; },
    });
    try {
      // A real failed UPDATE/rollback in the requeue transaction (not cleanup).
      await db.execute(sql.raw(`create function v6_requeue_unavailable() returns trigger language plpgsql as $$
        begin
          if NEW.id = '${f.run.id}'::uuid and NEW.status = 'queued' and OLD.error_code = 'configuration_superseded' then
            raise exception 'retry requeue transaction' using errcode = '40001';
          end if;
          return NEW;
        end $$`));
      await db.execute(sql`create trigger v6_requeue_unavailable before update on heartbeat_runs for each row execute function v6_requeue_unavailable()`);
      for (let attempt = 0; attempt < 3; attempt++) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
        await recover();
        const pending = await heartbeat.getRun(f.run.id);
        expect(pending?.status).toBe("scheduled_retry");
        expect(pending?.resultJson?.configurationSupersession).not.toHaveProperty("recoveryAttempts");
      }
      expect(resumed).toBe(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      await db.execute(sql`drop trigger v6_requeue_unavailable on heartbeat_runs`);
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
      await recover();
      expect(resumed).toBe(1);
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "queued", resultJson: { configurationSupersession: { state: "ready" } } });
    } finally {
      await db.execute(sql`drop trigger if exists v6_requeue_unavailable on heartbeat_runs`);
      await db.execute(sql`drop function if exists v6_requeue_unavailable()`);
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id));
    }
  });

  it("v6 simultaneous recovery passes claim only one due interval", async () => {
    const f = await seedPendingConfiguration();
    let cleanups = 0;
    const recover = () => configurationSupersession.recoverConfigurationSupersessions(db, {
      runIds: [f.run.id], isExecuting: () => false,
      cleanup: async () => { cleanups++; throw new Error("cleanup still pending"); }, resume: async () => {},
    });
    try {
      await Promise.all([recover(), recover(), recover()]);
      expect(cleanups).toBe(1);
      const pending = await heartbeat.getRun(f.run.id);
      expect(pending).toMatchObject({ status: "scheduled_retry", resultJson: { configurationSupersession: { recoveryAttempts: 1 } } });
      expect(pending!.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now());
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); }
  });

  it.each(["issue", "run"] as const)("v6 real terminal callback preserves a live successor of the same agent (responsible person from %s)", async responsibleSource => {
    const f = await seedPendingConfiguration();
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId } }).returning();
    await db.update(agents).set({ status: "running" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ executionRunId: successor.id, status: "in_progress",
      ...(responsibleSource === "run" ? { responsibleUserId: null } : {}),
    }).where(eq(issues.id, f.issueId));
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, f.run.id));
        // Public entry point: actual cleanup, finalizeAgentStatus and issue
        // release/promotion; no substituted terminal callback.
        await heartbeat.promoteDueScheduledRetries();
        expect((await heartbeat.getRun(f.run.id))?.resultJson?.configurationSupersession).toMatchObject({ recoveryAttempts: attempt });
      }
      expect(await heartbeat.getRun(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
      expect(await heartbeat.getRun(successor.id)).toMatchObject({ status: "running", errorCode: null });
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(agent.status).toBe("running");
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue).toMatchObject({ executionRunId: successor.id, status: "in_progress" });
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("Owner: Session owner; Agent: Session reader.");
      expect(comments[0].body).not.toContain(f.userId); expect(comments[0].body).not.toContain(f.agentId);
    } finally { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.companyId, f.companyId)); }
  });

  // Real PG writes after value resolution must not retire an unchanged launch.
  // Provider I/O alone is substituted, as in the existing preparation-window rows.
  it.each([
    "environment status", "environment metadata", "environment probe proof", "environment RPC timeout",
    "project workspace sync", "project budget pause/release", "project git authorization", "project repository replace", "environment status PATCH",
    "environment identical save", "project identical save", "user declaration identical save", "secret display name", "pinned secret rotation",
  ] as const)("preparation content: %s does not supersede unchanged inputs", async change => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "preparing-content-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const secrets = secretService(db), value = randomUUID();
      const secret = await secrets.create(f.companyId, { name: "Content fixture", key: "CONTENT_FIXTURE", provider: "local_encrypted", value });
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", environmentRoutes(db)); app.use("/api", projectRoutes(db)); app.use(errorHandler);
      if (change === "user declaration identical save") {
        await secrets.createUserSecretDefinition(f.companyId, { key: "user_content_fixture", name: "User content fixture", provider: "local_encrypted" });
        await secrets.createCurrentUserSecretValue(f.companyId, f.userId, { definitionKey: "user_content_fixture", value: randomUUID() });
      }
      const version = change === "pinned secret rotation" ? 1 : "latest";
      const envVars = { CONTENT_FIXTURE: { type: "secret_ref", secretId: secret.id, version }, CONTEXT_NOTE: "unchanged",
        ...(change === "user declaration identical save" ? { USER_CONTENT_FIXTURE: { type: "user_secret_ref", key: "user_content_fixture", version: "latest" } } : {}),
      };
      expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ envVars })).status).toBe(200);
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Content project" }).returning();
      const projectEnv = { PROJECT_FIXTURE: { type: "secret_ref", secretId: secret.id, version } };
      expect((await request(app).patch(`/api/projects/${project.id}`).send({ env: projectEnv })).status).toBe(200);
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      let preparations = 0;
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        preparations++;
        if (preparations !== 1) return result;
        expect(result.prepared).toBe(true);
        if (change === "environment status") await db.update(environments).set({ status: "active", updatedAt: new Date() }).where(eq(environments.id, environment.id));
        else if (change === "environment metadata" || change === "environment probe proof") await db.update(environments).set({
          metadata: { ...environment.metadata, ...(change === "environment metadata" ? { displayNote: "changed" } : { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { [f.companyId]: { v: 2, testedAt: new Date().toISOString() } } }) }, updatedAt: new Date(),
        }).where(eq(environments.id, environment.id));
        else if (change === "environment RPC timeout") await db.update(environments).set({ config: { ...environment.config, timeoutMs: 123456 }, updatedAt: new Date() }).where(eq(environments.id, environment.id));
        else if (change === "environment status PATCH") {
          expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ status: "active" })).status).toBe(200);
        }
        else if (change === "project repository replace") expect(await projectService(db).replaceRepositories(project.id, [])).not.toBeNull();
        else if (change === "project workspace sync") await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
        else if (change === "project budget pause/release") {
          // Both budget-owned writes commit while preparation is in flight.
          // Release the budget hold before dispatch; this is not a budget bypass.
          await db.update(projects).set({ pauseReason: "budget", pausedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, project.id));
          await db.update(projects).set({ pauseReason: null, pausedAt: null, updatedAt: new Date() }).where(eq(projects.id, project.id));
        } else if (change === "project git authorization") await projectGitAuthorizationService(db).set(f.companyId, project.id, f.userId, null);
        else if (change === "secret display name") await secrets.update(secret.id, { name: "Renamed content fixture" });
        else if (change === "pinned secret rotation") await secrets.rotate(secret.id, { value: randomUUID() });
        else if (change === "user declaration identical save") {
          const [before] = await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.companyId, f.companyId));
          expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ envVars })).status).toBe(200);
          const [after] = await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.companyId, f.companyId));
          expect(after.id).not.toBe(before.id);
        }
        else {
          const targetId = change === "environment identical save" ? environment.id : project.id;
          const before = await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, f.companyId), eq(companySecretBindings.targetId, targetId)));
          const response = change === "environment identical save"
            ? await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ envVars })
            : await request(app).patch(`/api/projects/${project.id}`).send({ env: projectEnv });
          expect(response.status).toBe(200);
          const after = await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, f.companyId), eq(companySecretBindings.targetId, targetId)));
          expect(after).toHaveLength(1);
          expect(after[0].id).not.toBe(before[0].id);
        }
        return result;
      });
      const next = await execute(f);
      expect(preparations, "unchanged content must not cause another preparation").toBe(1);
      expect(next.finished.resultJson?.configurationSupersession).toBeUndefined();
      expect(dispatchCounts.get(next.finished.id)).toBe(1);
      const delivered = next.input.config.env as Record<string, unknown>;
      expect(delivered.CONTENT_FIXTURE === value && delivered.PROJECT_FIXTURE === value).toBe(true);
      const [reads] = await db.execute(sql`select count(*)::int as n from secret_access_events
        where heartbeat_run_id = ${next.finished.id} and secret_id = ${secret.id} and outcome = 'success'`);
      expect(reads.n, "one resolve per admitted binding, not another preparation or freshness resolve").toBe(2);
      expect(await db.execute(sql`select status from configuration_status_probe where issue_id = ${f.issueId} and status = 'blocked'`)).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars, config: environment.config, status: environment.status, metadata: environment.metadata }).where(eq(environments.id, environment.id));
      await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    { target: "environment", changed: false }, { target: "project", changed: false },
    { target: "environment", changed: true }, { target: "project", changed: true },
    { target: "agent", changed: false }, { target: "issue", changed: false }, { target: "routine", changed: false },
    { target: "agent", changed: true }, { target: "issue", changed: true }, { target: "routine", changed: true },
  ] as const)("preparation content fence: open $target write waits for its row lock, changed=$changed", async ({ target, changed }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "content-share-fence-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let commit: (() => void) | undefined, writer: Promise<void> | undefined;
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Open content write", env: { PROJECT_NOTE: "old" } }).returning();
      const routine = target === "routine" ? await routineService(db).create(f.companyId, createRoutineSchema.parse({
        title: "Open routine content write", assigneeAgentId: f.agentId, env: { CONTEXT_NOTE: "old" },
      }), { userId: f.userId }) : null;
      await db.update(issues).set({ projectId: project.id,
        ...(target === "issue" ? { assigneeAdapterOverrides: { adapterConfig: { env: { CONTEXT_NOTE: { type: "plain", value: "old" } } } } } : {}),
        ...(routine ? { originKind: "routine_execution", originId: routine.id } : {}),
      }).where(eq(issues.id, f.issueId));
      await db.update(environments).set({ envVars: { ENV_NOTE: "old" } }).where(eq(environments.id, environment.id));
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd,
          ...(target === "agent" ? { env: { CONTEXT_NOTE: { type: "plain", value: "old" } } } : {}),
        } }).where(eq(agents.id, f.agentId));
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      let preparations = 0;
      const gate = new Promise<void>(resolve => { commit = resolve; });
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations === 1 && result.prepared) {
          const assertCurrent = result.assertConfigurationCurrent;
          result.assertConfigurationCurrent = async (transaction, ownershipIssueId, lockIssue) => {
            // Start at the final fence: earlier workspace preparation also
            // locks the environment, and is not the SHARE boundary under test.
            let written = false;
            writer = db.transaction(async tx => {
              if (target === "environment") await tx.update(environments).set(changed ? { envVars: { ENV_NOTE: "current" } }
                : { metadata: { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { [f.companyId]: { v: 2 } } }, updatedAt: new Date() }).where(eq(environments.id, environment.id));
              else if (target === "project") await tx.update(projects).set(changed ? { env: { PROJECT_NOTE: "current" } }
                : { updatedAt: new Date() }).where(eq(projects.id, project.id));
              else if (target === "agent") await tx.update(agents).set(changed ? {
                adapterConfig: { ...args[1].agent.adapterConfig, env: { CONTEXT_NOTE: { type: "plain", value: "current" } } },
              } : { updatedAt: new Date() }).where(eq(agents.id, f.agentId));
              else if (target === "issue") await tx.update(issues).set(changed ? {
                assigneeAdapterOverrides: { adapterConfig: { env: { CONTEXT_NOTE: { type: "plain", value: "current" } } } },
              } : { updatedAt: new Date() }).where(eq(issues.id, f.issueId));
              else await tx.update(routines).set(changed ? { env: { CONTEXT_NOTE: "current" } }
                : { updatedAt: new Date() }).where(eq(routines.id, routine!.id));
              written = true; await gate;
            });
            await vi.waitFor(() => expect(written).toBe(true), { timeout: 10_000 });
            return assertCurrent(transaction, ownershipIssueId, lockIssue);
          };
        }
        return result;
      });
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike ${`%"${{ environment: "environments", project: "projects", agent: "agents", issue: "issues", routine: "routines" }[target]}"%`} and query ilike '%for share%'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 15_000 });
      expect(captured.has(starting!.id)).toBe(false);
      commit!(); await writer; await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(starting!.id);
      expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
      expect(preparations).toBe(changed ? 2 : 1);
      if (changed) expect(finished?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
      else expect(finished?.resultJson?.configurationSupersession).toBeUndefined();
      expect(dispatchCounts.get(starting!.id)).toBe(1);
      const env = captured.get(starting!.id)!.config.env as Record<string, unknown>;
      expect(env[target === "environment" ? "ENV_NOTE" : target === "project" ? "PROJECT_NOTE" : "CONTEXT_NOTE"]).toBe(changed ? "current" : "old");
    } finally {
      commit?.(); await writer?.catch(() => {}); await heartbeat.drainActiveRunExecutions(); pause?.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars, metadata: environment.metadata }).where(eq(environments.id, environment.id));
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preparation content fence: concurrent dispatch transactions on one issue wait without a lock-upgrade deadlock", async () => {
    const f = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const snapshot = await readExecutionConfigurationRows(db, {
      companyId: f.companyId, environmentId: null, projectId: null,
      plainSources: { agentId: f.agentId, agentEnv: null, agentDefaultEnvironmentId: null, issue, liveRoutine: null },
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstPid = 0, secondPid = 0;
    const ownershipOrder: number[] = [];
    const dispatch = (index: number) => db.transaction(async tx => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      if (index === 1) firstPid = Number(backend.pid); else secondPid = Number(backend.pid);
      await assertExecutionConfigurationCurrent(tx as unknown as typeof db, snapshot, [], 0, f.issueId, async () => {
        await tx.select({ id: issues.id }).from(issues)
          .where(and(eq(issues.id, f.issueId), eq(issues.companyId, f.companyId))).for("update");
      });
      if (index === 1) await gate;
      ownershipOrder.push(index);
    });
    const first = dispatch(1);
    let second: Promise<void> | undefined;
    // Observe rejections immediately, but retain the original promises below.
    void first.catch(() => {});
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where pid = ${firstPid}
          and state = 'idle in transaction' and query ilike '%"agents"%';`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 10_000 });
      second = dispatch(2);
      void second.catch(() => {});
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where pid = ${secondPid}
          and wait_event_type = 'Lock' and ${firstPid} = any(pg_blocking_pids(pid))
          and query ilike '%"issues"%for%';`);
        expect(waiting).toHaveLength(1);
      }, { timeout: 10_000 });
      expect(ownershipOrder).toEqual([]);
      releaseFirst();
      // No retry or swallowed error: a PostgreSQL 40P01 fails this assertion.
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(ownershipOrder).toEqual([1, 2]);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it.each(["image", "futureDriverInput"])("preparation config content: kept %s changes supersede", async key => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "preparing-config-content-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      let preparations = 0;
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        if (++preparations === 1) await db.update(environments).set({ config: { ...environment.config, [key]: "current" } }).where(eq(environments.id, environment.id));
        return result;
      });
      const next = await execute(f);
      expect(preparations).toBe(2);
      expect(next.finished.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
      expect(dispatchCounts.get(next.finished.id)).toBe(1);
    } finally {
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore();
      await db.update(environments).set({ config: environment.config }).where(eq(environments.id, environment.id));
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  // Pause the assembled heartbeat AFTER old-value resolution, before snapshot publication.
  // The adapter substitutes provider I/O only; admission, resolution, save and follow-up are real.
  it.each([
    { change: "plain", conversation: false, recovery: "none" }, { change: "rotation", conversation: false, recovery: "none" },
    { change: "plain", conversation: true, recovery: "none" }, { change: "rotation", conversation: true, recovery: "none" },
    { change: "open rotation", conversation: true, recovery: "none" },
    { change: "rotation", conversation: true, recovery: "reaper" },
    { change: "rotation", conversation: true, recovery: "restart" },
  ] as const)("preparation window: $change automatically supersedes the SAME wake (chat=$conversation, recovery=$recovery)", async ({ change, conversation, recovery }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "preparing-env-save-"));
    let mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let resume: (() => void) | undefined;
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    let providerGuard: ReturnType<typeof vi.spyOn> | undefined;
    let fencePause: ReturnType<typeof vi.spyOn> | undefined;
    let finishRotation: (() => void) | undefined;
    let rotation: Promise<unknown> | undefined;
    let requeuePause: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const secrets = secretService(db), previousValue = randomUUID(), currentValue = randomUUID();
      const secret = await secrets.create(f.companyId, { name: "Preparing revision", key: "PREPARING_REVISION", provider: "local_encrypted", value: previousValue });
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      if (conversation) await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", environmentRoutes(db)); app.use(errorHandler);
      const envVars = { CONTEXT_NOTE: "old", PREPARING_REVISION: { type: "secret_ref", secretId: secret.id, version: "latest" } };
      expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ envVars })).status).toBe(200);
      const first = await execute(f);
      // The stale attempt takes REAL native selection. Only the automatically
      // re-prepared attempt substitutes provider I/O via the fixture adapter.
      mode.mockRestore();
      const resolveMode = nativeRuntimeMode.resolveHeartbeatNativeRuntimeMode;
      mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockImplementationOnce(resolveMode).mockReturnValue({
        kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
      providerGuard = vi.spyOn(nativeExecutor, "executePaperclipNativeSession").mockImplementation(async () => {
        throw new Error("stale provider dispatch reached");
      });
      let didResolve = false;
      const gate = new Promise<void>(resolve => { resume = resolve; });
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementationOnce(async (...args) => {
        const result = await prepare(...args);
        expect(result.prepared).toBe(true);
        if (result.prepared) expect(result.configuredTaskEnvironment.PREPARING_REVISION === previousValue).toBe(true);
        didResolve = true; await gate; return result;
      });
      await db.update(issues).set({ status: "todo", ...(conversation ? { conversationState: "active" as const } : {}) }).where(eq(issues.id, f.issueId));
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: f.userId, authorType: "user", body: "Use the current configuration for this same message." }).returning();
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId, commentId: comment.id }, contextSnapshot: { issueId: f.issueId, queuedCommentIds: [comment.id] } });
      await vi.waitFor(() => expect(didResolve).toBe(true), { timeout: 10_000 });
      const [wakeBefore] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, starting!.wakeupRequestId!));
      const preparing = await heartbeat.getRun(starting!.id);
      expect(preparing?.status).toBe("running");
      expect(preparing?.contextSnapshot?.paperclipEnvironment).toBeUndefined();
      expect(preparing?.contextSnapshot?.paperclipSecretIdentity).toEqual({ responsibleUserId: f.userId });
      if (change === "plain") expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`)
        .send({ envVars: { ...envVars, CONTEXT_NOTE: "current" } })).status).toBe(200);
      else if (change === "rotation") await secrets.rotate(secret.id, { value: currentValue });
      else {
        let rotationAtFence = false;
        const holdRotation = new Promise<void>(resolve => { finishRotation = resolve; });
        const fence = heldConfiguration.requestHeldNativeConfigurationEndForTargets;
        fencePause = vi.spyOn(heldConfiguration, "requestHeldNativeConfigurationEndForTargets").mockImplementationOnce(async (...args) => {
          await fence(...args); rotationAtFence = true; await holdRotation;
        });
        rotation = secrets.rotate(secret.id, { value: currentValue });
        await vi.waitFor(() => expect(rotationAtFence).toBe(true), { timeout: 10_000 });
        resume!();
        // Deterministic PG schedule: the rotation already scanned consumers
        // while the run was legacy, but has NOT committed. The dispatch query
        // must be waiting on that transaction, not launching the old secret.
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query ilike '%company_secrets%' and query ilike '%for share%'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 15_000 });
        expect(providerGuard).not.toHaveBeenCalled();
        expect(captured.has(starting!.id)).toBe(false);
        finishRotation!(); await rotation;
      }
      if (recovery !== "none") requeuePause = vi.spyOn(configurationSupersession, "requeueConfigurationSupersession").mockResolvedValueOnce(false);
      resume!(); await heartbeat.drainActiveRunExecutions();
      if (recovery !== "none") {
        const pending = await heartbeat.getRun(starting!.id);
        expect(pending?.status).toBe("scheduled_retry");
        expect(pending?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1, state: "cleanup_pending" });
        expect(captured.has(starting!.id)).toBe(false);
        expect(await db.execute(sql`select run_id from native_run_finalizations where run_id = ${starting!.id}`)).toHaveLength(0);
        requeuePause!.mockRestore();
        await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, starting!.id));
        if (recovery === "restart") {
          // The exact recorded controller really exits in this PID space.
          // No fake liveness verdict and no elapsed-lease ownership guess.
          const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
          const pid = child.pid!;
          await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("controller fixture failed"))); });
          const oldBoot = randomUUID(), controller = { ...await currentControllerProcess(), bootId: oldBoot, pid, processStartedAt: null };
          await db.update(heartbeatRuns).set({ resultJson: { ...pending!.resultJson,
            configurationSupersession: { ...(pending!.resultJson!.configurationSupersession as object), controllerBootId: oldBoot, controllerProcess: controller } } }).where(eq(heartbeatRuns.id, starting!.id));
          await heartbeat.recoverNativeRunsAfterRestart(new Date(), [starting!.id], { skipDelegatedWork: true });
        } else await heartbeat.promoteDueScheduledRetries();
        await heartbeat.drainActiveRunExecutions();
      }
      const finished = await heartbeat.getRun(starting!.id);
      expect(providerGuard).not.toHaveBeenCalled();
      expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
      expect(finished?.resultJson?.configurationSupersession).toMatchObject({ attempt: 1 });
      expect(dispatchCounts.get(starting!.id), "exactly one paid/provider dispatch for this wake").toBe(1);
      const reservations = await db.execute(sql`select id from budget_reservations where run_id = ${starting!.id}`);
      expect(reservations).toHaveLength(1);
      expect(finished?.resultJson?.configurationSupersession).toMatchObject({ reservationId: reservations[0].id });
      expect(finished?.sessionIdBefore).toBe(first.finished.sessionIdAfter);
      const next = captured.get(starting!.id)!;
      expect(next.runtime.sessionId).toBe("saved-session");
      expect((next.config.env as Record<string, unknown>).CONTEXT_NOTE).toBe(change === "plain" ? "current" : "old");
      expect((next.config.env as Record<string, unknown>).PREPARING_REVISION === (change !== "plain" ? currentValue : previousValue)).toBe(true);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, starting!.wakeupRequestId!));
      expect(runs.map(row => row.id)).toEqual([starting!.id]);
      const [wakeAfter] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, starting!.wakeupRequestId!));
      expect(wakeAfter.runId).toBe(starting!.id);
      expect(wakeAfter.payload).toEqual(wakeBefore.payload);
      expect(wakeAfter.claimedAt).toEqual(wakeBefore.claimedAt);
      expect(finished?.contextSnapshot?.queuedCommentIds).toEqual([comment.id]);
      expect(finished?.contextSnapshot?.firstTurnQueuedInput).toBeUndefined();
      const [reads] = await db.execute(sql`select count(*)::int as n from secret_access_events
        where heartbeat_run_id = ${starting!.id} and secret_id = ${secret.id} and outcome = 'success'`);
      expect(reads.n, "one provider resolve per preparation, never a freshness re-resolve").toBe(2);
      expect(await db.execute(sql`select status from configuration_status_probe where issue_id = ${f.issueId} and status = 'blocked'`)).toHaveLength(0);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.some(row => row.body.includes("a secret it needs is not set"))).toBe(false);
      expect(comments.find(row => row.id === comment.id)).toEqual(comment);
    } finally {
      finishRotation?.(); resume?.(); await rotation?.catch(() => {}); await heartbeat.drainActiveRunExecutions();
      fencePause?.mockRestore(); pause?.mockRestore(); providerGuard?.mockRestore(); requeuePause?.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
      await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["missing", "revoked"] as const)("pre-launch genuine %s secret remains a configuration blocker", async failure => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "configuration-blocker-"));
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let preparation: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const secrets = secretService(db);
      const secret = await secrets.create(f.companyId, { name: "Required fixture", key: "REQUIRED_FIXTURE", provider: "local_encrypted", value: randomUUID() });
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", environmentRoutes(db)); app.use(errorHandler);
      expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`)
        .send({ envVars: { REQUIRED_FIXTURE: { type: "secret_ref", secretId: secret.id, version: "latest" } } })).status).toBe(200);
      if (failure === "missing") await db.delete(companySecretBindings).where(eq(companySecretBindings.secretId, secret.id));
      else {
        const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
        preparation = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementationOnce(async (...args) => {
          const result = await prepare(...args);
          await secrets.update(secret.id, { status: "disabled" });
          return result;
        });
      }
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(starting!.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
        configurationIncomplete: { reason: failure === "missing" ? "secret_binding_missing" : "secret_inactive" },
      } });
      expect(captured.has(starting!.id)).toBe(false);
      expect(finished?.resultJson?.configurationSupersession).toBeUndefined();
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.status).toBe("blocked");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.some(row => row.body.includes(failure === "missing" ? "a secret it needs is not set" : "removed or revoked"))).toBe(true);
    } finally {
      await heartbeat.drainActiveRunExecutions(); preparation?.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
      await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preparation churn is bounded to three SAME-wake supersessions and reports the true blocker", async () => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "configuration-churn-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let preparation: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", environmentRoutes(db)); app.use(errorHandler);
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      let revisions = 0;
      preparation = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementation(async (...args) => {
        const result = await prepare(...args);
        expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`)
          .send({ envVars: { REVISION: String(++revisions) } })).status).toBe(200);
        return result;
      });
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const finished = await heartbeat.getRun(starting!.id);
      expect(finished).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
        configurationIncomplete: { reason: "configuration_churn", supersessions: 3 }, configurationSupersession: { attempt: 3 },
      } });
      expect(revisions).toBe(4);
      expect(captured.has(starting!.id)).toBe(false);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, starting!.wakeupRequestId!))).toHaveLength(1);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.status).toBe("blocked");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.some(row => row.body.includes("three automatic retries"))).toBe(true);
      expect(comments.some(row => row.body.includes("a secret it needs is not set"))).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions(); preparation?.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["ownership moved", "coordinator exists", "cleanup fails", "person owns"] as const)("steer recovery: %s stops after three failures with a named owner", async cause => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", nativeIssueId: f.issueId,
      controllerBootId: currentControllerBootId(), contextSnapshot: { issueId: f.issueId }, responsibleUserId: f.userId }).returning();
    await db.update(issues).set({ executionRunId: run.id, ...(cause === "person owns" ? { assigneeAgentId: null, assigneeUserId: f.userId } : {}) }).where(eq(issues.id, f.issueId));
    expect(await configurationSupersession.parkConfigurationSupersession(db, run)).toBe(true);
    let successor: string | null = null;
    if (cause === "ownership moved") {
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { issueId: f.issueId } }).returning();
      successor = next.id;
      await db.update(issues).set({ executionRunId: successor }).where(eq(issues.id, f.issueId));
    } else if (cause === "coordinator exists") await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId: run.id, phase: "observed" });
    let resumed = 0, terminal = 0;
    const recover = () => configurationSupersession.recoverConfigurationSupersessions(db, {
      runIds: [run.id], isExecuting: () => false,
      cleanup: async () => { if (cause === "cleanup fails" || cause === "person owns") throw new Error("private fixture diagnostic"); },
      resume: async () => { resumed++; }, terminal: async () => { terminal++; },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
      await recover();
      const current = await heartbeat.getRun(run.id);
      expect(current?.resultJson?.configurationSupersession).toMatchObject({ recoveryAttempts: attempt });
      expect(current?.status).toBe(attempt === 3 ? "failed" : "scheduled_retry");
    }
    await recover();
    const final = await heartbeat.getRun(run.id);
    expect(final).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", scheduledRetryAt: null, scheduledRetryReason: null,
      resultJson: { configurationIncomplete: { reason: "configuration_recovery_stalled" }, configurationSupersession: { state: "recovery_exhausted", recoveryAttempts: 3 } } });
    expect(resumed).toBe(0); expect(terminal).toBe(1); expect(captured.has(run.id)).toBe(false);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("Owner: Session owner; Agent: Session reader.");
    expect(comments[0].body).not.toContain(f.userId);
    expect(comments[0].body).not.toContain(f.agentId);
    expect(comments[0].body).toContain("three recovery attempts");
    expect(comments[0].body).not.toContain("private fixture diagnostic");
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue.executionRunId).toBe(successor);
    if (cause === "coordinator exists") expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id))).toHaveLength(1);
  });

  it("steer refused park has a truthful configuration outcome, never a promised retry", async () => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "configuration-refused-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    let pause: ReturnType<typeof vi.spyOn> | undefined;
    const refusal = vi.spyOn(configurationSupersession, "parkConfigurationSupersession").mockResolvedValueOnce(false);
    try {
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd } }).where(eq(agents.id, f.agentId));
      const prepare = executionConfiguration.prepareHeartbeatExecutionConfiguration;
      pause = vi.spyOn(executionConfiguration, "prepareHeartbeatExecutionConfiguration").mockImplementationOnce(async (...args) => {
        const result = await prepare(...args);
        await db.update(environments).set({ envVars: { REFUSED_NOTE: "changed" } }).where(eq(environments.id, environment.id));
        return result;
      });
      const starting = await heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "manual",
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId } });
      await heartbeat.drainActiveRunExecutions();
      const final = await heartbeat.getRun(starting!.id);
      expect(refusal).toHaveBeenCalledOnce();
      expect(final).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "configuration_supersession_refused" } } });
      expect(final?.error).not.toContain("preparing the same wake again");
      expect(captured.has(starting!.id)).toBe(false);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
      expect(comments.some(comment => comment.body.includes("no longer permits an automatic restart"))).toBe(true);
    } finally {
      await heartbeat.drainActiveRunExecutions(); pause?.mockRestore(); refusal.mockRestore();
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(["probe proof", "archive", "reactivate", "adopt"] as const)("steer real environment writer: %s preserves configuration freshness", async change => {
    const f = await seed(), service = environmentService(db);
    if (change === "adopt") {
      const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const cloudMode = vi.spyOn(cloudInstance, "isCloudManagedInstance").mockReturnValue(true);
      try {
        await db.update(environments).set({ metadata: { owner: "operator" } }).where(eq(environments.id, local.id));
        const snapshot = await readExecutionConfigurationRows(db, { companyId: f.companyId, environmentId: local.id, projectId: null });
        expect((await service.ensureLocalEnvironment(f.companyId)).metadata).toEqual({ owner: "operator", managedByPaperclip: true });
        await db.transaction(tx => assertExecutionConfigurationCurrent(tx as unknown as typeof db, snapshot, [], 0));
      } finally {
        cloudMode.mockRestore();
        await db.update(environments).set({ metadata: local.metadata }).where(eq(environments.id, local.id));
      }
      return;
    }
    const provider = `fixture-${randomUUID()}`;
    const input = { companyId: f.companyId, name: `Managed ${provider}`, provider, config: {} };
    const created = (await service.ensureManagedSandboxEnvironment(input)).environment;
    try {
      if (change === "reactivate") expect((await service.archiveManagedSandboxEnvironment({ companyId: f.companyId, provider }))?.id).toBe(created.id);
      const snapshot = await readExecutionConfigurationRows(db, { companyId: f.companyId, environmentId: created.id, projectId: null });
      if (change === "probe proof") expect(await service.recordSandboxPlatformProbe({ environmentId: created.id, companyId: f.companyId, config: created.config, proof: { v: 2, testedAt: new Date().toISOString() } })).toBe(true);
      else if (change === "archive") expect((await service.archiveManagedSandboxEnvironment({ companyId: f.companyId, provider }))?.id).toBe(created.id);
      else expect((await service.ensureManagedSandboxEnvironment(input)).environment.id).toBe(created.id);
      await db.transaction(tx => assertExecutionConfigurationCurrent(tx as unknown as typeof db, snapshot, [], 0));
    } finally {
      await db.delete(builtInManagedResources).where(eq(builtInManagedResources.resourceId, created.id));
      await db.delete(environments).where(eq(environments.id, created.id));
    }
  });

  // Real PATCH/reminted bindings and real secret resolution; only provider dispatch is substituted.
  it.each([
    { change: "plain", conversation: false }, { change: "rotation", conversation: false },
    { change: "plain", conversation: true }, { change: "rotation", conversation: true },
  ])("environment route: $change keeps the continuous Pi session and delivers current values (chat=$conversation)", async ({ change, conversation }) => {
    const f = await seed(), cwd = await mkdtemp(join(tmpdir(), "pi-env-route-"));
    const mode = vi.spyOn(nativeRuntimeMode, "resolveHeartbeatNativeRuntimeMode").mockReturnValue({
      kind: "legacy", reason: "persisted_legacy_selection", resolverVersion: nativeRuntimeMode.NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION });
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = join(cwd, "master.key");
    registerServerAdapter({ ...getServerAdapter(adapterType), type: "paperclip_runner" });
    const [environment] = await db.select().from(environments).where(eq(environments.driver, "local"));
    try {
      const secrets = secretService(db), previousValue = randomUUID(), currentValue = randomUUID(), plainValue = randomUUID();
      const secret = await secrets.create(f.companyId, { name: "Environment revision", key: "ENV_REVISION", provider: "local_encrypted", value: previousValue });
      await db.update(agents).set({ adapterType: "paperclip_runner", defaultEnvironmentId: environment.id,
        adapterConfig: { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous", cwd },
      }).where(eq(agents.id, f.agentId));
      if (conversation) await db.update(issues).set({ conversationAgentId: f.agentId, conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: f.userId }; next(); });
      app.use("/api", environmentRoutes(db)); app.use(errorHandler);
      const envVars = { CONTEXT_NOTE: { type: "plain", value: "original" },
        ENV_REVISION: { type: "secret_ref", secretId: secret.id, version: "latest" } };
      expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`).send({ envVars })).status).toBe(200);
      const first = await execute(f);
      expect((first.input.config.env as Record<string, unknown>).ENV_REVISION === previousValue).toBe(true);
      const [binding] = await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, f.companyId), eq(companySecretBindings.targetId, environment.id)));
      if (change === "plain") {
        expect((await request(app).patch(`/api/environments/${environment.id}?companyId=${f.companyId}`)
          .send({ envVars: { ...envVars, NEXT_NOTE: { type: "plain", value: plainValue } } })).status).toBe(200);
        const [reminted] = await db.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, f.companyId), eq(companySecretBindings.targetId, environment.id)));
        expect(reminted.id).not.toBe(binding.id);
      } else {
        await secrets.rotate(secret.id, { value: currentValue });
        expect((await secrets.getById(secret.id))?.latestVersion).toBe(2);
      }
      const next = await execute(f);
      expect(next.input.runtime.sessionId).toBe("saved-session");
      expect(next.finished.sessionIdBefore).toBe(first.finished.sessionIdAfter);
      expect(next.finished.resultJson).toMatchObject({ configFreshness: { session: {
        reset: false, taskSessionAvailable: true, taskSessionReused: true,
        changedCategories: expect.arrayContaining(["envBindings", "secrets"]),
      } } });
      const delivered = next.input.config.env as Record<string, unknown>;
      if (change === "plain") expect(delivered.NEXT_NOTE === plainValue).toBe(true);
      // Boolean-only assertions deliberately cannot dump secret bytes on failure.
      expect(delivered.ENV_REVISION === (change === "rotation" ? currentValue : previousValue), "matches current revision").toBe(true);
      if (change === "rotation") expect(delivered.ENV_REVISION === previousValue, "matches previous revision").toBe(false);
    } finally {
      await db.update(environments).set({ envVars: environment.envVars }).where(eq(environments.id, environment.id));
      await db.delete(companySecretBindings).where(eq(companySecretBindings.companyId, f.companyId));
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE; else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKey;
      mode.mockRestore(); unregisterServerAdapter("paperclip_runner"); await rm(cwd, { recursive: true, force: true });
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
    { category: "secrets", retain: true },
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
