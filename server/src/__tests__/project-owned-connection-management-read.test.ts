// RFL #20717 finding 1: a project-owned connection's config and secret
// references are readable ONLY by its own project's team, the company owner
// (board session, or the owner's current primary agent) and the board.
// Everyone else, including another project's lead holding
// tools:manage_connections on behalf of the owner, sees id / name / status /
// ownership on the collection and GET-by-ID, and is refused on every other
// per-connection read (grants carry vault references). Synthetic values only.
import "./helpers/project-connections-approval-http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

const OWNED_CODE = "project_connection_not_supported_by_this_server";
const MARKER = "synthetic-private-config-marker";
const REDACTED_KEYS = ["companyId", "detailsRedacted", "id", "name", "ownership", "projectId", "status"];

describe("project-owned connection management reads (#20717 RFL finding 1)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-projconn-mgmt-read-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function seeded() {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a);
    await db.update(toolConnections).set({ config: { ...connection.config, judgeConfigMarker: MARKER }, healthStatus: "error" })
      .where(eq(toolConnections.id, connection.id));
    const { connection: company } = await f.seedConnection(null);
    return { f, owned: connection, company };
  }

  const read = async (f: Awaited<ReturnType<typeof seeded>>["f"], who: string, id: string) => ({
    listed: (await request(f.route(who)).get(`/api/companies/${f.companyId}/tools/connections`)).body.connections as Record<string, unknown>[],
    single: await request(f.route(who)).get(`/api/tool-connections/${id}`),
  });

  it("another project's lead and team see only id/name/status/ownership; related reads are refused by name", async () => {
    const { f, owned, company } = await seeded();
    for (const who of [f.leadB.id, f.outsider.id]) {
      const { listed, single } = await read(f, who, owned.id);
      const row = listed.find(r => r.id === owned.id);
      expect(row && Object.keys(row).sort()).toEqual(REDACTED_KEYS);
      expect(row).toMatchObject({ id: owned.id, projectId: f.a.id, name: owned.name, status: "active", ownership: owned.ownership, detailsRedacted: true });
      expect(single.status).toBe(200);
      expect(Object.keys(single.body).sort()).toEqual(REDACTED_KEYS);
      expect(JSON.stringify([row, single.body])).not.toContain(MARKER);
      for (const path of ["grants", "installs", "usage", "catalog"]) {
        const related = await request(f.route(who)).get(`/api/tool-connections/${owned.id}/${path}`);
        expect({ path, status: related.status, code: related.body.details?.code ?? related.body.code }).toEqual({ path, status: 403, code: OWNED_CODE });
      }
      const attention = await request(f.route(who)).get(`/api/companies/${f.companyId}/tools/apps/attention`);
      expect(JSON.stringify(attention.body)).not.toContain(MARKER);
      // An ordinary company row is unchanged for them.
      expect(listed.find(r => r.id === company.id)).toMatchObject({ config: expect.any(Object), credentialSecretRefs: [expect.any(Object)] });
    }
  });

  it("the own team, the company primary and the board still read config and vault references", async () => {
    const { f, owned } = await seeded();
    for (const who of ["board", f.leadA.id, f.worker.id, f.primary.id]) {
      const { listed, single } = await read(f, who, owned.id);
      const row = listed.find(r => r.id === owned.id) as { config?: Record<string, unknown>; credentialSecretRefs?: unknown[] } | undefined;
      expect({ who, marker: row?.config?.judgeConfigMarker, refs: row?.credentialSecretRefs?.length })
        .toEqual({ who, marker: MARKER, refs: 1 });
      expect({ who, status: single.status, marker: single.body.config?.judgeConfigMarker }).toEqual({ who, status: 200, marker: MARKER });
      const grants = await request(f.route(who)).get(`/api/tool-connections/${owned.id}/grants`);
      expect({ who, status: grants.status }).toEqual({ who, status: 200 });
    }
  });
});
