import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeRuntimeContext } from "../native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { prepareHeartbeatSession } from "./session-preparation.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";
import { buildEffectiveRunSessionConfigMetadata, attachPaperclipSessionMetadataToSessionParams } from "./workspaces.js";
import { getAdapterSessionCodec } from "./run-state.js";

vi.mock("../native-runtime/runtime-context.js", async original => ({
  ...await original<typeof import("../native-runtime/runtime-context.js")>(),
  buildNativeRuntimeContext: vi.fn(async () => nativeRuntimeContextFixture()),
}));
vi.mock("../native-runtime/native-workspace-sync.js", async original => ({
  ...await original<typeof import("../native-runtime/native-workspace-sync.js")>(),
  prepareNativeWorkspaceSync: vi.fn(async () => null),
}));

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RUNTIME_SELECTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();

it.skipIf(!support.supported)("Judge strengthened M1.4a control: resume-eligible before edit, edited instructions reset a warm task session and the fresh run reads task history", async () => {
  if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
  const database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
    : await startEmbeddedPostgresTestDatabase("paperclip-tl07-m14a-control");
  const db: Db = createDb(database.connectionString);
  const root = await mkdtemp(join(tmpdir(), "paperclip-tl07-m14a-"));
  const instructionRoot = join(root, "instructions");
  await mkdir(instructionRoot, { recursive: true });
  try {
    await db.execute(sql`truncate table companies restart identity cascade`);
    const [company] = await db.insert(companies).values({ name: "TL07 M1.4a control", issuePrefix: "TL7" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "TL07 control agent", status: "running",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "TL07 control task", status: "todo",
      description: "Continue from saved history", assigneeAgentId: agent.id }).returning();
    const [history] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorType: "user", authorUserId: "local-board", body: "History token: TL07-M14A-ORCHID.",
      createdAt: new Date(Date.now() - 20_000) }).returning();

    const oldSessionId = randomUUID();
    const runtimeConfig = { ...(agent.adapterConfig as Record<string, unknown>),
      instructionsRootPath: instructionRoot, instructionsEntryFile: "AGENTS.md" };
    await writeFile(join(instructionRoot, "AGENTS.md"), "M1.4a old managed instructions.\n");
    const oldMetadata = await buildEffectiveRunSessionConfigMetadata({
      adapterType: agent.adapterType, effectiveAdapterConfig: runtimeConfig, managedInstructions: null,
      agentRuntimeConfig: agent.runtimeConfig, issueOverrides: null,
      workspaceConfig: { requestedMode: "shared_workspace", effectiveMode: "shared_workspace", projectPolicy: null, issueSettings: null },
      environment: { selectionSource: "default", selectedEnvironmentId: null, selectedEnvironment: null, executionPolicy: null },
      environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    });
    const [priorRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, status: "succeeded", nativeSessionId: oldSessionId,
      createdAt: new Date(Date.now() - 15000), finishedAt: new Date(Date.now() - 10000) }).returning();
    const [taskSession] = await db.insert((await import("@paperclipai/db")).agentTaskSessions).values({
      companyId: company.id, agentId: agent.id, adapterType: "paperclip_runner", taskKey: issue.id, lastRunId: priorRun.id,
      sessionParamsJson: attachPaperclipSessionMetadataToSessionParams({ sessionId: oldSessionId }, "gpt-5.6-luna", oldMetadata),
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, status: "running", createdAt: new Date() }).returning();
    const prepare = () => prepareHeartbeatSession(db, {
      run, agent,
      task: { context: {}, issueRef: issue, issueContext: null, taskProjectContext: null, workspaceProjectContext: null,
        wakeCommentId: null, acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
      session: { taskSession, taskSessionDecodedParams: taskSession.sessionParamsJson,
        explicitResumeSessionParams: null, explicitResumeSessionDisplayId: null,
        sessionCodec: getAdapterSessionCodec(agent.adapterType) },
      config: { runtimeConfig, agentIdentity: undefined, issueAssigneeOverrides: null, originalAiIssueOverrides: null,
        managedAiRuntime: undefined, aiBinding: undefined, requestedAiBinding: undefined, secretManifest: [],
        runtimeSkillEntries: [], routineEnvContext: { env: null } },
      workspace: { requestedExecutionWorkspaceMode: "shared_workspace", effectiveExecutionWorkspaceMode: "shared_workspace",
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, executionPolicy: null,
        requestedReusableExecutionWorkspaceConfig: null, reusableExistingExecutionWorkspace: null },
      environment: { environmentResolution: { source: "default" } as never, selectedEnvironmentId: null,
        selectedEnvironmentForConfig: null },
      getLatestAgentConfigRevision: async () => null as never,
    });
    const unchanged = await prepare();
    expect(unchanged.sessionConfigFreshness.reset).toBe(false);
    expect(unchanged.taskSessionForRun?.id).toBe(taskSession.id);
    expect(unchanged.taskResumeSessionId).toBe(oldSessionId);
    await writeFile(join(instructionRoot, "AGENTS.md"), "M1.4a edited instructions.\n");
    const session = await prepare();
    expect(session.sessionConfigFreshness.reset).toBe(true);
    expect(session.sessionConfigFreshness.changedCategories).toEqual(["instructions"]);
    expect(session.taskSessionForRun).toBeNull();
    expect(session.taskResumeSessionId).toBeNull();

    const now = new Date();
    const runtimeInput: HeartbeatRuntimeSelectionInput = {
      run, agent,
      nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig,
        adapterConfig: runtimeConfig, agent, issue, target: null, workspaceId: null }),
      task: { issueRef: issue, issueContext: null, context: { paperclipTaskMarkdown: issue.title },
        executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null,
        acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskResumeSessionId: session.taskResumeSessionId,
        isFailedChatRunRetry: false, getFreshSessionHandoff: createNativeSessionHandoffLoader({ db,
          companyId: company.id, agentId: agent.id, issueId: issue.id, before: run.createdAt }) },
      workspace: { persistedExecutionWorkspace: null,
        executionWorkspace: { cwd: instructionRoot, repoUrl: null, repoRef: null, branchName: null },
        executionTarget: null, isDotRun: false, projectRepositoryPaths: [],
        activeEnvironmentLease: { lease: { id: randomUUID(), companyId: company.id, environmentId: null,
          executionWorkspaceId: null, issueId: issue.id, heartbeatRunId: run.id, status: "active",
          leasePolicy: "ephemeral", provider: null, providerLeaseId: null, acquiredAt: now, lastUsedAt: now,
          expiresAt: null, releasedAt: null, failureReason: null, cleanupStatus: null, metadata: null,
          createdAt: now, updatedAt: now } } },
      config: { runtimeConfig, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
        agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
      recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null },
      issuesSvc: { addComment: vi.fn() }, runtimeEnv: {}, onAdapterEvent: vi.fn(async () => {}),
      onNativeLifecycleSelected: vi.fn(), onProviderResourceDisposition: vi.fn(), onNativeOwnershipHeld: vi.fn(),
      stopControllerLease: vi.fn(),
    };
    vi.mocked(buildNativeRuntimeContext).mockImplementation(async () => {
      const context = nativeRuntimeContextFixture();
      context.instructions.bundle.rootPath = instructionRoot;
      return { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) };
    });
    vi.mocked(prepareNativeWorkspaceSync).mockResolvedValue(null);
    const selected = await selectHeartbeatRuntime(db, runtimeInput);
    if (!selected.selected || !selected.nativeExecution || !selected.getNativeFreshSessionHandoff)
      throw new Error("M1.4a should select a new native session with task-history handoff");
    expect(selected.nativeExecution.session.normalizedSessionId).not.toBe(oldSessionId);
    expect(await selected.getNativeFreshSessionHandoff()).toContain("TL07-M14A-ORCHID");
    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persistedRun.nativeSessionId).toBe(selected.nativeExecution.session.normalizedSessionId);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, history.id)))[0].body).toContain("TL07-M14A-ORCHID");
  } finally {
    await db.$client.end();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
