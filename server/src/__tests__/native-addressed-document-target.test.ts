import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueAccessGrants, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createApp } from "../app.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { documentService } from "../services/documents.js";
import { getNativeAddressedInteractionGrant } from "../services/native-runtime/native-addressed-interaction.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("grants a current same-issue document target to the addressed run and resolves only that response", async () => {
  const temporary = createIsolatedTestHome();
  const environment = {
    PAPERCLIP_HOME: temporary.home,
    PAPERCLIP_CONFIG: join(temporary.home, "config.json"),
    PAPERCLIP_INSTANCE_ID: `addressed-document-${randomUUID()}`,
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
    database = await startEmbeddedPostgresTestDatabase("native-addressed-document-");
    db = createDb(database.connectionString);
    const companyId = randomUUID(), foreignCompanyId = randomUUID(), userId = randomUUID();
    const ka = randomUUID(), kp = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID(), foreignIssueId = randomUUID();
    const sourceRunId = randomUUID(), responseRunId = randomUUID();
    process.env.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS = companyId;

    await db.insert(companies).values([
      { id: companyId, name: "Addressed document target", issuePrefix: "ADT", requireBoardApprovalForNewAgents: false },
      { id: foreignCompanyId, name: "Foreign document company", issuePrefix: "FDT", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(authUsers).values({ id: userId, name: "Task sponsor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const adapterConfig = { provider: "codex", model: "gpt-5.6-luna" };
    await db.insert(agents).values([ka, kp].map(id => ({
      id, companyId, name: id === ka ? "KA task owner" : "KP addressed resolver", status: "running",
      adapterType: "paperclip_runner", adapterConfig, permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } },
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[ka, kp].map(principalId => ({ companyId, principalType: "agent", principalId, membershipRole: "member", status: "active" })),
    ]);
    const seededIssues = await db.insert(issues).values([
      { id: issueId, companyId, title: "KA-owned locked task", status: "in_review", reviewPolicy: "not_creator", workMode: "standard",
        visibility: "private", assigneeAgentId: ka, responsibleUserId: userId, createdByAgentId: ka },
      { id: otherIssueId, companyId, title: "Same-company other task", status: "todo", workMode: "standard",
        responsibleUserId: userId, createdByUserId: userId },
      { id: foreignIssueId, companyId: foreignCompanyId, title: "Foreign-company task", status: "todo", workMode: "standard" },
    ]).returning();
    const issue = seededIssues.find(row => row.id === issueId);
    const otherIssue = seededIssues.find(row => row.id === otherIssueId);
    const foreignIssue = seededIssues.find(row => row.id === foreignIssueId);
    if (!issue || !otherIssue || !foreignIssue) throw new Error("Missing addressed document issue fixtures");
    await db.insert(issueAccessGrants).values({ issueId, subjectType: "agent", subjectId: ka, source: "assignment",
      grantedByUserId: userId });

    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: ka, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId } });

    const documents = documentService(db);
    const targetDocument = (await documents.upsertIssueDocument({ issueId, key: "review-target", title: "Review target",
      format: "markdown", body: "CURRENT_TARGET_DOCUMENT_CANARY", createdByAgentId: ka, createdByRunId: sourceRunId })).document;
    const mismatchedDocument = (await documents.upsertIssueDocument({ issueId, key: "other-document", title: "Other document",
      format: "markdown", body: "SAME_ISSUE_UNRELATED_DOCUMENT", createdByUserId: userId })).document;
    const otherIssueDocument = (await documents.upsertIssueDocument({ issueId: otherIssueId, key: "other-only", title: "Other issue document",
      format: "markdown", body: "OTHER_ISSUE_DOCUMENT_CANARY", createdByUserId: userId })).document;
    const foreignDocument = (await documents.upsertIssueDocument({ issueId: foreignIssueId, key: targetDocument.key, title: "Foreign document",
      format: "markdown", body: "FOREIGN_COMPANY_DOCUMENT_CANARY", createdByUserId: userId })).document;
    const staleDocumentV1 = (await documents.upsertIssueDocument({ issueId, key: "stale-target", title: "Stale target",
      format: "markdown", body: "OLD_TARGET_REVISION", createdByUserId: userId })).document;
    await documents.upsertIssueDocument({ issueId, key: staleDocumentV1.key, title: staleDocumentV1.title,
      format: staleDocumentV1.format, body: "CURRENT_STALE-TEST_DOCUMENT", baseRevisionId: staleDocumentV1.latestRevisionId,
      createdByUserId: userId });

    const executionLockedAt = new Date("2026-11-13T10:00:00.000Z");
    await db.update(issues).set({ checkoutRunId: sourceRunId, executionRunId: sourceRunId,
      executionAgentNameKey: "ka-task-owner", executionLockedAt }).where(eq(issues.id, issueId));
    const readIssue = async () => (await db!.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const taskBefore = await readIssue();
    const taskOwnership = (task: typeof taskBefore) => ({ status: task.status, assigneeAgentId: task.assigneeAgentId,
      executionAgentNameKey: task.executionAgentNameKey, checkoutRunId: task.checkoutRunId,
      executionRunId: task.executionRunId, executionLockedAt: task.executionLockedAt });
    const expectedTaskOwnership = taskOwnership(taskBefore);

    const storage = createStorageService(createLocalDiskStorageProvider(join(temporary.home, "storage")));
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

    const sourceToken = createLocalAgentJwt(ka, companyId, "paperclip_runner", sourceRunId, userId);
    if (!sourceToken) throw new Error("Local KA test JWT generation failed");
    const prompt = "Read and acknowledge this exact revision of the review document.";
    const target = { type: "issue_document" as const, issueId, documentId: targetDocument.id, key: targetDocument.key,
      revisionId: targetDocument.latestRevisionId!, revisionNumber: targetDocument.latestRevisionNumber };
    const payload = { version: 1 as const, prompt, rejectRequiresReason: true, target };
    const created = await fetch(`${apiUrl}/api/issues/${issueId}/interactions`, {
      method: "POST", headers: { authorization: `Bearer ${sourceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request_confirmation", title: "Review the current document", resolverPolicy: "not_creator",
        addresseeAgentId: kp, continuationPolicy: "none", sourceRunId, payload }),
    });
    const createdBody = await created.json() as { id?: string };
    expect({ status: created.status, body: createdBody }).toMatchObject({ status: 201, body: { id: expect.any(String) } });
    const interactionId = createdBody.id!;

    const responseContext = { issueId, taskId: issueId, interactionId, interactionIds: [interactionId],
      interactionKind: "request_confirmation", sourceCommentId: null, sourceRunId,
      wakeReason: "interaction_pending", source: "issue.interaction.created" };
    await db.insert(heartbeatRuns).values({ id: responseRunId, companyId, agentId: kp, issueId, nativeIssueId: issueId,
      scopeKind: "issue", runtimeMode: "native", status: "running", invocationSource: "automation", triggerDetail: "system",
      responsibleUserId: null, contextSnapshot: responseContext });
    const binding = { companyId, issueId, agentId: kp, runId: responseRunId };
    const readInteraction = async () => (await db!.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId)))[0]!;
    const currentInteraction = await readInteraction();
    expect(currentInteraction).toMatchObject({ companyId, issueId, status: "pending", sourceRunId,
      createdByAgentId: ka, addresseeAgentId: kp, effectiveResolverPolicy: "not_creator", payload: { target } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId))).toEqual([
      expect.objectContaining({ companyId, agentId: ka, issueId, nativeIssueId: issueId, status: "running" }),
    ]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, responseRunId))).toEqual([
      expect.objectContaining({ companyId, agentId: kp, issueId, nativeIssueId: issueId, status: "running",
        contextSnapshot: expect.objectContaining({ interactionId, sourceRunId, wakeReason: "interaction_pending" }) }),
    ]);
    expect(taskOwnership(await readIssue())).toEqual(expectedTaskOwnership);

    // This is the intended RED on the base revision: the existing grant rejects
    // every non-null target, including this current, same-company document.
    expect(await getNativeAddressedInteractionGrant(db, binding)).toMatchObject({ ...binding,
      interaction: { id: interactionId, status: "pending", sourceRunId, payload: { target } },
    });

    const authority = new PaperclipRunnerToolAuthority(db, { ...binding, apiUrl, apiToolsEnabled: true });
    authorities.push(authority);
    expect(authority.definitions().map(tool => tool.name)).toEqual(expect.arrayContaining(["read_document", "call_api"]));
    const documentRead = await authority.execute({ tool: "read_document", callId: randomUUID(), arguments: { key: targetDocument.key } });
    expect(documentRead).toMatchObject({ document: { id: targetDocument.id, companyId, issueId,
      key: targetDocument.key, latestRevisionId: target.revisionId, body: "CURRENT_TARGET_DOCUMENT_CANARY" } });
    await expect(authority.execute({ tool: "read_document", callId: randomUUID(), arguments: { key: otherIssueDocument.key } }))
      .rejects.toThrow("paperclip_runner_document_not_found");
    await expect(authority.execute({ tool: "write_document", callId: randomUUID(), arguments: {
      key: targetDocument.key, body: "KP cannot edit KA's task",
    } })).rejects.toThrow("paperclip_runner_tool_binding_not_authorized");

    const expectExplicitDenial = (attempt: { result: unknown } | { error: unknown }) => {
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
    const unrelatedMutation = await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: {
      operationId: "PATCH /api/issues/{id}", pathParams: { id: issueId }, body: { title: "KP cannot rewrite KA's task" },
    } }).then(result => ({ result }), error => ({ error }));
    expectExplicitDenial(unrelatedMutation);
    expect(taskOwnership(await readIssue())).toEqual(expectedTaskOwnership);

    const setPayload = async (nextPayload: Record<string, unknown>) => {
      await db!.update(issueThreadInteractions).set({ payload: nextPayload as never }).where(eq(issueThreadInteractions.id, interactionId));
    };
    const expectNoGrantForPayload = async (name: string, nextPayload: Record<string, unknown>) => {
      await setPayload(nextPayload);
      expect(await getNativeAddressedInteractionGrant(db!, binding), name).toBeNull();
    };
    await expectNoGrantForPayload("missing current document", { ...payload, target: {
      type: "issue_document", issueId, documentId: randomUUID(), key: "missing-document", revisionId: randomUUID(),
    } });
    await expectNoGrantForPayload("foreign-company document identity", { ...payload, target: {
      type: "issue_document", issueId, documentId: foreignDocument.id, key: targetDocument.key,
      revisionId: foreignDocument.latestRevisionId,
    } });
    await expectNoGrantForPayload("different issue in the same company", { ...payload, target: {
      type: "issue_document", issueId: otherIssue.id, documentId: otherIssueDocument.id, key: otherIssueDocument.key,
      revisionId: otherIssueDocument.latestRevisionId,
    } });
    await expectNoGrantForPayload("document id does not match its issue/key/revision", { ...payload, target: {
      ...target, documentId: mismatchedDocument.id,
    } });
    await expectNoGrantForPayload("stale document revision", { ...payload, target: {
      type: "issue_document", issueId, documentId: staleDocumentV1.id, key: staleDocumentV1.key,
      revisionId: staleDocumentV1.latestRevisionId,
    } });
    await expectNoGrantForPayload("custom target", { ...payload, target: { type: "custom", key: "external-review", revisionId: "v1" } });
    await expectNoGrantForPayload("attachment target", { ...payload, target: { type: "issue_attachment", issueId,
      attachmentId: randomUUID(), assetId: randomUUID(), sha256: "a".repeat(64) } });
    await expectNoGrantForPayload("governed tool-action payload", { ...payload, toolAction: {} });
    await expectNoGrantForPayload("secret proposal payload", { ...payload, secretProposal: {} });

    await setPayload(payload);
    await db.update(issueThreadInteractions).set({ requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only" })
      .where(eq(issueThreadInteractions.id, interactionId));
    expect(await getNativeAddressedInteractionGrant(db, binding), "human-only confirmations do not grant agent resolution").toBeNull();
    await db.update(issueThreadInteractions).set({ requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator" })
      .where(eq(issueThreadInteractions.id, interactionId));

    const addressedGrants = await db.select().from(issueAccessGrants).where(and(
      eq(issueAccessGrants.issueId, issueId), eq(issueAccessGrants.subjectType, "agent"), eq(issueAccessGrants.subjectId, kp),
    ));
    const addressedGrant = addressedGrants.find(grant => grant.revokedAt === null);
    if (!addressedGrant) throw new Error("Missing KP's current private-issue access grant");
    await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, addressedGrant.id));
    expect(await getNativeAddressedInteractionGrant(db, binding), "revoked issue access denies the addressed response grant").toBeNull();
    await db.update(issueAccessGrants).set({ revokedAt: null }).where(eq(issueAccessGrants.id, addressedGrant.id));

    expect(await getNativeAddressedInteractionGrant(db, binding)).toMatchObject({
      ...binding, interaction: { id: interactionId, status: "pending", sourceRunId, payload: { target } },
    });
    expect(taskOwnership(await readIssue())).toEqual(expectedTaskOwnership);

    const acceptInput = { operationId: "POST /api/issues/{id}/interactions/{interactionId}/accept",
      pathParams: { id: issueId, interactionId }, body: {} };
    const accepted = await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: acceptInput });
    expect(accepted).toMatchObject({ ok: true, status: 200, data: { id: interactionId, status: "accepted",
      resolvedByAgentId: kp, resolvedByRunId: responseRunId, resolvedByUserId: null } });
    expect(await readInteraction()).toMatchObject({ status: "accepted", sourceRunId,
      resolvedByAgentId: kp, resolvedByRunId: responseRunId, resolvedByUserId: null, resolvedAt: expect.any(Date),
      result: { outcome: "accepted" } });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
      eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.thread_interaction_accepted"))))
      .toEqual([expect.objectContaining({ actorType: "agent", actorId: kp, agentId: kp, runId: responseRunId,
        details: expect.objectContaining({ interactionId }) })]);
    expect(await getNativeAddressedInteractionGrant(db, binding, { phase: "settlement", expectedStatus: "accepted" })).toMatchObject({ ...binding,
      interaction: { id: interactionId, status: "accepted", sourceRunId, resolvedByAgentId: kp,
        resolvedByRunId: responseRunId, resolvedByUserId: null, payload: { target } } });
    await documents.upsertIssueDocument({ issueId, key: targetDocument.key, title: targetDocument.title, format: targetDocument.format,
      body: "KA REVISION 2 AFTER ACCEPT", baseRevisionId: targetDocument.latestRevisionId,
      createdByAgentId: ka, createdByRunId: sourceRunId });
    for (const phase of ["settlement", "resolved"] as const) {
      expect(await getNativeAddressedInteractionGrant(db, binding, { phase, expectedStatus: "accepted" })).toMatchObject({ ...binding,
        interaction: { id: interactionId, status: "accepted", sourceRunId, resolvedByAgentId: kp,
          resolvedByRunId: responseRunId, resolvedByUserId: null, payload: { target } } });
    }
    expect(await getNativeAddressedInteractionGrant(db, binding)).toBeNull();
    expectExplicitDenial(await authority.execute({ tool: "call_api", callId: randomUUID(), arguments: acceptInput })
      .then(result => ({ result }), error => ({ error })));
    expect(taskOwnership(await readIssue())).toEqual(expectedTaskOwnership);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)))
      .toEqual([expect.objectContaining({ agentId: ka, status: "running", nativeIssueId: issueId })]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, responseRunId)))
      .toEqual([expect.objectContaining({ agentId: kp, status: "running", nativeIssueId: issueId })]);
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
