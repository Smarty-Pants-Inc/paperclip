import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog, agents, authUsers, boardApiKeys, companies, companyMemberships,
  createDb, environmentLeases, heartbeatRuns, issues, issueThreadInteractions,
  principalPermissionGrants,
} from "@paperclipai/db";
import { PERMISSION_KEYS, type EnvironmentLease } from "@paperclipai/shared";
import { createApp } from "../app.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { issueService } from "../services/issues.js";
import { selectHeartbeatRuntime, type HeartbeatRuntimeSelectionInput } from "../services/heartbeat/runtime-selection.js";
import { buildPaperclipWakePayload, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot } from "../services/heartbeat/run-preparation.js";
import { resolveHeartbeatNativeRuntimeMode } from "../services/native-runtime/runtime-mode.js";
import { stageNativeRunnerWakeAttachments } from "../services/native-runtime/native-runner-file-handoff.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { assertCurrentWakeCommentsRead } from "../services/native-runtime/current-wake-comments.js";
import type { PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("confines coalesced addressed-card attachments and resolves two cards through native tools and authenticated HTTP without taking the assignee's lock", async () => {
  const temporary = createIsolatedTestHome();
  const environment = {
    PAPERCLIP_HOME: temporary.home,
    PAPERCLIP_CONFIG: join(temporary.home, "config.json"),
    PAPERCLIP_INSTANCE_ID: `addressed-${randomUUID()}`,
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
  let stage: Awaited<ReturnType<typeof stageNativeRunnerWakeAttachments>> | undefined;
  const authorities: PaperclipRunnerToolAuthority[] = [];
  try {
    database = await startEmbeddedPostgresTestDatabase("native-addressed-server-");
    db = createDb(database.connectionString);
    const companyId = randomUUID(), userId = randomUUID(), ka = randomUUID(), kp = randomUUID();
    process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;
    const runIds = [randomUUID(), randomUUID(), randomUUID()] as const, kaRunId = randomUUID();
    const boardKey = `pcp_board_${randomUUID()}`;
    const workspaceRoot = join(temporary.home, "workspace");
    const instructions = join(temporary.home, "instructions");
    await mkdir(workspaceRoot);
    await mkdir(instructions);
    await writeFile(join(instructions, "AGENTS.md"), "Resolve only the confirmation cards addressed to you. Do not take over the task.\n");
    const storage = createStorageService(createLocalDiskStorageProvider(join(temporary.home, "storage")));
    await db.insert(companies).values({ id: companyId, name: "Addressed native regression", issuePrefix: "ADR", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board operator", email: `${userId}@example.com`, createdAt: new Date(), updatedAt: new Date() });
    const adapterConfig = { provider: "codex", model: "gpt-5.6-luna", instructionsFilePath: join(instructions, "AGENTS.md") };
    await db.insert(agents).values([ka, kp].map(id => ({
      id, companyId, name: id === ka ? "KA task assignee" : "KP card resolver", status: "running",
      adapterType: "paperclip_runner", adapterConfig, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } },
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[ka, kp].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    await db.insert(principalPermissionGrants).values(PERMISSION_KEYS.map(permissionKey => ({ companyId, principalType: "user", principalId: userId, permissionKey })));
    await db.insert(boardApiKeys).values({ userId, name: "Addressed card board key", keyHash: createHash("sha256").update(boardKey).digest("hex") });
    const [issue] = await db.insert(issues).values({ companyId, title: "KA keeps this task", status: "in_progress", workMode: "standard", assigneeAgentId: ka }).returning();
    if (!issue) throw new Error("Missing task fixture");
    await db.insert(heartbeatRuns).values({ id: kaRunId, companyId, agentId: ka, status: "running", runtimeMode: "native", nativeIssueId: issue.id, issueId: issue.id, scopeKind: "issue", contextSnapshot: { issueId: issue.id } });
    await db.update(issues).set({ checkoutRunId: kaRunId, executionRunId: kaRunId,
      executionAgentNameKey: "ka-task-assignee", executionLockedAt: new Date("2026-11-13T10:00:00Z") }).where(eq(issues.id, issue.id));
    const readTask = () => db!.select().from(issues).where(eq(issues.id, issue.id)).then(rows => rows[0]!);
    const originalTask = await readTask();
    const readTaskInvariant = async () => {
      const task = await readTask();
      return { ...task, updatedAt: originalTask.updatedAt };
    };
    const readCards = () => db!.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id));

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
    const createCommentFile = async (issueId: string, filename: string, text: string) => {
      const bytes = Buffer.from(text);
      const stored = await storage.putFile({ companyId, namespace: `issues/${issueId}`, originalFilename: filename, contentType: "text/plain", body: bytes });
      const comment = await issueSvc.addComment(issueId, `Inspect ${filename} before deciding.`, { userId });
      const attachment = await issueSvc.createAttachment({ issueId, issueCommentId: comment.id,
        provider: stored.provider, objectKey: stored.objectKey, contentType: stored.contentType, byteSize: stored.byteSize,
        sha256: stored.sha256, originalFilename: stored.originalFilename, createdByUserId: userId });
      return { bytes, stored, comment, attachment };
    };
    const ownedFiles = [
      await createCommentFile(issue.id, "bounded-plan.txt", "CARD_ONE_OWNED_PLAN_BYTES\n"),
      await createCommentFile(issue.id, "unsafe-alternative.txt", "CARD_TWO_OWNED_ALTERNATIVE_BYTES\n"),
    ] as const;
    const prompts = ["Approve the bounded handoff plan?", "Approve the unsafe alternative?", "Confirm without originating files?"];
    const cardIds: string[] = [];
    for (const [index, prompt] of prompts.entries()) {
      const sourceCommentId = ownedFiles[index]?.comment.id ?? null;
      const response = await fetch(`${apiUrl}/api/issues/${issue.id}/interactions`, {
        method: "POST", headers: { authorization: `Bearer ${boardKey}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "request_confirmation", title: prompt, resolverPolicy: "not_creator", addresseeAgentId: kp,
          continuationPolicy: "none", sourceCommentId, payload: { version: 1, prompt, rejectRequiresReason: true } }),
      });
      const card = await response.json();
      expect({ status: response.status, card }).toMatchObject({ status: 201, card: {
        id: expect.any(String), status: "pending", createdByUserId: userId, createdByAgentId: null,
        addresseeAgentId: kp, requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator", continuationPolicy: "none",
        sourceCommentId, originCommentIds: sourceCommentId ? [sourceCommentId] : [],
      } });
      cardIds.push(card.id);
    }

    const unrelated = await createCommentFile(issue.id, "unrelated.txt", "UNRELATED_SAME_ISSUE_ATTACHMENT_BYTES\n");
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Unrelated task", status: "todo" }).returning();
    if (!otherIssue) throw new Error("Missing unrelated task fixture");
    const otherIssueFile = await createCommentFile(otherIssue.id, "other-task.txt", "OTHER_ISSUE_ATTACHMENT_BYTES\n");
    const canonicalCardContext = (index: number) => enrichWakeContextSnapshot({
      contextSnapshot: { issueId: issue.id, taskId: issue.id, interactionId: cardIds[index]!, interactionIds: [cardIds[index]!],
        interactionKind: "request_confirmation", sourceCommentId: ownedFiles[index]?.comment.id ?? null,
        sourceRunId: null, wakeReason: "interaction_pending", source: "issue.interaction.created" },
      reason: "interaction_pending", source: "automation", triggerDetail: "system",
      payload: { issueId: issue.id, interactionId: cardIds[index]!, interactionKind: "request_confirmation", mutation: "interaction" },
    }).contextSnapshot;
    const [resolver] = await db.select().from(agents).where(eq(agents.id, kp));
    if (!resolver) throw new Error("Missing native resolver fixture");
    const nativeDb = db;
    const prepareNativeRun = async (index: number) => {
      const interactionId = cardIds[index]!;
      const runId = runIds[index]!;
      const commentWake = enrichWakeContextSnapshot({ contextSnapshot: { issueId: issue.id, taskId: issue.id,
        wakeCommentIds: [...ownedFiles.map(file => file.comment.id), unrelated.comment.id, otherIssueFile.comment.id] },
        reason: "issue_commented", source: "automation", triggerDetail: "system", payload: { issueId: issue.id, commentId: unrelated.comment.id },
      }).contextSnapshot;
      const wakeContext = mergeCoalescedContextSnapshot(commentWake, canonicalCardContext(index), { preserveExistingInteractionContinuation: true });
      const wake = await buildPaperclipWakePayload({ db: nativeDb, companyId, agentId: kp, contextSnapshot: wakeContext });
      for (const file of [...ownedFiles, unrelated]) {
        expect(wake?.comments).toContainEqual(expect.objectContaining({ id: file.comment.id, attachments: [expect.objectContaining({ id: file.attachment.id })] }));
      }
      expect(wake?.comments).not.toContainEqual(expect.objectContaining({ id: otherIssueFile.comment.id }));
      const context = { ...wakeContext, paperclipWake: wake };
      const [run] = await nativeDb.insert(heartbeatRuns).values({ id: runId, companyId, agentId: kp, issueId: issue.id, nativeIssueId: issue.id,
        scopeKind: "issue", status: "running", invocationSource: "automation", triggerDetail: "system", responsibleUserId: userId, contextSnapshot: context }).returning();
      const [lease] = await nativeDb.insert(environmentLeases).values({ companyId, issueId: issue.id, heartbeatRunId: runId, status: "active", leasePolicy: "ephemeral" }).returning();
      if (!run || !lease) throw new Error("Missing native run fixture");
      const input: HeartbeatRuntimeSelectionInput = {
        run, agent: resolver,
        nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: true, runtimeConfig: {}, adapterConfig,
          agent: resolver, issue: originalTask, target: null, workspaceId: null }),
        task: { issueRef: originalTask, issueContext: null, context, executionContinuation: null, safeWakeComments: [], safeWakeCommentContext: null, paperclipWakePayload: wake, acceptedPlanContinuationWake: false },
        session: { persistedNativeExecutionInput: null, persistedRunnerProfile: {}, taskSessionCredentialCompatible: true, taskSessionDecodedParams: null, taskSessionForRun: null, isFailedChatRunRetry: false, getFreshSessionHandoff: undefined },
        workspace: { persistedExecutionWorkspace: null, executionWorkspace: { cwd: workspaceRoot, repoUrl: null, repoRef: null, branchName: null },
          executionTarget: null, activeEnvironmentLease: { lease: lease as EnvironmentLease }, isDotRun: false, projectRepositoryPaths: [] },
        config: { runtimeConfig: { homeMode: "preconfigured" }, runtimeSkillEntries: [], runScopedMentionedSkillKeys: [], instructionCopy: null,
          agentIdentity: undefined, issueAssigneeOverrides: null, resolvedConfig: {}, managedAiRuntime: undefined },
        recovery: {}, trace: { providerTraceRequested: false, providerTraceCapture: null }, issuesSvc: issueSvc, runtimeEnv: {},
        onAdapterEvent: async () => {}, onNativeLifecycleSelected: () => {}, onProviderResourceDisposition: () => {}, onNativeOwnershipHeld: () => {}, stopControllerLease: () => {},
      };
      expect(input.nativeRuntimeResolution.kind).toBe("native");
      const selected = await selectHeartbeatRuntime(nativeDb, input);
      if (!selected.selected || !selected.nativeExecution) throw new Error("Expected real native runtime selection");
      expect(selected.nativeExecution.binding).toMatchObject({ companyId, issueId: issue.id, agentId: kp, runId });
      expect(selected.nativeExecution.interactionResponses).toHaveLength(1);
      expect(selected.nativeExecution.interactionResponses[0]).toMatchObject({ interactionId, kind: "request_confirmation",
        response: { status: "pending", payload: { prompt: prompts[index] }, result: null } });
      const [persistedRun] = await nativeDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(persistedRun?.contextSnapshot).toMatchObject({ interactionId, interactionIds: [interactionId] });
      expect(persistedRun?.runnerProfileJson).toMatchObject({ nativeExecutionInput: {
        binding: { companyId, issueId: issue.id, agentId: kp, runId }, interactionResponses: [expect.objectContaining({ interactionId })],
      } });
      return { run, selected, interactionId, context };
    };
    const preparedRuns = [await prepareNativeRun(0), await prepareNativeRun(1)] as const;
    const noOriginRun = await prepareNativeRun(2);
    expect(await readTaskInvariant()).toEqual(originalTask);
    expect(await readCards()).toEqual(expect.arrayContaining(cardIds.map(id => expect.objectContaining({ id, status: "pending", resolvedByRunId: null, result: null }))));
    expect(await readTask()).toMatchObject({ assigneeAgentId: ka, executionRunId: kaRunId });

    const stagedPaths: string[] = [];
    for (const [index, prepared] of preparedRuns.entries()) {
      stage = await stageNativeRunnerWakeAttachments({ db, binding: { companyId, issueId: issue.id, agentId: kp,
        runId: runIds[index]!, workspaceRoot, executionTargetKind: "local" }, storage });
      const owned = ownedFiles[index]!;
      const paths = stage.attachments.flatMap(file => file.workspaceRelativePath ? [join(workspaceRoot, file.workspaceRelativePath)] : []);
      stagedPaths.push(...paths);
      const stagedBodies = await Promise.all(paths.map(file => readFile(file, "utf8")));
      expect.soft(stagedBodies).toEqual([owned.bytes.toString("utf8")]);
      expect.soft(stage.attachments).toEqual([expect.objectContaining({ id: owned.attachment.id, byteSize: owned.bytes.length,
        unavailableReason: null, workspaceRelativePath: expect.any(String) })]);
      expect.soft(stagedBodies).not.toContain(ownedFiles[1 - index]!.bytes.toString("utf8"));
      expect.soft(stagedBodies).not.toContain(unrelated.bytes.toString("utf8"));
      expect.soft(stagedBodies).not.toContain(otherIssueFile.bytes.toString("utf8"));
      await stage.cleanup();
      stage = undefined;
      for (const stagedPath of paths) expect(await readFile(stagedPath)).toEqual(Buffer.alloc(0));
      expect(prepared.selected.nativeExecution?.interactionResponses.map(response => response.interactionId)).toEqual([prepared.interactionId]);
    }

    stage = await stageNativeRunnerWakeAttachments({ db, binding: { companyId, issueId: issue.id, agentId: kp,
      runId: noOriginRun.run.id, workspaceRoot, executionTargetKind: "local" }, storage });
    const noOriginBodies = await Promise.all(stage.attachments.flatMap(file => file.workspaceRelativePath
      ? [readFile(join(workspaceRoot, file.workspaceRelativePath), "utf8")] : []));
    expect.soft(noOriginBodies).toEqual([]);
    expect.soft(stage.attachments).toEqual([]);
    await stage.cleanup();
    stage = undefined;

    await db.update(issueThreadInteractions).set({ originCommentIds: [ownedFiles[1].comment.id] })
      .where(eq(issueThreadInteractions.id, noOriginRun.interactionId));
    stage = await stageNativeRunnerWakeAttachments({ db, binding: { companyId, issueId: issue.id, agentId: kp,
      runId: noOriginRun.run.id, workspaceRoot, executionTargetKind: "local" }, storage });
    const originOnlyBodies = await Promise.all(stage.attachments.flatMap(file => file.workspaceRelativePath
      ? [readFile(join(workspaceRoot, file.workspaceRelativePath), "utf8")] : []));
    expect.soft(originOnlyBodies).toEqual([ownedFiles[1].bytes.toString("utf8")]);
    expect.soft(stage.attachments.map(file => file.id)).toEqual([ownedFiles[1].attachment.id]);
    await stage.cleanup();
    stage = undefined;
    await db.update(issueThreadInteractions).set({ originCommentIds: [] })
      .where(eq(issueThreadInteractions.id, noOriginRun.interactionId));

    const pristineContext = canonicalCardContext(0);
    const pristineWake = await buildPaperclipWakePayload({ db, companyId, agentId: kp, contextSnapshot: pristineContext });
    expect(pristineWake?.comments ?? []).toEqual([]);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...pristineContext, paperclipWake: pristineWake } }).where(eq(heartbeatRuns.id, runIds[0]));
    stage = await stageNativeRunnerWakeAttachments({ db, binding: { companyId, issueId: issue.id, agentId: kp,
      runId: runIds[0], workspaceRoot, executionTargetKind: "local" }, storage });
    const pristineBodies = await Promise.all(stage.attachments.flatMap(file => file.workspaceRelativePath
      ? [readFile(join(workspaceRoot, file.workspaceRelativePath), "utf8")] : []));
    expect.soft(pristineBodies).toEqual([ownedFiles[0].bytes.toString("utf8")]);
    expect.soft(stage.attachments.map(file => file.id)).toEqual([ownedFiles[0].attachment.id]);
    await stage.cleanup();
    stage = undefined;
    await db.update(heartbeatRuns).set({ contextSnapshot: preparedRuns[0].context }).where(eq(heartbeatRuns.id, runIds[0]));

    await db.update(heartbeatRuns).set({ contextSnapshot: preparedRuns[0].context }).where(eq(heartbeatRuns.id, kaRunId));
    stage = await stageNativeRunnerWakeAttachments({ db, binding: { companyId, issueId: issue.id, agentId: ka,
      runId: kaRunId, workspaceRoot, executionTargetKind: "local" }, storage });
    const ownerBodies = await Promise.all(stage.attachments.flatMap(file => file.workspaceRelativePath
      ? [readFile(join(workspaceRoot, file.workspaceRelativePath), "utf8")] : []));
    expect(ownerBodies.sort()).toEqual([...ownedFiles, unrelated].map(file => file.bytes.toString("utf8")).sort());
    await stage.cleanup();
    stage = undefined;
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, kaRunId));

    const [firstRun, secondRun] = preparedRuns;
    const authority1 = new PaperclipRunnerToolAuthority(db, { companyId, issueId: issue.id, agentId: kp, runId: firstRun.run.id, apiUrl,
      apiToolsEnabled: true, workspaceRoot, executionTargetKind: "local", storage });
    const authority2 = new PaperclipRunnerToolAuthority(db, { companyId, issueId: issue.id, agentId: kp, runId: secondRun.run.id, apiUrl,
      apiToolsEnabled: true, workspaceRoot, executionTargetKind: "local", storage });
    authorities.push(authority1, authority2);
    for (const authority of authorities) expect(authority.definitions()).toContainEqual(expect.objectContaining({ name: "call_api" }));

    const assertExplicitDenial = (attempt: { result: unknown } | { error: unknown }) => {
      if ("error" in attempt) {
        const error = attempt.error as { status?: number; message?: string };
        expect(error.status === 403 || error.status === 409 || error.message === "paperclip_runner_tool_binding_not_authorized").toBe(true);
      } else {
        const result = attempt.result as { ok?: boolean; status?: number | null; outcome?: string };
        expect(result.ok).toBe(false);
        expect([403, 409]).toContain(result.status);
        expect(result.outcome).not.toBe("unknown");
      }
    };

    const deniedPatch = await authority1.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "PATCH /api/issues/{id}", pathParams: { id: issue.id }, body: { title: "KP must not rewrite KA's task", assigneeAgentId: kp },
    } }).then(result => ({ result }), error => ({ error }));
    if ("error" in deniedPatch) {
      expect(deniedPatch.error?.status === 403 || deniedPatch.error?.message === "paperclip_runner_tool_binding_not_authorized").toBe(true);
    } else {
      expect(deniedPatch.result).toMatchObject({ ok: false, status: 403 });
    }
    expect(await readTask()).toMatchObject({ title: originalTask.title, status: originalTask.status, assigneeAgentId: ka, executionRunId: kaRunId });

    const unrelatedCardAttempt = await authority1.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "POST /api/issues/{id}/interactions/{interactionId}/accept", pathParams: { id: issue.id, interactionId: cardIds[1]! }, body: {},
    } }).then(result => ({ result }), error => ({ error }));
    assertExplicitDenial(unrelatedCardAttempt);
    expect(await readCards()).toEqual(expect.arrayContaining([expect.objectContaining({ id: cardIds[1], status: "pending", result: null })]));

    const acceptInput = { operationId: "POST /api/issues/{id}/interactions/{interactionId}/accept", pathParams: { id: issue.id, interactionId: cardIds[0]! }, body: {} };
    const acceptCallId = randomUUID();
    const acceptedResult = await authority1.execute({ tool: "call_api", callId: acceptCallId, arguments: acceptInput });
    expect(acceptedResult).toMatchObject({ ok: true, status: 200, data: { id: cardIds[0], status: "accepted",
      resolvedByAgentId: kp, resolvedByRunId: runIds[0], resolvedByUserId: null } });
    expect(acceptedResult).not.toMatchObject({ outcome: "unknown" });
    await expect(authority1.execute({ tool: "call_api", callId: acceptCallId, arguments: acceptInput })).resolves.toEqual(acceptedResult);

    const freshResolvedAttempt = await authority1.execute({ tool: "call_api", callId: randomUUID(), arguments: acceptInput })
      .then(result => ({ result }), error => ({ error }));
    assertExplicitDenial(freshResolvedAttempt);
    expect(await readCards()).toEqual(expect.arrayContaining([expect.objectContaining({ id: cardIds[0], status: "accepted", resolvedByRunId: runIds[0] })]));

    const rejectionReason = "The alternative expands scope beyond the bounded handoff.";
    const rejectedResult = await authority2.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "POST /api/issues/{id}/interactions/{interactionId}/reject", pathParams: { id: issue.id, interactionId: cardIds[1]! },
      body: { reason: rejectionReason },
    } });
    expect(rejectedResult).toMatchObject({ ok: true, status: 200, data: { id: cardIds[1], status: "rejected",
      resolvedByAgentId: kp, resolvedByRunId: runIds[1], resolvedByUserId: null, result: { outcome: "rejected", reason: rejectionReason } } });
    expect(rejectedResult).not.toMatchObject({ outcome: "unknown" });

    const resolved = await readCards();
    expect(resolved.find(card => card.id === cardIds[0])).toMatchObject({ status: "accepted", resolvedByAgentId: kp,
      resolvedByRunId: runIds[0], resolvedByUserId: null, resolvedAt: expect.any(Date), continuationPolicy: "none", result: { outcome: "accepted" } });
    expect(resolved.find(card => card.id === cardIds[1])).toMatchObject({ status: "rejected", resolvedByAgentId: kp,
      resolvedByRunId: runIds[1], resolvedByUserId: null, resolvedAt: expect.any(Date), continuationPolicy: "none",
      result: { outcome: "rejected", reason: rejectionReason } });
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, issue.id)));
    for (const { index, action } of [
      { index: 0, action: "issue.thread_interaction_accepted" },
      { index: 1, action: "issue.thread_interaction_rejected" },
    ]) {
      expect(audit.filter(row => row.action === action)).toEqual([expect.objectContaining({ actorType: "agent", actorId: kp, runId: runIds[index],
        details: expect.objectContaining({ interactionId: cardIds[index] }) })]);
    }
    expect(await readTask()).toMatchObject({ title: originalTask.title, status: originalTask.status, assigneeAgentId: ka, executionRunId: kaRunId });
    const responseResult: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The addressed confirmation response was recorded.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    };
    for (const runId of runIds.slice(0, 2)) {
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "running", runtimeMode: "native", nativeIssueId: issue.id });
      const binding = { companyId, issueId: issue.id, agentId: kp, runId };
      await expect(stageNativeRunnerWakeAttachments({ db, binding: { ...binding, workspaceRoot, executionTargetKind: "local" }, storage }))
        .rejects.toThrow("paperclip_runner_attachment_staging_not_authorized");
      await expect(assertCurrentWakeCommentsRead(db, binding, null)).rejects.toThrow("native_current_wake_comments_binding_changed");
      await expect(assertCurrentWakeCommentsRead(db, binding, null, responseResult)).resolves.toBeUndefined();
    }
    expect(await readTask()).toMatchObject({ title: originalTask.title, status: originalTask.status, assigneeAgentId: ka, executionRunId: kaRunId });
    expect(await readTaskInvariant()).toEqual(originalTask);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, kaRunId)))[0]).toMatchObject({
      agentId: ka, status: "running", runtimeMode: "native", nativeIssueId: issue.id, contextSnapshot: { issueId: issue.id },
    });
    expect((await readCards()).find(card => card.id === cardIds[2])).toMatchObject({ status: "pending", sourceCommentId: null,
      originCommentIds: [], resolvedByRunId: null, result: null });
    for (const stagedPath of stagedPaths) expect(await readFile(stagedPath)).toEqual(Buffer.alloc(0));
  } finally {
    try {
      await stage?.cleanup();
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
  }
}, 240_000);
