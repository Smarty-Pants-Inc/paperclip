// Install as server/src/__tests__/native-addressed-wake-staging.test.ts.
// Trust-boundary regression, NOT provider/Pi E2E. No handmade heartbeatRuns inserts.
// The HTTP route supplies the interaction wake unchanged to the REAL persisted queue.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { and, eq, notInArray } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, environmentLeases, heartbeatRuns, issues, issueThreadInteractions,
  principalPermissionGrants,
} from "@paperclipai/db";
import { PERMISSION_KEYS, type EnvironmentLease } from "@paperclipai/shared";
import { createApp } from "../app.js";
import { createWakeQueue } from "../modules/wake-queue/index.js";
import { budgetService } from "../services/budgets.js";
import { DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake,
  type HeartbeatQueueDependencies } from "../services/heartbeat/queue.js";
import { buildPaperclipWakePayload, mergeCoalescedContextSnapshot,
  type WakeupOptions } from "../services/heartbeat/run-preparation.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "../services/heartbeat/runtime-selection.js";
import { resolveHeartbeatNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { stageNativeRunnerWakeAttachments } from "../services/native-runtime/native-runner-file-handoff.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import type { StorageService } from "../storage/types.js";
import { getNativeAddressedInteractionGrant } from "../services/native-runtime/native-addressed-interaction.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const boundary = vi.hoisted(() => ({
  wakeup: undefined as undefined | ((agentId: string, options: WakeupOptions) => Promise<unknown>),
  pending: new Set<Promise<unknown>>(),
  failures: [] as unknown[],
  calls: [] as Array<{ agentId: string; options: WakeupOptions }>,
}));
// Scheduler boundary only: no manufactured wake/context/grant/run. All other
// heartbeat methods remain real; the route's exact options enter createHeartbeatQueue.
vi.mock("../services/heartbeat.js", async original => {
  const actual = await original<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
    const service = actual.heartbeatService(...args);
    return { ...service, wakeup: (agentId: string, options: WakeupOptions = {}) => {
      if (!boundary.wakeup) return Promise.reject(new Error("fixture_scheduler_not_installed"));
      boundary.calls.push({ agentId, options: structuredClone(options) });
      const promise = boundary.wakeup(agentId, options);
      boundary.pending.add(promise);
      void promise.catch(error => boundary.failures.push(error)).finally(() => boundary.pending.delete(promise));
      return promise;
    } };
  } };
});
// Environment and provider-discovery boundaries; no provider process or binary.
// Keep real runtime context, pending-card classifier, native bootstrap persistence,
// grant, staging, storage, HTTP auth, and every database transaction.
// Lifecycle controls call real ToolAuthority/HTTP, but still do not execute a
// provider, native terminal lifecycle, or full heartbeat body (explicit F3 gap).
vi.mock("../services/native-runtime/native-workspace-sync.js", async original => ({
  ...await original<typeof import("../services/native-runtime/native-workspace-sync.js")>(),
  prepareNativeWorkspaceSync: async () => null,
}));
vi.mock("../vendor/paperclip-runner/index.js", async original => ({
  ...await original<typeof import("../vendor/paperclip-runner/index.js")>(),
  describeRunnerdNativeSessionBackend: async () => ({ capabilities: { toolRefreshOnResume: false } }),
}));

async function fixture() {
  const temporary = createIsolatedTestHome();
  const env = {
    PAPERCLIP_HOME: temporary.home, PAPERCLIP_CONFIG: join(temporary.home, "config.json"),
    PAPERCLIP_INSTANCE_ID: `addressed-wake-${randomUUID()}`, PAPERCLIP_AGENT_JWT_SECRET: randomUUID(),
    PAPERCLIP_RUNNER_BINARY: join(temporary.home, "never-executed-runnerd"),
    PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true", PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "",
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: ReturnType<NonNullable<typeof app>["listen"]> | undefined;
  let queue: ReturnType<typeof createHeartbeatQueue> | undefined;
  let deps: HeartbeatQueueDependencies | undefined;
  const executions: Promise<void>[] = [];
  const dispatched: string[] = [];
  let execute: (id: string) => Promise<void> = async () => { throw new Error("unexpected_fixture_dispatch"); };
  let suppressed = true;
  const close = async () => {
    try {
      await Promise.allSettled([...boundary.pending, ...executions]);
      await Promise.allSettled([...(deps?.activeRunExecutionPromises ?? [])]);
      await app?.locals.paperclipShutdown?.();
      if (server) await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes()));
    } finally {
      boundary.wakeup = undefined;
      try { await db?.$client.end(); }
      finally {
        try { await database?.cleanup(); }
        finally {
          for (const key of Object.keys(env)) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
          }
          temporary.cleanup();
        }
      }
    }
  };
  try {
    // Do not accept an external/shared DB override, even if the parent has one.
    for (const key of ["PAPERCLIP_TEST_POSTGRES_ADMIN_URL", "PAPERCLIP_TEST_DATABASE_URL", "DATABASE_URL"]) {
      if (process.env[key]) throw new Error(`fixture_requires_owned_embedded_database: unset ${key}`);
    }
    database = await startEmbeddedPostgresTestDatabase("native-addressed-wake-");
    const nativeDb = db = createDb(database.connectionString);
    const companyId = randomUUID(), userId = randomUUID(), assigneeId = randomUUID(), responderId = randomUUID();
    process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;
    const boardKey = `pcp_board_${randomUUID()}`;
    const root = join(temporary.home, "workspace"), instructions = join(temporary.home, "instructions");
    await mkdir(root); await mkdir(instructions);
    await writeFile(join(instructions, "AGENTS.md"), "Respond only to the confirmation addressed to you. Do not take over the task.\n");
    const adapterConfig = { provider: "codex", model: "gpt-5.6-luna", instructionsFilePath: join(instructions, "AGENTS.md") };
    await db.insert(companies).values({ id: companyId, name: "Owned addressed wake regression", issuePrefix: "AWS",
      defaultResponsibleUserId: userId, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board creator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values([assigneeId, responderId].map(id => ({ id, companyId,
      name: id === assigneeId ? "Task owner" : "Card responder", status: "idle", adapterType: "paperclip_runner", adapterConfig,
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } }, permissions: {} })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[assigneeId, responderId].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values(PERMISSION_KEYS.map(permissionKey => ({ companyId, principalType: "user", principalId: userId, permissionKey })));
    await db.insert(boardApiKeys).values({ userId, name: "Owned fixture key", keyHash: createHash("sha256").update(boardKey).digest("hex") });
    const [issue] = await db.insert(issues).values({ companyId, title: "Task remains assigned to its owner", status: "in_progress",
      workMode: "standard", assigneeAgentId: assigneeId, responsibleUserId: userId }).returning();
    if (!issue) throw new Error("missing_fixture_issue");
    const diskStorage = createStorageService(createLocalDiskStorageProvider(join(temporary.home, "storage")));
    const storageReads: string[] = [];
    const storage: StorageService = { ...diskStorage, getObject: async (...args) => {
      const object = await diskStorage.getObject(...args);
      storageReads.push(args[1]);
      return object;
    } };
    const issueSvc = issueService(db);
    const scaffold = createHeartbeatQueueTestDependencies(db);
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: scaffold.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    // Replace scaffold eligibility/data stubs with real services. The remaining
    // observer/recovery callbacks are outside this bounded non-recovery journey.
    deps = { ...scaffold, issuesSvc: issueSvc, treeControlSvc: issueTreeControlService(db), budgets: budgetService(db),
      instanceSettings: instanceSettingsService(db), wakeQueue,
      getAgent: async id => (await nativeDb.select().from(agents).where(eq(agents.id, id)))[0] ?? null,
      getAgentInvokability: agent => evaluateAgentInvokabilityFromDb(nativeDb, agent),
      getSchedulingSuppression: async () => ({ suppressed, reason: suppressed ? "task_drain" : null }),
      setWakeupStatus: async (id, status, patch) => {
        if (id) await nativeDb.update(agentWakeupRequests).set({ ...patch, status }).where(eq(agentWakeupRequests.id, id));
      },
      executeRun: id => {
        dispatched.push(id);
        const promise = execute(id);
        executions.push(promise);
        return promise;
      },
      releaseIssueExecutionAndPromote: run => wakeQueue.releaseIssueExecution({ companyId: run.companyId, runId: run.id,
        now: new Date(), suppressImmediateRecovery: true }),
    };
    queue = createHeartbeatQueue(db, deps);
    boundary.calls = []; boundary.failures = []; boundary.pending.clear();
    boundary.wakeup = (id, options) => queue!.trackWakeup(id, options);
    app = await createApp(db, { uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true, companyDeletionEnabled: false,
      managedPluginAutoInstall: [], localPluginDir: join(temporary.home, "plugins"), storageService: storage,
      decisionServiceOptions: { wakeOriginAgent: async () => null } });
    await app.locals.bundledPluginsStartup;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((yes, no) => { server!.once("listening", yes); server!.once("error", no); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing_loopback_address");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`${apiUrl}/api/issues/${issue.id}${path}`, { method: "POST",
        headers: { authorization: `Bearer ${boardKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      return { status: response.status, data };
    };
    const drainWakes = async () => {
      await Promise.allSettled([...boundary.pending]);
      expect(boundary.failures, "RED step API -> persisted queue: route wake rejected").toEqual([]);
    };
    const createFile = async (filename: string, text: string) => {
      const bytes = Buffer.from(text);
      const stored = await storage.putFile({ companyId, namespace: `issues/${issue.id}`, originalFilename: filename, contentType: "text/plain", body: bytes });
      const comment = await issueSvc.addComment(issue.id, `Inspect ${filename} before deciding.`, { userId });
      const attachment = await issueSvc.createAttachment({ issueId: issue.id, issueCommentId: comment.id, provider: stored.provider,
        objectKey: stored.objectKey, contentType: stored.contentType, byteSize: stored.byteSize, sha256: stored.sha256,
        originalFilename: stored.originalFilename, createdByUserId: userId });
      return { bytes, comment, attachment };
    };
    const createCard = async (file: Awaited<ReturnType<typeof createFile>>, title: string) => {
      const response = await request("/interactions", { kind: "request_confirmation", title, resolverPolicy: "not_creator",
        addresseeAgentId: responderId, continuationPolicy: "none", sourceCommentId: file.comment.id,
        payload: { version: 1, prompt: title, rejectRequiresReason: true } });
      expect(response, "RED step authenticated API card creation").toMatchObject({ status: 201, data: {
        id: expect.any(String), status: "pending", createdByUserId: userId, createdByAgentId: null, sourceRunId: null,
        addresseeAgentId: responderId, sourceCommentId: file.comment.id, originCommentIds: [file.comment.id] } });
      await drainWakes();
      const cardId = response.data.id as string;
      const receipts = await nativeDb.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, `interaction-pending:${cardId}`)));
      expect(receipts, "RED step API -> persisted interaction_pending wake").toHaveLength(1);
      expect(receipts[0]).toMatchObject({ agentId: responderId, reason: "interaction_pending", runId: expect.any(String) });
      expect(receipts[0]!.payload).toMatchObject({ issueId: issue.id, interactionId: cardId, sourceCommentId: file.comment.id, sourceRunId: null });
      const [run] = await nativeDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipts[0]!.runId!));
      expect(run, "RED step real queue admission must create responder run").toMatchObject({ agentId: responderId, status: "queued",
        contextSnapshot: { issueId: issue.id, interactionId: cardId, sourceCommentId: file.comment.id, sourceRunId: null,
          wakeReason: "interaction_pending", source: "issue.interaction.created" } });
      const call = boundary.calls.find(call => call.options.idempotencyKey === receipts[0]!.idempotencyKey);
      if (!call || !run) throw new Error("missing_api_originated_wake_or_run");
      return { id: cardId, runId: run.id, receipt: receipts[0]!, call };
    };
    const readRun = async (id: string) => (await nativeDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const readTask = async () => (await nativeDb.select().from(issues).where(eq(issues.id, issue.id)))[0]!;
    const dispatch = async (handler: typeof execute) => {
      const before = executions.length;
      execute = handler; suppressed = false;
      try { await queue!.startNextQueuedRunForAgent(responderId); }
      finally { suppressed = true; }
      // Queue logs callback failures internally; re-await original promises so
      // a staging/bridge failure CANNOT be reported as a successful dispatch.
      await Promise.all(executions.slice(before));
    };
    const select = async (runId: string) => {
      const run = await readRun(runId);
      expect(run.status, "RED step queue -> executeRun callback").toBe("running");
      // The disclosed executeRun callback replaces heartbeat.ts's outer body.
      // Mirror its real execution_start conditional update before selection;
      // queue admission alone does not mark an idle agent running.
      const [responder] = await nativeDb.update(agents).set({ status: "running", updatedAt: new Date() })
        .where(and(eq(agents.id, responderId), notInArray(agents.status, [...DIRECT_NON_INVOKABLE_STATUSES]),
          eq(agents.lifecycleState, "ready"))).returning();
      if (!responder) throw new Error("fixture_execution_start_agent_not_invokable");
      const task = await readTask();
      const context = { ...run.contextSnapshot };
      const wake = await buildPaperclipWakePayload({ db: nativeDb, companyId, agentId: responderId, contextSnapshot: context });
      context.paperclipWake = wake;
      await nativeDb.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, run.id));
      const [lease] = await nativeDb.insert(environmentLeases).values({ companyId, issueId: issue.id, heartbeatRunId: runId,
        status: "active", leasePolicy: "ephemeral" }).returning();
      if (!lease) throw new Error("missing_environment_lease");
      const input: HeartbeatRuntimeSelectionInput = {
        run: await readRun(runId), agent: responder,
        nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig,
          agent: responder, issue: task, target: null, workspaceId: null }),
        task: { issueRef: task, issueContext: null, context, executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null,
          paperclipWakePayload: wake, acceptedPlanContinuationWake: false },
        session: { persistedNativeExecutionInput: null, persistedRunnerProfile: run.runnerProfileJson ?? {}, taskSessionCredentialCompatible: true,
          taskSessionDecodedParams: null, taskSessionForRun: null, isFailedChatRunRetry: false, getFreshSessionHandoff: undefined },
        workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
          executionTarget: null, activeEnvironmentLease: { lease: lease as EnvironmentLease }, isDotRun: false, projectRepositoryPaths: [] },
        config: { runtimeConfig: { homeMode: "preconfigured" }, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
          agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
        recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null }, issuesSvc: issueSvc, runtimeEnv: {},
        onAdapterEvent: async () => {}, onNativeLifecycleSelected: () => {}, onProviderResourceDisposition: () => {},
        onNativeOwnershipHeld: () => {}, stopControllerLease: () => {},
      };
      expect(input.nativeRuntimeResolution.kind, "RED step real native runtime resolution").toBe("native");
      const selected = await selectHeartbeatRuntime(nativeDb, input).catch(error => {
        const code = (error as { code?: string }).code ?? "no_code";
        throw new Error(`RED step real runtime selection/pending bridge: ${code}: ${(error as Error).message}`, { cause: error });
      });
      if (!selected.selected || !selected.nativeExecution) throw new Error("RED step real native selection did not select");
      expect(selected.nativeExecution.interactionResponses, "RED step pending bridge: API-created pending card must reach native input").toEqual([
        expect.objectContaining({ interactionId: context.interactionId, kind: "request_confirmation", response: expect.objectContaining({ status: "pending" }) }),
      ]);
      expect((await readRun(runId)).runnerProfileJson).toMatchObject({ nativeExecutionInput: {
        binding: { companyId, issueId: issue.id, agentId: responderId, runId },
        interactionResponses: [expect.objectContaining({ interactionId: context.interactionId })] } });
      return { context, selected };
    };
    const binding = (id: string, agentId = responderId) => ({ companyId, issueId: issue.id, agentId, runId: id, workspaceRoot: root, executionTargetKind: "local" as const });
    const workspaceFiles = async (directory = root): Promise<string[]> => {
      const entries = await readdir(directory, { withFileTypes: true });
      return (await Promise.all(entries.map(entry => entry.isDirectory() ? workspaceFiles(join(directory, entry.name))
        : entry.isFile() ? Promise.resolve([join(directory, entry.name)]) : Promise.resolve([])))).flat();
    };
    const assertOnlyFile = async (runId: string, owned: Awaited<ReturnType<typeof createFile>>, forbidden: Awaited<ReturnType<typeof createFile>>) => {
      const stage = await stageNativeRunnerWakeAttachments({ db: nativeDb, binding: binding(runId), storage });
      const paths: string[] = [];
      try {
        expect(stage.attachments, "RED step card-owned byte staging (F1)").toEqual([expect.objectContaining({ id: owned.attachment.id,
          workspaceRelativePath: expect.any(String), unavailableReason: null, byteSize: owned.bytes.length })]);
        for (const descriptor of stage.attachments) {
          if (!descriptor.workspaceRelativePath) throw new Error("selected_attachment_has_no_path");
          const path = resolve(root, descriptor.workspaceRelativePath);
          expect(relative(root, path).startsWith("..")).toBe(false);
          paths.push(path);
          expect(await readFile(path)).toEqual(owned.bytes);
        }
        // Check actual disk, not only descriptors/return values. A hidden staged
        // copy of the unrelated same-issue attachment is also a failure.
        const bodies = await Promise.all((await workspaceFiles()).map(path => readFile(path)));
        expect(bodies.some(body => body.includes(forbidden.bytes)), "F1 forbidden same-issue bytes must be absent on disk").toBe(false);
        expect(bodies.filter(body => body.equals(owned.bytes))).toHaveLength(1);
      } finally { await stage.cleanup(); }
      for (const path of paths) expect(await readFile(path)).toEqual(Buffer.alloc(0));
    };
    return { db: nativeDb, companyId, userId, assigneeId, responderId, issue, storage, storageReads, root, apiUrl, queue, deps,
      close, request, drainWakes, createFile, createCard, readRun, readTask, select, dispatch, dispatched, binding, assertOnlyFile, workspaceFiles };
  } catch (error) { await close(); throw error; }
}

it("API interaction_pending -> real queued responder -> native selection -> card-owned bytes only", async () => {
  const f = await fixture();
  try {
    const unrelated = await f.createFile("unrelated.txt", "UNRELATED_SAME_ISSUE_ATTACHMENT_BYTES\n");
    const owned = await f.createFile("bounded-plan.txt", "CARD_OWNED_PLAN_BYTES\n");
    const card = await f.createCard(owned, "Approve the bounded plan?");
    await f.dispatch(async runId => {
      expect(runId).toBe(card.runId);
      const { context } = await f.select(runId);
      // Read-only adversarial bridge call: this is NOT a claim that an agent
      // may mutate the server-owned wake or borrow another agent's run.
      await expect(materializeNativeInteractionResponses({ db: f.db, companyId: f.companyId, issueId: f.issue.id,
        agentId: f.assigneeId, runId, interactionIds: [card.id], wakeReason: "interaction_pending" }))
        .rejects.toMatchObject({ code: "native_interaction_unresolved" });
      expect((await f.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0])
        .toMatchObject({ status: "pending", addresseeAgentId: f.responderId, resolvedByRunId: null });
      // Natural API wake first: no manually selected attachment needed.
      await f.assertOnlyFile(runId, owned, unrelated);
      // F1 adversarial broad selection: preserve ALL actual API interaction
      // provenance; change only comment selection through the real builder.
      // This does NOT claim an ordinary user can rewrite server-owned wakes.
      const broad = { ...context, wakeCommentIds: [owned.comment.id, unrelated.comment.id] };
      const wake = await buildPaperclipWakePayload({ db: f.db, companyId: f.companyId, agentId: f.responderId, contextSnapshot: broad });
      expect(wake?.comments).toEqual(expect.arrayContaining([owned, unrelated].map(file => expect.objectContaining({ id: file.comment.id,
        attachments: [expect.objectContaining({ id: file.attachment.id })] }))));
      await f.db.update(heartbeatRuns).set({ contextSnapshot: { ...broad, paperclipWake: wake } }).where(eq(heartbeatRuns.id, runId));
      await f.assertOnlyFile(runId, owned, unrelated);
      await expect(stageNativeRunnerWakeAttachments({ db: f.db, binding: f.binding(runId, f.assigneeId), storage: f.storage }))
        .rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");
    });
    expect(f.dispatched, "queue must really enter executeRun once").toEqual([card.runId]);
    const runs = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs.map(run => run.id)).toEqual([card.runId]);
    expect(await f.readTask()).toMatchObject({ title: f.issue.title, status: f.issue.status, assigneeAgentId: f.assigneeId });
    // Intentionally no synthetic success/finalization writes. This proves the
    // admission-to-byte boundary, NOT automatic completion, retry, or full F3.
  } finally { await f.close(); }
}, 240_000);

// Separate from the original F1 journey so a duplicate-admission failure cannot
// prevent that existing byte-confinement regression from executing.
it("same-key actual API interaction_pending delivery produces one wake, run, dispatch and byte stage", async () => {
  const f = await fixture();
  try {
    const unrelated = await f.createFile("unrelated.txt", "UNRELATED_DUPLICATE_ATTACHMENT_BYTES\n");
    const owned = await f.createFile("bounded-plan.txt", "CARD_DUPLICATE_PLAN_BYTES\n");
    const card = await f.createCard(owned, "Approve the once-only bounded plan?");
    expect(card.call.options).toMatchObject({ reason: "interaction_pending", idempotencyKey: `interaction-pending:${card.id}` });
    const repeatWake = () => f.queue.trackWakeup(card.call.agentId, card.call.options);
    const assertOnePersistedWake = async () => {
      expect(await f.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId)), "retain exactly the original persisted wake and run")
        .toEqual([{ id: card.receipt.id, runId: card.runId }]);
      expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .toEqual([{ id: card.runId }]);
    };
    // Exact route options, including the same key, with no provenance edits.
    expect(await repeatWake()).toMatchObject({ id: card.runId });
    expect(await repeatWake()).toMatchObject({ id: card.runId });
    await assertOnePersistedWake();
    expect(f.dispatched).toEqual([]);
    expect(f.storageReads).toEqual([]);
    await f.dispatch(async runId => {
      expect(runId).toBe(card.runId);
      await f.select(runId);
      await f.assertOnlyFile(runId, owned, unrelated);
    });
    const readsAfterStaging = [...f.storageReads];
    expect(readsAfterStaging, "one actual storage object read and verified card-owned disk stage").toHaveLength(1);
    expect(await repeatWake()).toMatchObject({ id: card.runId });
    expect(await repeatWake()).toMatchObject({ id: card.runId });
    await f.dispatch(async () => { throw new Error("duplicate_interaction_pending_dispatched_again"); });
    await assertOnePersistedWake();
    expect(f.dispatched).toEqual([card.runId]);
    expect(f.storageReads, "duplicates must not produce another real storage/staging read").toEqual(readsAfterStaging);
    const bodies = await Promise.all((await f.workspaceFiles()).map(path => readFile(path)));
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every(body => body.length === 0), "duplicates must not restage cleaned bytes").toBe(true);
    expect(await f.readTask()).toMatchObject({ title: f.issue.title, status: f.issue.status, assigneeAgentId: f.assigneeId });
  } finally { await f.close(); }
}, 240_000);

// Counterexamples use the same authenticated producer and persisted queue, not
// hand-built responder runs: dedupe must be card-key scoped, never issue-wide.
it("a second pending card and an ordinary wake on the same issue remain admissible", async () => {
  const f = await fixture();
  try {
    const file = await f.createFile("two-cards.txt", "TWO_INDEPENDENT_CARD_REQUESTS\n");
    const first = await f.createCard(file, "Approve the first bounded request?");
    const second = await f.createCard(file, "Approve the second bounded request?");
    expect(second.id).not.toBe(first.id);
    expect(second.runId).not.toBe(first.runId);
    expect(second.receipt.id).not.toBe(first.receipt.id);
    expect(await f.queue.trackWakeup(first.call.agentId, first.call.options)).toMatchObject({ id: first.runId });
    expect(await f.queue.trackWakeup(second.call.agentId, second.call.options)).toMatchObject({ id: second.runId });
    const ordinaryKey = `ordinary-same-issue:${randomUUID()}`;
    const ordinary = await f.queue.trackWakeup(f.assigneeId, { source: "on_demand", triggerDetail: "manual",
      reason: "issue_assigned", requestedByActorType: "user", requestedByActorId: f.userId,
      idempotencyKey: ordinaryKey, payload: { issueId: f.issue.id },
      contextSnapshot: { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "issue_assigned" } });
    expect(ordinary).toMatchObject({ id: expect.any(String), agentId: f.assigneeId, status: "queued" });
    expect(ordinary!.id).not.toBe(first.runId);
    expect(ordinary!.id).not.toBe(second.runId);
    const receipts = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.receipt.id, idempotencyKey: `interaction-pending:${first.id}`, runId: first.runId }),
      expect.objectContaining({ id: second.receipt.id, idempotencyKey: `interaction-pending:${second.id}`, runId: second.runId }),
      expect.objectContaining({ idempotencyKey: ordinaryKey, runId: ordinary!.id, agentId: f.assigneeId }),
    ]));
    expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .toHaveLength(3);
    expect(f.dispatched).toEqual([]);
    expect(f.storageReads).toEqual([]);
    expect(await f.readTask()).toMatchObject({ status: f.issue.status, assigneeAgentId: f.assigneeId });
  } finally { await f.close(); }
}, 240_000);

it("a pending-card key cannot be rebound to another actual card", async () => {
  const f = await fixture();
  try {
    const file = await f.createFile("binding.txt", "CARD_KEY_BINDING\n");
    const first = await f.createCard(file, "Approve the bound first card?");
    const second = await f.createCard(file, "Approve the bound second card?");
    await expect(f.queue.trackWakeup(second.call.agentId, { ...second.call.options,
      idempotencyKey: first.call.options.idempotencyKey })).rejects.toMatchObject({
        details: { code: "interaction_pending_wakeup_binding_denied" },
      });
    expect(await f.db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(2);
    expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .toHaveLength(2);
    expect(f.dispatched).toEqual([]);
    expect(f.storageReads).toEqual([]);
  } finally { await f.close(); }
}, 240_000);

// Keep reason: current-card trust boundary and revocation/data confinement.
// These are owned local HTTP product mutations, never direct card/run inserts
// or synthetic terminal state. /withdraw is the confirmation cancellation API;
// /cancel currently accepts only ask_user_questions in the owning service.
it.each(["accept", "reject", "withdraw"] as const)("%s closes the real queued card's pending request and staging authority", async decision => {
  const f = await fixture();
  try {
    const unrelated = await f.createFile("unrelated.txt", "UNRELATED_LIFECYCLE_ATTACHMENT_BYTES\n");
    const owned = await f.createFile("bounded-plan.txt", "CARD_LIFECYCLE_PLAN_BYTES\n");
    const card = await f.createCard(owned, "Approve this bounded lifecycle control?");
    await f.dispatch(async runId => {
      expect(runId).toBe(card.runId);
      await f.select(runId);
      const binding = f.binding(runId);
      const pendingInput = { db: f.db, companyId: f.companyId, issueId: f.issue.id, agentId: f.responderId,
        runId, interactionIds: [card.id], wakeReason: "interaction_pending" };
      await expect(materializeNativeInteractionResponses(pendingInput)).resolves.toEqual([expect.objectContaining({
        interactionId: card.id, response: expect.objectContaining({ status: "pending" }),
      })]);
      expect(await getNativeAddressedInteractionGrant(f.db, binding)).toMatchObject({ interaction: { id: card.id, status: "pending" } });
      await f.assertOnlyFile(runId, owned, unrelated);
      const readsBeforeResolution = [...f.storageReads];
      expect(readsBeforeResolution).toHaveLength(1);
      const reason = "Close only this bounded card; task ownership is unchanged.";
      const status = decision === "withdraw" ? "cancelled" : decision === "accept" ? "accepted" : "rejected";
      if (decision === "withdraw") {
        expect(await f.request(`/interactions/${card.id}/withdraw`, { reason })).toMatchObject({ status: 200, data: {
          id: card.id, status, resolvedByUserId: f.userId, resolvedByAgentId: null, resolvedByRunId: null,
        } });
      } else {
        const authority = new PaperclipRunnerToolAuthority(f.db, { ...binding, apiUrl: f.apiUrl,
          apiToolsEnabled: true, storage: f.storage });
        try {
          expect(await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
            operationId: `POST /api/issues/{id}/interactions/{interactionId}/${decision}`,
            pathParams: { id: f.issue.id, interactionId: card.id }, body: { reason },
          } })).toMatchObject({ ok: true, status: 200, data: { id: card.id, status,
            resolvedByAgentId: f.responderId, resolvedByRunId: runId, resolvedByUserId: null } });
        } finally { authority.close(); }
      }
      await f.drainWakes();
      const [persisted] = await f.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      expect(persisted).toMatchObject({ id: card.id, status, resolvedAt: expect.any(Date),
        result: { outcome: decision === "withdraw" ? "withdrawn" : status } });
      // Always re-read the product grant. Never reuse the positive grant as
      // authority after the real HTTP resolution has changed the card.
      expect(await getNativeAddressedInteractionGrant(f.db, binding)).toBeNull();
      if (decision === "withdraw") {
        // Closed lifecycle context is allowed; a pending request is not.
        await expect(materializeNativeInteractionResponses(pendingInput)).resolves.toEqual([expect.objectContaining({
          interactionId: card.id, response: expect.objectContaining({ status: "cancelled" }),
        })]);
      } else {
        // A response-only run must not consume its own decision as a new
        // request/response. Assert the exact fail-closed bridge code.
        await expect(materializeNativeInteractionResponses(pendingInput)).rejects.toMatchObject({ code: "native_interaction_self_approval" });
      }
      await expect(stageNativeRunnerWakeAttachments({ db: f.db, binding, storage: f.storage }))
        .rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");
      expect(f.storageReads, "closed card must be refused before another object read").toEqual(readsBeforeResolution);
      const bodies = await Promise.all((await f.workspaceFiles()).map(path => readFile(path)));
      expect(bodies.length).toBeGreaterThan(0);
      expect(bodies.every(body => body.length === 0), "closed card must not restage any bytes").toBe(true);
      expect(await f.readRun(runId)).toMatchObject({ status: "running", runtimeMode: "native", nativeIssueId: f.issue.id });
    });
    expect(f.dispatched).toEqual([card.runId]);
    expect(await f.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .toEqual([{ id: card.runId }]);
    expect(await f.db.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([{ id: card.receipt.id, runId: card.runId }]);
    expect(await f.readTask()).toMatchObject({ title: f.issue.title, status: f.issue.status, assigneeAgentId: f.assigneeId });
    // UNPROVEN: provider execution, native terminal settlement, runs-twice,
    // full F3 automatic lifecycle and exact F4 CloneT. No terminal writes here.
  } finally { await f.close(); }
}, 240_000);
