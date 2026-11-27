import { NativeProviderStateIncompatibleError } from "../vendor/paperclip-runner/index.js";

import * as nativeRuntimeMode from "../services/native-runtime/runtime-mode.js";
import * as sessionFingerprintInputs from "../services/heartbeat/session-fingerprint-inputs.js";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, authUsers, companies, companyMemberships, createDb, executionWorkspaces, environments, heartbeatRuns, issueComments, issues, projects } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter, type AdapterExecutionContext } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { companySkillService } from "../services/company-skills.js";
import * as sessionMetadata from "../services/heartbeat/workspaces.js";
import { previousSessionMetadata } from "./helpers/previous-session-fingerprint.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget } from "../services/native-runtime/native-session-resume.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { requestTaskRetry } from "../services/task-retry.js";

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

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("heartbeat-session-preparation-");
    db = createDb(temporary.connectionString);
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
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(adapterType);
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Session fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Session owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Session reader", adapterType, status: "idle", adapterConfig: { model: "model-a" }, runtimeConfig });
    await db.insert(issues).values({ id: issueId, companyId, title: "Session fixture", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    return { companyId, agentId, issueId, userId };
  }

  async function execute(f: Awaited<ReturnType<typeof seed>>, context: Record<string, unknown> = {}) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const run = await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, ...context },
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then(rows => rows[0]);
    expect(finished?.status, finished?.error ?? undefined).toBe("succeeded");
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

});
