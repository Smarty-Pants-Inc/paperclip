import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { canonicalNativeRuntimeContextDigest, createNativeSessionBackend } from "../../vendor/paperclip-runner/index.js";
import { buildNativeRuntimeContext } from "../native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { executePaperclipNativeSession } from "../native-runtime/native-session-executor.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals, setupRunnerPrpWebSocketServer } from "../../realtime/runner-prp-ws.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";
import { createRunnerdCodexTransport as createCapabilityRunnerdCodexTransport } from "@paperclipai/paperclip-runner";

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

it.skipIf(!support.supported)("TL07 open task: refreshed instructions and saved history reach the answering Runner session", async () => {
  if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
  const database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
    : await startEmbeddedPostgresTestDatabase("paperclip-tl07-open-task-refresh");
  const db: Db = createDb(database.connectionString);
  const root = await mkdtemp(join(tmpdir(), "paperclip-tl07-refresh-"));
  const instructionRoot = join(root, "instructions");
  const runnerRoot = join(root, "runner");
  const codexHome = join(root, "codex-home");
  const hostHome = join(root, "host-home");
  await mkdir(instructionRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(hostHome, { recursive: true });
  await writeFile(join(instructionRoot, "AGENTS.md"), "M14_OLD_SKILL_MARKER: use the prior instruction.\n");
  const runtimeApi = createServer();
  let runtimeApiListening = false;
  let first: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
  let next: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined;
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
    const environmentLeaseId = randomUUID();
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
        activeEnvironmentLease: { lease: { id: environmentLeaseId, companyId: company.id, environmentId: null,
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

    const resultPath = join(root, "provider-result.json");
    const requestLog = join(root, "provider-requests.jsonl");
    const callsLog = join(root, "provider-calls.log");
    const result = {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "TL07 answer: TL07-ORCHID",
      completionClaim: { contractRevision: selected.nativeExecution.completionContract.contract.revision,
        objectiveSatisfied: true,
        criteria: selected.nativeExecution.completionContract.contract.criteria.map(criterion => ({
          criterionId: criterion.id, status: "satisfied", evidenceRefs: [],
        })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [],
    };
    await writeFile(resultPath, JSON.stringify(result));
    const runnerRuntimeContext = "runtimeContext" in selected.nativeExecution
      ? selected.nativeExecution.runtimeContext : undefined;
    const runnerOptions = {
      provider: "codex" as const,
      runnerBinary: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/paperclip-runnerd"),
      codexCommand: resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server"),
      codexArgs: ["--state-file", join(runnerRoot, "fake-state.json"), "--durable-turn-ids",
        "--terminal-result-file", resultPath, "--request-log", requestLog, "--call-log", callsLog],
      sourceCodexHome: codexHome,
      environment: { CODEX_HOME: codexHome, HOME: hostHome, PATH: process.env.PATH ?? "" },
      runtimeContext: runnerRuntimeContext,
      runnerRuntimeContext,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    };
    registerLocalRuntimeApiServer(runtimeApi);
    const apiAddress = await new Promise<{ port: number }>((resolveAddress, reject) => {
      runtimeApi.once("error", reject);
      runtimeApi.listen(0, "127.0.0.1", () => {
        const address = runtimeApi.address();
        if (!address || typeof address === "string") return reject(new Error("TCP listener required"));
        runtimeApiListening = true;
        resolveAddress(address);
      });
    });
    setupRunnerPrpWebSocketServer(runtimeApi, { apiUrl: `http://127.0.0.1:${apiAddress.port}` });
    const priorAt = new Date(run.createdAt.getTime() - 10_000);
    const [priorRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      issueId: issue.id, nativeIssueId: issue.id, scopeKind: "issue", runtimeMode: "native", status: "succeeded",
      createdAt: priorAt, startedAt: priorAt, finishedAt: priorAt,
      nativeSessionId: selected.nativeExecution.session.normalizedSessionId, contextSnapshot: { issueId: issue.id } }).returning();
    const prpIdentity = { runnerInstanceId: selected.nativeRunnerInstanceId!, environmentLeaseId,
      runId: run.id, normalizedSessionId: selected.nativeExecution.session.normalizedSessionId!,
      turnId: randomUUID(), itemId: randomUUID() };
    const makeTransport = (stateDirectory: string) => createCapabilityRunnerdCodexTransport({ ...runnerOptions, stateDirectory,
      prpIdentity,
      controlPlaneRegistration: authority => registerRunnerPrpAuthority({ companyId: company.id, runId: run.id, authority }),
    });
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, issue.id));
    first = makeTransport(join(runnerRoot, "old"));
    const priorBackend = createNativeSessionBackend(selected.nativeExecution, {
      runnerInstanceId: selected.nativeRunnerInstanceId!, environment: runnerOptions.environment,
      codexTransportFactory: () => first!.transport,
    });
    const priorSession = await priorBackend.openSession({ identity: {
      runId: run.id, sessionId: selected.nativeExecution.session.normalizedSessionId!,
      companyId: company.id, issueId: issue.id, agentId: agent.id,
    }, workingDirectory: instructionRoot });
    await priorSession.goal?.({ action: "set", objective: "Keep this task open for a person follow-up",
      status: "active", requestId: randomUUID() });
    await first.transport.close();
    const oldStatePath = join(runnerRoot, "old/runner/codex-provider-state.json");
    const oldState = JSON.parse(await readFile(oldStatePath, "utf8"));
    oldState.runIdentity.runId = priorRun.id;
    oldState.goal = { objective: "Keep this task open for a person follow-up", status: "active", tokenBudget: null,
      tokensUsed: 0, elapsedSeconds: 0, iterations: 0, lastReason: null, createdAt: null, updatedAt: null,
      completedAt: null, workingNow: false };
    await writeFile(oldStatePath, JSON.stringify(oldState));
    await mkdir(join(runnerRoot, "next/runner"), { recursive: true });
    await copyFile(oldStatePath, join(runnerRoot, "next/runner/codex-provider-state.json"));
    // The Runner checkpoint records the old active goal for admission; opening
    // a fresh provider thread must not inherit that old thread-scoped goal.
    const fakeProviderStatePath = join(runnerRoot, "fake-state.json");
    const fakeProviderState = JSON.parse(await readFile(fakeProviderStatePath, "utf8"));
    fakeProviderState.goal = null;
    await writeFile(fakeProviderStatePath, JSON.stringify(fakeProviderState));
    await writeFile(join(instructionRoot, "AGENTS.md"), "M14_ONLY_NEW_SKILL_MARKER: apply the edited skill.\n");

    next = makeTransport(join(runnerRoot, "next"));
    const backend = createNativeSessionBackend(selected.nativeExecution, {
      runnerInstanceId: selected.nativeRunnerInstanceId!, environment: runnerOptions.environment,
      codexTransportFactory: () => next!.transport,
    });
    const answered = await executePaperclipNativeSession({ db, execution: selected.nativeExecution, backend,
      useRunnerd: true, runnerInstanceId: selected.nativeRunnerInstanceId!,
      getFreshSessionHandoff: selected.getNativeFreshSessionHandoff, turnTimeoutMs: 30_000 });
    expect(answered).toMatchObject({ exitCode: 0, timedOut: false });

    const [storedResult] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, run.id));
    expect(storedResult).toMatchObject({ schemaStatus: "accepted", resultJson: { result: { summary: result.summary } } });
    const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const threadStarts = requests.filter(request => request.method === "thread/start");
    const turnStart = requests.find(request => request.method === "turn/start");
    // The first provider thread used the old instruction; the replacement thread
    // gets the edited instruction before its answering turn receives task history.
    expect(threadStarts).toHaveLength(2);
    expect(JSON.stringify(threadStarts[0]?.params)).toContain("M14_OLD_SKILL_MARKER");
    expect(JSON.stringify(threadStarts[1]?.params)).toContain("M14_ONLY_NEW_SKILL_MARKER");
    expect(JSON.stringify(turnStart?.params)).toContain("TL07-ORCHID");
    expect(JSON.stringify(turnStart?.params)).toContain(followup.body);
    expect(JSON.stringify(turnStart?.params)).not.toContain("M14_OLD_SKILL_MARKER");
    const controlPlane = JSON.parse(await readFile(join(runnerRoot, "next/control-plane/control-plane-state.json"), "utf8"));
    const stateText = JSON.stringify(controlPlane);
    const closeAt = stateText.indexOf("session.closed");
    const freshStartAt = stateText.lastIndexOf("session.started");
    expect(closeAt).toBeGreaterThanOrEqual(0);
    expect(freshStartAt).toBeGreaterThan(closeAt);
    expect((await readFile(callsLog, "utf8")).split("\n").filter(line => line === "thread/start")).toHaveLength(2);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id))).filter(row => row.status === "failed")).toHaveLength(0);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "system")))).toHaveLength(0);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, followup.id)))[0].body).toBe(followup.body);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, prior.id)))[0].body).toContain("TL07-ORCHID");
  } finally {
    await next?.transport.close();
    await first?.transport.close();
    runnerPrpWebSocketInternals.resetForTests();
    if (runtimeApiListening) {
      runtimeApi.closeAllConnections();
      await new Promise<void>(resolveClose => runtimeApi.close(() => resolveClose()));
    }
    await db.$client.end();
    await database.cleanup();
    if (process.env.TL07_DEBUG_OUT) {
      await copyFile(join(root, "provider-requests.jsonl"), join(process.env.TL07_DEBUG_OUT, "server-tl07-debug-requests.jsonl")).catch(() => undefined);
      await copyFile(join(root, "provider-calls.log"), join(process.env.TL07_DEBUG_OUT, "server-tl07-debug-calls.log")).catch(() => undefined);
      await copyFile(join(runnerRoot, "next/control-plane/control-plane-state.json"), join(process.env.TL07_DEBUG_OUT, "server-tl07-debug-control.json")).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
