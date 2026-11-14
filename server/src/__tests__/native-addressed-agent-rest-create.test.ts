import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createApp } from "../app.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

it("creates an addressed request_confirmation through documented agent run-JWT REST and reads its persisted attribution by GET", async () => {
  const temporary = createIsolatedTestHome();
  const environment = {
    PAPERCLIP_HOME: temporary.home,
    PAPERCLIP_CONFIG: join(temporary.home, "config.json"),
    PAPERCLIP_INSTANCE_ID: `agent-rest-create-${randomUUID()}`,
    PAPERCLIP_AGENT_JWT_SECRET: randomUUID(),
    PAPERCLIP_RUNNER_BINARY: join(temporary.home, "unused-runnerd"),
    PAPERCLIP_RUNNER_API_TOOLS_ENABLED: "false",
    PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS: "",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let server: ReturnType<NonNullable<typeof app>["listen"]> | undefined;
  try {
    database = await startEmbeddedPostgresTestDatabase("native-addressed-agent-rest-create-");
    db = createDb(database.connectionString);
    const companyId = randomUUID();
    const userId = randomUUID();
    const creatorAgentId = randomUUID();
    const recipientAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent REST interaction creation",
      issuePrefix: "ARI",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Isolated test operator",
      email: `${userId}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const adapterConfig = { provider: "codex", model: "gpt-5.6-luna", instructionsFilePath: join(temporary.home, "AGENTS.md") };
    await db.insert(agents).values([creatorAgentId, recipientAgentId].map(id => ({
      id,
      companyId,
      name: id === creatorAgentId ? "Creator agent" : "Addressed recipient agent",
      status: "running",
      adapterType: "paperclip_runner",
      adapterConfig,
      permissions: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, intervalSec: 0 } },
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      ...[creatorAgentId, recipientAgentId].map(principalId => ({
        companyId,
        principalType: "agent" as const,
        principalId,
        membershipRole: "member",
        status: "active",
      })),
    ]);
    await db.insert(principalPermissionGrants).values(PERMISSION_KEYS.map(permissionKey => ({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey,
    })));
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "REST-created addressed confirmation",
      status: "todo",
      workMode: "standard",
      responsibleUserId: userId,
    }).returning();
    if (!issue) throw new Error("Missing interaction test issue");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: creatorAgentId,
      status: "running",
      runtimeMode: "native",
      issueId: issue.id,
      nativeIssueId: issue.id,
      scopeKind: "issue",
      responsibleUserId: userId,
      contextSnapshot: { issueId: issue.id },
    });
    const token = createLocalAgentJwt(creatorAgentId, companyId, "paperclip_runner", runId, userId);
    if (!token) throw new Error("Local test run-JWT generation failed");

    const storage = createStorageService(createLocalDiskStorageProvider(join(temporary.home, "storage")));
    app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      bindHost: "127.0.0.1",
      allowedHostnames: ["127.0.0.1"],
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: false,
      managedPluginAutoInstall: [],
      localPluginDir: join(temporary.home, "plugins"),
      storageService: storage,
      decisionServiceOptions: { wakeOriginAgent: async () => null },
    });
    await app.locals.bundledPluginsStartup;
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback HTTP address");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const prompt = "Confirm this independently reviewed proposal?";
    const postResponse = await fetch(`${apiUrl}/api/issues/${issue.id}/interactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "request_confirmation",
        title: "Independent review confirmation",
        summary: "Confirm the proposal through the issue thread.",
        resolverPolicy: "not_creator",
        addresseeAgentId: recipientAgentId,
        continuationPolicy: "none",
        payload: { version: 1, prompt, rejectRequiresReason: true },
      }),
    });
    const postText = await postResponse.text();
    expect(postResponse.status, postText).toBe(201);
    const created = JSON.parse(postText) as { id: string };
    expect(created.id).toEqual(expect.any(String));

    const getResponse = await fetch(`${apiUrl}/api/issues/${issue.id}/interactions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const getText = await getResponse.text();
    expect(getResponse.status, getText).toBe(200);
    const interactions = JSON.parse(getText) as Array<Record<string, unknown>>;
    const persisted = interactions.find(interaction => interaction.id === created.id);
    expect(persisted).toMatchObject({
      id: created.id,
      companyId,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "pending",
      addresseeAgentId: recipientAgentId,
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
      createdByAgentId: creatorAgentId,
      createdByUserId: null,
      sourceRunId: runId,
    });
  } finally {
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
