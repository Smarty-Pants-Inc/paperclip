import request from "supertest";
import { eq } from "drizzle-orm";
import { companySecrets, pluginConfig, plugins, projects, type Db, type toolConnections } from "@paperclipai/db";
import { projectConnectionFixture, storedConnection } from "./project-connections-fixture.js";

type Fixture = Awaited<ReturnType<typeof projectConnectionFixture>>;

/** Required native C4 manager-classifier fixture, containing metadata only.
 * No manager private-key value is manufactured, resolved or exported. */
export async function provisionFixtureCustodyManager(db: Db, f: Fixture) {
  const pluginKey = "paperclipai.plugin-row12-installer";
  await db.insert(plugins).values({ pluginKey, packageName: "@paperclipai/plugin-row12-installer", version: "0.1.0", status: "ready",
    manifestJson: { id: pluginKey, capabilities: ["projects.instance-secrets"], instanceSecretKeys: ["manager_private_key"] } as never,
  }).onConflictDoNothing();
  const [plugin] = await db.select().from(plugins).where(eq(plugins.pluginKey, pluginKey));
  if (!plugin) throw new Error("Custody setup requires the native manager plugin row");
  const [anchor] = await db.insert(projects).values({ companyId: f.companyId, name: "github-manager-key" }).returning();
  await db.insert(companySecrets).values({ companyId: f.companyId, key: "manager_private_key", name: "Manager key metadata only", scope: "instance", ownerPluginId: plugin.id, ownerProjectId: anchor!.id });
  await db.insert(pluginConfig).values({ pluginId: plugin.id, companyId: f.companyId, configJson: { managerAppId: "999", managerKeyAnchorProjectId: anchor!.id } });
}

/** Real session route, vault, provider seam, receipt and atomic activity.
 * Reuses the existing null-owned legacy source: no extra connection/application/
 * grant changes the frozen make-before-break rollback/count expectations. */
export async function approveFixtureCustodySource(db: Db, f: Fixture, source: { connection: typeof toolConnections.$inferSelect }) {
  await provisionFixtureCustodyManager(db, f);
  const approved = await request(f.route()).post(`/api/companies/${f.companyId}/tools/connections/${source.connection.id}/project-app-approval`)
    .set("Origin", "http://127.0.0.1").send({ action: "approve", projectId: f.a.id });
  if (approved.status !== 200) throw new Error(`Custody fixture approval failed (${approved.status}): ${JSON.stringify(approved.body)}`);
  // Keep the fixture's existing expected row snapshot current after its explicit
  // setup ceremony. The production comparison/assertion is not altered.
  Object.assign(source.connection, await storedConnection(db, source.connection.id));
}
