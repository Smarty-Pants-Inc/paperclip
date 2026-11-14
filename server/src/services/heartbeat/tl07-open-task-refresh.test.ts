import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { answerWithNativePeer } from "../../__tests__/helpers/native-answer-peer.js";
import { canonicalNativeRuntimeContextDigest } from "../../vendor/paperclip-runner/index.js";
import { buildNativeRuntimeContext } from "../native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";
import { createCapabilityRunnerdCodexTransport } from "../../../../packages/paperclip-runner/src/live/runnerd-codex-transport.js";

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

it.skipIf(!support.supported)("TL07 open task: idle instruction refresh answers from history only after closing the old runner session", async () => {
  if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
  const database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
    : await startEmbeddedPostgresTestDatabase("paperclip-tl07-open-task-refresh");
  const db: Db = createDb(database.connectionString);
  const root = await mkdtemp(join(tmpdir(), "paperclip-tl07-refresh-"));
  const instructionRoot = join(root, "instructions");
  await mkdir(instructionRoot, { recursive: true });
  await writeFile(join(instructionRoot, "AGENTS.md"), "Answer the assigned task from its history.\n");
  try {
    await db.execute(sql`truncate table companies restart identity cascade`);
    const [company] = await db.insert(companies).values({ name: "TL07 refresh", issuePrefix: "TL7" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "TL07 agent", status: "running",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "gpt-5.6-luna" } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Open task for TL07", status: "todo",
      description: "Keep the conversation available for a follow-up.", assigneeAgentId: agent.id }).returning();
    const [prior] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorType: "user", authorUserId: "local-board", body: "Remember the history token: TL07-ORCHID.",
      createdAt: new Date(Date.now() - 10_000) }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, scopeKind: "issue", status: "running" }).returning();
    const [followup] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id,
      authorType: "user", authorUserId: "local-board", body: "Use the saved token to answer this follow-up." }).returning();
    const now = new Date();
    const input: HeartbeatRuntimeSelectionInput = {
      run, agent,
      nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {},
        adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
      task: { issueRef: issue, issueContext: null,
        context: { paperclipTaskMarkdown: `${issue.title}\n${followup.body}` }, executionContinuation: null,
        safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: null, acceptedPlanContinuationWake: false },
      session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskResumeSessionId: null,
        isFailedChatRunRetry: false, getFreshSessionHandoff: createNativeSessionHandoffLoader({ db,
          companyId: company.id, agentId: agent.id, issueId: issue.id, before: run.createdAt }) },
      workspace: { persistedExecutionWorkspace: null,
        executionWorkspace: { cwd: instructionRoot, repoUrl: null, repoRef: null, branchName: null },
        executionTarget: null, isDotRun: false, projectRepositoryPaths: [],
        activeEnvironmentLease: { lease: { id: randomUUID(), companyId: company.id, environmentId: null,
          executionWorkspaceId: null, issueId: issue.id, heartbeatRunId: run.id, status: "active",
          leasePolicy: "ephemeral", provider: null, providerLeaseId: null, acquiredAt: now, lastUsedAt: now,
          expiresAt: null, releasedAt: null, failureReason: null, cleanupStatus: null, metadata: null,
          createdAt: now, updatedAt: now } },
      },
      config: { runtimeConfig: {}, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
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
    const selected = await selectHeartbeatRuntime(db, input);
    if (!selected.selected || !selected.nativeExecution || !selected.getNativeFreshSessionHandoff)
      throw new Error("expected real native selection and history handoff");
    selected.nativeExecution.workspace.cwd = instructionRoot;
    expect(issue.status).toBe("todo");

    // Real runner transport seam: a cold idle predecessor with an active task goal
    // must close successfully before a fresh instruction-bound session is admitted.
    const runnerRoot = join(root, "runner");
    const identity = { runnerInstanceId: "tl07-refresh-runner", environmentLeaseId: "tl07-refresh-lease",
      runId: "old-run", normalizedSessionId: "tl07-old-session", turnId: "old-turn", itemId: "old-item" };
    const runnerOptions = { provider: "codex" as const,
      runnerBinary: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/paperclip-runnerd"),
      codexCommand: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server"),
      codexArgs: ["--state-file", join(runnerRoot, "fake-state.json"), "--durable-turn-ids"],
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 } };
    const first = createCapabilityRunnerdCodexTransport({ ...runnerOptions, stateDirectory: join(runnerRoot, "old"), prpIdentity: identity });
    let next: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
    try {
      await first.transport.request("thread/start", { cwd: root, model: "gpt-test", baseInstructions: "Skill v1", dynamicTools: [] });
      await first.transport.close();
      const oldState = join(runnerRoot, "old/runner/codex-provider-state.json");
      const state = JSON.parse(await readFile(oldState, "utf8"));
      state.goal = { objective: "Keep this task open for a person follow-up", status: "active", tokenBudget: null,
        tokensUsed: 0, elapsedSeconds: 0, iterations: 0, lastReason: null, createdAt: null, updatedAt: null,
        completedAt: null, workingNow: false };
      await writeFile(oldState, JSON.stringify(state));
      const nextState = join(runnerRoot, "next/runner/codex-provider-state.json");
      await mkdir(join(runnerRoot, "next/runner"), { recursive: true });
      await copyFile(oldState, nextState);
      next = createCapabilityRunnerdCodexTransport({ ...runnerOptions, stateDirectory: join(runnerRoot, "next"),
        prpIdentity: { ...identity, runId: run.id, turnId: "followup-turn", itemId: followup.id } });
      const opened = await next.transport.request("thread/start", { cwd: root, model: "gpt-test",
        baseInstructions: "Skill v2", dynamicTools: [] });
      expect(opened).toHaveProperty("thread.id");
      const controlPlane = JSON.parse(await readFile(join(runnerRoot, "next/control-plane/control-plane-state.json"), "utf8"));
      const stateText = JSON.stringify(controlPlane);
      const closeAt = stateText.indexOf("session.closed");
      const startAt = stateText.indexOf("session.started");
      expect(closeAt).toBeGreaterThanOrEqual(0);
      expect(startAt).toBeGreaterThan(closeAt);
    } finally {
      await next?.transport.close();
      await first.transport.close();
    }

    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    const answered = await answerWithNativePeer({ db, execution: selected.nativeExecution,
      runnerInstanceId: selected.nativeRunnerInstanceId!, text: `Answered with ${prior.body}`,
      getFreshSessionHandoff: selected.getNativeFreshSessionHandoff });
    expect(answered.settled.status).toBe("succeeded");
    expect(answered.settled.errorCode).toBeNull();
    expect(JSON.stringify(answered.prompts)).toContain("TL07-ORCHID");
    expect(JSON.stringify(answered.prompts)).toContain(followup.body);
    const visible = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id));
    expect(visible.filter(row => row.status === "failed")).toHaveLength(0);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id),
      eq(issueComments.authorType, "system")))).toHaveLength(0);
  } finally {
    await db.$client.end();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
