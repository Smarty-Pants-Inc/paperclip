import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, environmentLeases, heartbeatRuns, issues, issueThreadInteractions,
  principalPermissionGrants,
} from "@paperclipai/db";
import { PERMISSION_KEYS, type EnvironmentLease } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createApp } from "../app.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { issueService } from "../services/issues.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "../services/heartbeat/runtime-selection.js";
import { buildPaperclipWakePayload, enrichWakeContextSnapshot } from "../services/heartbeat/run-preparation.js";
import { resolveHeartbeatNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { classifyAddressedInteractionExecutionCandidate, getNativeAddressedInteractionGrant } from "../services/native-runtime/native-addressed-interaction.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("refuses native acceptance and rejection of HTTP-created confirmations sourced from another issue while allowing same-issue agent and board-null cards", async () => {
  const temporary = createIsolatedTestHome();
  const environment = {
    PAPERCLIP_HOME: temporary.home,
    PAPERCLIP_CONFIG: join(temporary.home, "config.json"),
    PAPERCLIP_INSTANCE_ID: `source-run-${randomUUID()}`,
    PAPERCLIP_AGENT_JWT_SECRET: randomUUID(),
    PAPERCLIP_RUNNER_BINARY: join(temporary.home, "unused-runnerd"),
    PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "true",
    PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: ReturnType<NonNullable<typeof app>["listen"]> | undefined;
  const authorities: PaperclipRunnerToolAuthority[] = [];
  try {
    database = await startEmbeddedPostgresTestDatabase("native-addressed-source-run-");
    db = createDb(database.connectionString);
    const nativeDb = db;
    const companyId = randomUUID(), userId = randomUUID(), ka = randomUUID(), kp = randomUUID();
    process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;
    const boardKey = `pcp_board_${randomUUID()}`;
    const workspaceRoot = join(temporary.home, "workspace");
    const instructionsFilePath = join(temporary.home, "AGENTS.md");
    await mkdir(workspaceRoot);
    await writeFile(instructionsFilePath, "Respond only to your addressed confirmation.\n");
    const storage = createStorageService(createLocalDiskStorageProvider(join(temporary.home, "storage")));
    await db.insert(companies).values({ id: companyId, name: "Source-run lineage", issuePrefix: "LIN", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Local test board", email: `${userId}@example.com`, createdAt: new Date(), updatedAt: new Date() });
    const adapterConfig = { provider: "codex", model: "gpt-5.6-luna", instructionsFilePath };
    await db.insert(agents).values([ka, kp].map(id => ({
      id, companyId, name: id === ka ? "KA creator" : "KP resolver", status: "running",
      adapterType: "paperclip_runner", adapterConfig, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } },
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[ka, kp].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values(PERMISSION_KEYS.map(permissionKey => ({ companyId, principalType: "user", principalId: userId, permissionKey })));
    await db.insert(boardApiKeys).values({ userId, name: "Isolated test board key", keyHash: createHash("sha256").update(boardKey).digest("hex") });
    const [issueA, issueB] = await db.insert(issues).values([
      { companyId, title: "Unassigned target A", status: "todo", workMode: "standard", responsibleUserId: userId },
      { companyId, title: "Creator source B", status: "todo", workMode: "standard", responsibleUserId: userId },
    ]).returning();
    if (!issueA || !issueB) throw new Error("Missing source-run issues");
    expect(issueA).toMatchObject({ assigneeAgentId: null, assigneeUserId: null, checkoutRunId: null, executionRunId: null });
    const runA = randomUUID(), runB = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: runA, companyId, agentId: ka, status: "running", runtimeMode: "native", issueId: issueA.id,
        nativeIssueId: issueA.id, scopeKind: "issue", responsibleUserId: userId, contextSnapshot: { issueId: issueA.id } },
      { id: runB, companyId, agentId: ka, status: "running", runtimeMode: "native", issueId: issueB.id,
        nativeIssueId: issueB.id, scopeKind: "issue", responsibleUserId: userId, contextSnapshot: { issueId: issueB.id } },
    ]);
    const tokenA = createLocalAgentJwt(ka, companyId, "paperclip_runner", runA, userId);
    const tokenB = createLocalAgentJwt(ka, companyId, "paperclip_runner", runB, userId);
    if (!tokenA || !tokenB) throw new Error("Local test JWT generation failed");
    app = await createApp(db, {
      uiMode: "none", serverPort: 0, bindHost: "127.0.0.1", allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated", deploymentExposure: "private", authReady: true,
      companyDeletionEnabled: false, managedPluginAutoInstall: [], localPluginDir: join(temporary.home, "plugins"), storageService: storage,
      decisionServiceOptions: { wakeOriginAgent: async () => null },
    });
    await app.locals.bundledPluginsStartup;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback HTTP address");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const issueSvc = issueService(db);
    const [resolver] = await db.select().from(agents).where(eq(agents.id, kp));
    if (!resolver) throw new Error("Missing resolver");
    const readCard = async (id: string) => (await nativeDb.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)))[0]!;
    const cases = [
      { name: "same-issue agent", token: tokenA, sourceRunId: runA, foreign: false, decision: "accept", creatorAgentId: ka, creatorUserId: null },
      { name: "board-null source", token: boardKey, sourceRunId: null, foreign: false, decision: "reject", creatorAgentId: null, creatorUserId: userId },
      { name: "other-issue agent accept", token: tokenB, sourceRunId: runB, foreign: true, decision: "accept", creatorAgentId: ka, creatorUserId: null },
      { name: "other-issue agent reject", token: tokenB, sourceRunId: runB, foreign: true, decision: "reject", creatorAgentId: ka, creatorUserId: null },
    ] as const;
    for (const scenario of cases) {
      const prompt = `Confirm ${scenario.name}?`;
      const response = await fetch(`${apiUrl}/api/issues/${issueA.id}/interactions`, {
        method: "POST", headers: { authorization: `Bearer ${scenario.token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request_confirmation", title: prompt, resolverPolicy: "not_creator", addresseeAgentId: kp,
          continuationPolicy: "none", payload: { version: 1, prompt, rejectRequiresReason: true } }),
      });
      const responseText = await response.text();
      if (response.status !== 201) throw new Error(`REAL_ROUTE_REFUSED ${scenario.name}: HTTP ${response.status}: ${responseText.slice(0, 2000)}; no route/native-tool RED established`);
      const card = JSON.parse(responseText) as { id: string };
      expect(await readCard(card.id)).toMatchObject({ id: card.id, companyId, issueId: issueA.id, status: "pending",
        sourceRunId: scenario.sourceRunId, createdByAgentId: scenario.creatorAgentId, createdByUserId: scenario.creatorUserId,
        addresseeAgentId: kp, requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", result: null });
      const contextSnapshot = enrichWakeContextSnapshot({
        contextSnapshot: { issueId: issueA.id, taskId: issueA.id, interactionId: card.id, interactionIds: [card.id],
          interactionKind: "request_confirmation", sourceCommentId: null, sourceRunId: scenario.sourceRunId,
          wakeReason: "interaction_pending", source: "issue.interaction.created" },
        reason: "interaction_pending", source: "automation", triggerDetail: "system",
        payload: { issueId: issueA.id, interactionId: card.id, interactionKind: "request_confirmation", mutation: "interaction" },
      }).contextSnapshot;
      const wake = await buildPaperclipWakePayload({ db: nativeDb, companyId, agentId: kp, contextSnapshot });
      const context = { ...contextSnapshot, paperclipWake: wake };
      const runId = randomUUID();
      const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: kp, issueId: issueA.id, nativeIssueId: issueA.id,
        scopeKind: "issue", status: "running", invocationSource: "automation", triggerDetail: "system", responsibleUserId: userId, contextSnapshot: context }).returning();
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId: issueA.id, heartbeatRunId: runId, status: "active", leasePolicy: "ephemeral" }).returning();
      if (!run || !lease) throw new Error("Missing native response run");
      const binding = { companyId, issueId: issueA.id, agentId: kp, runId };
      expect(await getNativeAddressedInteractionGrant(db, binding), `strict pre-native denial: ${scenario.name}`).toBeNull();
      expect(await classifyAddressedInteractionExecutionCandidate(db, binding, context)).toBe(scenario.foreign ? "denied" : "response_only");
      const input: HeartbeatRuntimeSelectionInput = {
        run, agent: resolver,
        nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig,
          agent: resolver, issue: issueA, target: null, workspaceId: null }),
        task: { issueRef: issueA, issueContext: null, context, executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: wake, acceptedPlanContinuationWake: false },
        session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskSessionCredentialCompatible: true, taskSessionDecodedParams: null, taskSessionForRun: null, isFailedChatRunRetry: false, getFreshSessionHandoff: undefined },
        workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: workspaceRoot, repoUrl: null, repoRef: null, branchName: null },
          executionTarget: null, activeEnvironmentLease: { lease: lease as EnvironmentLease }, isDotRun: false, projectRepositoryPaths: [] },
        config: { runtimeConfig: { homeMode: "preconfigured" }, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
          agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
        recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null }, issuesSvc: issueSvc, runtimeEnv: {},
        onAdapterEvent: async () => {}, onNativeLifecycleSelected: () => {}, onProviderResourceDisposition: () => {}, onNativeOwnershipHeld: () => {}, stopControllerLease: () => {},
      };
      expect(input.nativeRuntimeResolution.kind).toBe("native");
      const selected = await selectHeartbeatRuntime(db, input).catch(error => {
        throw new Error(`REAL_NATIVE_SELECTION_REFUSED ${scenario.name}: ${String(error)}; no native-tool RED established`);
      });
      if (!selected.selected || !selected.nativeExecution) throw new Error(`REAL_NATIVE_SELECTION_REFUSED ${scenario.name}: no native execution; no native-tool RED established`);
      expect(selected.nativeExecution.binding).toMatchObject(binding);
      expect(selected.nativeExecution.interactionResponses).toEqual([expect.objectContaining({ interactionId: card.id, kind: "request_confirmation" })]);
      const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persistedRun).toMatchObject({ runtimeMode: "native", nativeIssueId: issueA.id, contextSnapshot: { sourceRunId: scenario.sourceRunId },
        runnerProfileJson: { nativeExecutionInput: { binding } } });
      const grant = await getNativeAddressedInteractionGrant(db, binding);
      if (scenario.foreign) expect.soft(grant, `foreign source grant must be null: ${scenario.name}`).toBeNull();
      else expect(grant).toMatchObject({ ...binding, interaction: { id: card.id, sourceRunId: scenario.sourceRunId } });
      const authority = new PaperclipRunnerToolAuthority(db, { ...binding, apiUrl, apiToolsEnabled: true,
        workspaceRoot, executionTargetKind: "local", storage });
      authorities.push(authority);
      expect(authority.definitions()).toContainEqual(expect.objectContaining({ name: "call_api" }));
      const reason = "The board-null control is rejected by its addressed resolver.";
      const attempt = await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
        operationId: `POST /api/issues/{id}/interactions/{interactionId}/${scenario.decision}`,
        pathParams: { id: issueA.id, interactionId: card.id }, body: scenario.decision === "reject" ? { reason } : {},
      } }).then(result => ({ result }), error => ({ error }));
      const persistedCard = await readCard(card.id);
      if (scenario.foreign) {
        if ("error" in attempt) {
          const error = attempt.error as { status?: number; message?: string };
          expect.soft(error.status === 403 || error.status === 409 || error.message === "paperclip_runner_tool_binding_not_authorized",
            `explicit native-tool authorization refusal: ${scenario.name}`).toBe(true);
        } else {
          expect.soft(attempt.result, `native-tool MUST refuse foreign source: ${scenario.name}`).toMatchObject({ ok: false, status: expect.any(Number) });
          const result = attempt.result as { status?: number; outcome?: string };
          expect.soft([403, 409]).toContain(result.status);
          expect.soft(result.outcome).not.toBe("unknown");
        }
        expect.soft(persistedCard, `foreign source must remain pending after actual native tool: ${scenario.name}`).toMatchObject({
          status: "pending", sourceRunId: runB, resolvedByAgentId: null, resolvedByRunId: null, resolvedByUserId: null, resolvedAt: null, result: null,
        });
      } else {
        const expectedStatus = scenario.decision === "accept" ? "accepted" : "rejected";
        expect(attempt).toMatchObject({ result: { ok: true, status: 200, data: { id: card.id, status: expectedStatus,
          resolvedByAgentId: kp, resolvedByRunId: runId, resolvedByUserId: null } } });
        expect(persistedCard).toMatchObject({ status: expectedStatus, sourceRunId: scenario.sourceRunId,
          resolvedByAgentId: kp, resolvedByRunId: runId, resolvedByUserId: null, resolvedAt: expect.any(Date), result: { outcome: expectedStatus } });
      }
      const action = scenario.decision === "accept" ? "issue.thread_interaction_accepted" : "issue.thread_interaction_rejected";
      const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issueA.id), eq(activityLog.action, action)));
      const cardAudit = audit.filter(row => (row.details as { interactionId?: string } | null)?.interactionId === card.id);
      if (scenario.foreign) expect.soft(cardAudit, `no resolution activity for foreign source: ${scenario.name}`).toEqual([]);
      else expect(cardAudit).toEqual([expect.objectContaining({ actorType: "agent", actorId: kp, agentId: kp, runId })]);
      expect((await db.select().from(issues).where(eq(issues.id, issueA.id)))[0]).toMatchObject({
        status: "todo", assigneeAgentId: null, assigneeUserId: null, executionRunId: null, checkoutRunId: null,
      });
      authority.close();
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB)))[0]).toMatchObject({ companyId, agentId: ka,
      runtimeMode: "native", issueId: issueB.id, nativeIssueId: issueB.id, contextSnapshot: { issueId: issueB.id } });
  } finally {
    for (const authority of authorities) authority.close();
    try {
      await app?.locals.paperclipShutdown?.();
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    } finally {
      try { await db?.$client.end(); }
      finally {
        try { await database?.cleanup(); }
        finally {
          for (const key of Object.keys(environment)) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
          }
          temporary.cleanup();
        }
      }
    }
  }
}, 240_000);
