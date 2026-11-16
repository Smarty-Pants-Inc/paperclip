import "./project-connections-approval-http.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { companySecrets, plugins, projects, type Db } from "@paperclipai/db";
import { toolAccessRoutes } from "../../routes/tool-access.js";
import { pluginRoutes } from "../../routes/plugins.js";
import { errorHandler } from "../../middleware/index.js";
import { ROW12_INSTALLER_PLUGIN_KEY } from "../../services/project-app-custody.js";
import { secretService } from "../../services/secrets.js";
import { projectConnectionFixture as seedFixture } from "./project-connections-fixture.js";

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
// Isolated fixture encryption material, not an instance or provider credential.
process.env.PAPERCLIP_SECRETS_MASTER_KEY ??= randomBytes(32).toString("base64");
const setup = new WeakMap<Fixture, Promise<void>>();

function sessionApp(db: Db, f: Fixture) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", sessionId: f.companyId, userId: f.human, isInstanceAdmin: true,
      companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }] };
    next();
  });
  app.use("/api", toolAccessRoutes(db)); app.use("/api", pluginRoutes(db, {} as never)); app.use(errorHandler);
  return app;
}

/** C4 config and the approval receipt are written ONLY through their native
 * board-session routes. W1 fixture metadata is not a receipt or a C4 config. */
export async function approveProjectFixture(db: Db, f: Fixture, project = f.a, installationId = "456") {
  let ready = setup.get(f);
  if (!ready) {
    ready = (async () => {
      await secretService(db).rotate(f.secret.id, { value: key });
      await db.insert(plugins).values({ pluginKey: ROW12_INSTALLER_PLUGIN_KEY, packageName: "@paperclipai/plugin-row12-installer", version: "0.1.0", status: "ready",
        manifestJson: { id: ROW12_INSTALLER_PLUGIN_KEY, capabilities: ["projects.instance-secrets"], instanceSecretKeys: ["manager_private_key"] } as never }).onConflictDoNothing();
      const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, ROW12_INSTALLER_PLUGIN_KEY));
      const [anchor] = await db.insert(projects).values({ companyId: f.companyId, name: "github-manager-key" }).returning();
      await db.insert(companySecrets).values({ companyId: f.companyId, key: "manager_private_key", name: "W1 fixture anchor", scope: "instance", ownerPluginId: plugin!.id, ownerProjectId: anchor!.id });
      const config = await request(sessionApp(db, f)).post(`/api/plugins/${plugin!.id}/config`).send({ companyId: f.companyId,
        configJson: { managerAppId: "999", managerKeyAnchorProjectId: anchor!.id } });
      if (config.status !== 200) throw new Error(`Genuine C4 session config failed: ${config.status} ${JSON.stringify(config.body)}`);
    })();
    setup.set(f, ready);
  }
  await ready;
  const input = f.input(project); input.projectId = null;
  input.config = { ...input.config, methodConfig: { ...f.config(project).methodConfig, installationId } };
  const source = await request(sessionApp(db, f)).post(`/api/companies/${f.companyId}/tools/connections`).send(input);
  if (source.status !== 201) throw new Error(`Genuine source creation failed: ${source.status} ${JSON.stringify(source.body)}`);
  const approval = await request(sessionApp(db, f)).post(`/api/companies/${f.companyId}/tools/connections/${source.body.id}/project-app-approval`)
    .set("Origin", "http://127.0.0.1").send({ action: "approve", projectId: project.id });
  if (approval.status !== 200) throw new Error(`Genuine H-session approval failed: ${approval.status} ${JSON.stringify(approval.body)}`);
  return { sourceId: source.body.id as string, applicationId: source.body.applicationId as string };
}

/** Opt-in wrapper: the old shared fixture remains untouched for custody REDs.
 * Seeded owned rows receive real, server-written approval preconditions. */
export async function projectConnectionFixture(db: Db, sharedLead = false) {
  const f = await seedFixture(db, sharedLead);
  const approved = new Map<string, ReturnType<typeof approveProjectFixture>>();
  return { ...f, approve: (project = f.a, installationId = "456") => {
    const id = `${project.id}:${installationId}`;
    if (!approved.has(id)) approved.set(id, approveProjectFixture(db, f, project, installationId));
    return approved.get(id)!;
  }, seedConnection: async (...args: Parameters<typeof f.seedConnection>) => {
    const project = args[0] === undefined ? f.a : args[0];
    if (project) {
      const installationId = args[1]?.installationKey?.split("/").at(-1) ?? "456";
      const id = `${project.id}:${installationId}`;
      if (!approved.has(id)) approved.set(id, approveProjectFixture(db, f, project, installationId));
      await approved.get(id);
    }
    return f.seedConnection(...args);
  } };
}
