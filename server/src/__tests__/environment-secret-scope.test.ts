import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecrets,
  createDb,
  plugins,
  projects,
  userSecretDefinitions,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping environment secret scope tests: ${support.reason}`);

// Keep: a trust boundary and data safety. Runtime refusal is not enough:
// environment configuration must never persist a non-company secret binding.
(support.supported ? describe : describe.skip)("environment config secret binding scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let companySecretId: string;
  let instanceSecretId: string;
  let userSecretId: string;
  let agentSecretId: string;
  let ownerAgentId: string;
  let ownerProjectId: string;
  let ownerPluginId: string;
  let otherPluginId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("environment-secret-scope-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();
    ownerAgentId = randomUUID();
    ownerProjectId = projectId;
    ownerPluginId = pluginId;
    otherPluginId = randomUUID();
    const definitionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Environment scope fixture", issuePrefix: "ESC" });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: pluginId, packageName: "environment-scope-fixture", version: "1.0.0", status: "ready",
      manifestJson: {
        id: pluginId, apiVersion: 1, version: "1.0.0", displayName: "Environment scope fixture",
        description: "Owns the project instance secret used by this regression test", author: "Paperclip",
        categories: ["connector"], entrypoints: { worker: "fixture.js" },
        resourceLifecycle: ["project"], capabilities: ["events.subscribe", "projects.instance-secrets"],
      },
    });
    await db.insert(plugins).values({
      id: otherPluginId, pluginKey: otherPluginId, packageName: "other-scope-fixture", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true } as never,
    });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Agent secret owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Plugin secret owner" });
    await db.insert(userSecretDefinitions).values({ id: definitionId, companyId, key: "user_key", name: "User key" });
    // Binding validation only needs metadata; no provider values are read or mocked.
    const [company, instance, user, agent] = await db.insert(companySecrets).values([
      { companyId, key: "company_key", name: "Company key", scope: "company" },
      { companyId, key: "instance_key", name: "Instance key", scope: "instance", ownerPluginId: pluginId, ownerProjectId: projectId },
      { companyId, key: "user_key", name: "User key", scope: "user", ownerUserId: "scope-fixture-user", userSecretDefinitionId: definitionId },
      { companyId, key: "agent_key", name: "Agent key", scope: "instance", ownerPluginId: pluginId, ownerAgentId },
    ]).returning();
    companySecretId = company.id;
    instanceSecretId = instance.id;
    userSecretId = user.id;
    agentSecretId = agent.id;
  }, 90_000);

  afterAll(async () => { await database?.cleanup(); });

  function bindings(targetId: string, targetType: "environment" | "agent" | "project" = "environment") {
    return db.select().from(companySecretBindings).where(and(
      eq(companySecretBindings.targetType, targetType),
      eq(companySecretBindings.targetId, targetId),
    ));
  }

  it.each(["instance", "user"] as const)("refuses %s secrets before writing any environment binding", async (scope) => {
    const svc = secretService(db);
    const secretId = scope === "instance" ? instanceSecretId : userSecretId;
    // Exercise both the helper-owned transaction and the caller-owned executor
    // used by environment creation/update. Catch inside the latter so a rollback
    // cannot hide a write that happened before validation failed.
    for (const callerTransaction of [false, true]) {
      const target = { targetType: "environment" as const, targetId: randomUUID() };
      const before = await bindings(target.targetId);
      expect(before).toHaveLength(0);
      const refs = [
        { secretId: companySecretId, configPath: "validApiKey" },
        { secretId, configPath: "privateApiKey" },
      ];
      const attempt = async (executor?: Parameters<typeof svc.replaceSecretRefsForInstanceTarget>[2]) => {
        const error = await svc.replaceSecretRefsForInstanceTarget(target, refs, executor).then(
          () => null,
          (failure: unknown) => failure,
        );
        expect.soft(error).toMatchObject({ status: 422, message: "Secret references require company-scoped secrets" });
      };
      if (callerTransaction) {
        await db.transaction(async (tx) => { await attempt({ db: tx }); });
      } else {
        await attempt();
      }
      const after = await bindings(target.targetId);
      expect.soft(after, `${scope}, callerTransaction=${callerTransaction}: no rows may be written`).toHaveLength(before.length);
      expect.soft(after).toEqual(before);
    }
  });

  function owner(targetType: "agent" | "project", pluginId = ownerPluginId) {
    return targetType === "agent"
      ? { agentId: ownerAgentId, pluginId }
      : { projectId: ownerProjectId, pluginId };
  }

  it.each(["agent", "project"] as const)("refuses %s config bindings to another owner's instance secret", async (targetType) => {
    const targetId = randomUUID();
    const instanceOwner = targetType === "agent"
      ? { agentId: targetId, pluginId: ownerPluginId }
      : { projectId: targetId, pluginId: ownerPluginId };
    await expectPrivateBindingRefused(targetType, targetId, targetType === "agent" ? agentSecretId : instanceSecretId, instanceOwner);
  });

  it.each(["agent", "project"] as const)("refuses another %s target even with the secret owner's full context", async (targetType) => {
    await expectPrivateBindingRefused(targetType, randomUUID(),
      targetType === "agent" ? agentSecretId : instanceSecretId, owner(targetType));
  });

  it.each(["agent", "project"] as const)("refuses a %s target using the other owner kind, even with a matching id", async (targetType) => {
    const otherType = targetType === "agent" ? "project" : "agent";
    await expectPrivateBindingRefused(targetType, otherType === "agent" ? ownerAgentId : ownerProjectId,
      otherType === "agent" ? agentSecretId : instanceSecretId, owner(otherType));
  });

  it.each(["agent", "project"] as const)("refuses %s config bindings for another plugin, even on the owning target", async (targetType) => {
    await expectPrivateBindingRefused(targetType, targetType === "agent" ? ownerAgentId : ownerProjectId,
      targetType === "agent" ? agentSecretId : instanceSecretId, owner(targetType, otherPluginId));
  });

  it.each(["agent", "project"] as const)("refuses ordinary %s config bindings without private owner context", async (targetType) => {
    await expectPrivateBindingRefused(targetType, targetType === "agent" ? ownerAgentId : ownerProjectId,
      targetType === "agent" ? agentSecretId : instanceSecretId);
  });

  it.each(["agent", "project"] as const)("refuses user-scoped secrets in %s config even with instance owner context", async (targetType) => {
    await expectPrivateBindingRefused(targetType, randomUUID(), userSecretId, owner(targetType));
  });

  it("never binds an instance secret to an environment, even with matching owner context and target id", async () => {
    await expectPrivateBindingRefused("environment", ownerAgentId, agentSecretId, owner("agent"));
  });

  async function expectPrivateBindingRefused(
    targetType: "environment" | "agent" | "project", targetId: string, secretId: string,
    instanceOwner?: { agentId: string; pluginId: string } | { projectId: string; pluginId: string },
  ) {
    const svc = secretService(db);
    for (const callerTransaction of [false, true]) {
      // Start with a legitimate row so refusal must preserve existing bindings,
      // as well as avoid inserting the valid first ref in the rejected batch.
      const target = { targetType, targetId };
      await svc.replaceSecretRefsForInstanceTarget(target, [{ secretId: companySecretId, configPath: "existingKey" }]);
      const before = await bindings(targetId, targetType);
      const attempt = async (executor?: Parameters<typeof svc.replaceSecretRefsForInstanceTarget>[2]) => {
        const options = { ...executor, instanceOwner };
        const error = await svc.replaceSecretRefsForInstanceTarget(target, [
          { secretId: companySecretId, configPath: "validApiKey" },
          { secretId, configPath: "privateApiKey" },
        ], options).then(() => null, (failure: unknown) => failure);
        expect.soft(error).toMatchObject({ status: 422, message: "Secret references require company-scoped secrets" });
      };
      if (callerTransaction) await db.transaction(async (tx) => { await attempt({ db: tx }); });
      else await attempt();
      expect.soft(await bindings(targetId, targetType), `callerTransaction=${callerTransaction}: preserve rows`).toEqual(before);
    }
  }

  it.each(["agent", "project"] as const)("allows an instance secret bound to its exact %s and plugin owner", async (targetType) => {
    const svc = secretService(db);
    const target = { targetType, targetId: targetType === "agent" ? ownerAgentId : ownerProjectId };
    const secretId = targetType === "agent" ? agentSecretId : instanceSecretId;
    for (const callerTransaction of [false, true]) {
      const options = { instanceOwner: owner(targetType) };
      const refs = [{ secretId, configPath: "privateApiKey" }];
      const result = callerTransaction
        ? await db.transaction((tx) => svc.replaceSecretRefsForInstanceTarget(target, refs, { ...options, db: tx }))
        : await svc.replaceSecretRefsForInstanceTarget(target, refs, options);
      expect(result).toMatchObject([{ companyId, secretId }]);
      const rows = await bindings(target.targetId, targetType);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ...target, companyId, secretId, configPath: "privateApiKey" });
    }
  });

  it("still binds company secrets with the existing metadata in both executor modes", async () => {
    const svc = secretService(db);
    for (const callerTransaction of [false, true]) {
      const target = { targetType: "environment" as const, targetId: randomUUID() };
      expect(await bindings(target.targetId)).toHaveLength(0);
      const refs = [{ secretId: companySecretId, configPath: "apiKey", versionSelector: 1 as const, required: false, label: "Provider key" }];
      const normalized = callerTransaction
        ? await db.transaction((tx) => svc.replaceSecretRefsForInstanceTarget(target, refs, { db: tx }))
        : await svc.replaceSecretRefsForInstanceTarget(target, refs);
      expect(normalized).toEqual([{
        ...refs[0], companyId, projectionClass: "unclassified", projectionAllowlistKey: null,
      }]);
      const rows = await bindings(target.targetId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        companyId, secretId: companySecretId, ...target, configPath: "apiKey",
        versionSelector: "1", required: false, label: "Provider key",
        projectionClass: "unclassified", projectionAllowlistKey: null,
      });
    }
  });
});
