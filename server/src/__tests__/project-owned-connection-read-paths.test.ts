// #20717 RFL round 2 item 1: the ONE owned-resource read decision
// (canReadProjectOwnedConnectionDetails, keyed on the authenticated READER)
// applies to the RESOLVED row on the effective-profile projection and on UID
// aliases, exactly as on the collection and by-ID reads. Synthetic values only;
// assertions are booleans, nothing secret is printed.
import "./helpers/project-connections-approval-http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

const MARKER = "synthetic-private-config-marker";

describe("#20717 owned-connection read paths: effective profiles and UID aliases", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-projconn-read-paths-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function owned() {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a);
    const uid = `read-paths-${connection.id}`;
    await db.update(toolConnections).set({ uid, config: { ...connection.config, judgeConfigMarker: MARKER } }).where(eq(toolConnections.id, connection.id));
    return { f, connection, uid };
  }

  const shape = (row: Record<string, unknown> | undefined) => ({
    present: !!row, config: !!row?.config, marker: (row?.config as Record<string, unknown> | undefined)?.judgeConfigMarker === MARKER,
    transportConfig: !!row?.transportConfig, refs: Array.isArray(row?.credentialSecretRefs) && (row!.credentialSecretRefs as unknown[]).length > 0,
    redacted: row?.detailsRedacted === true, identity: !!row && typeof row.id === "string" && typeof row.name === "string" && "status" in row && "ownership" in row,
  });

  it("effective profiles for A's lead: another project's lead and an outsider see id/name/status/ownership only; board and A's lead see details", async () => {
    const { f, connection } = await owned();
    const read = async (who: string) => {
      const r = await request(f.route(who)).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${f.leadA.id}`);
      return { status: r.status, row: shape(r.body.installedConnections?.find((c: { id: string }) => c.id === connection.id)) };
    };
    for (const who of [f.leadB.id, f.outsider.id]) {
      const observed = await read(who);
      expect(observed.status).toBe(200);
      expect(observed.row).toEqual({ present: true, config: false, marker: false, transportConfig: false, refs: false, redacted: true, identity: true });
    }
    for (const who of ["board", f.leadA.id]) {
      const observed = await read(who);
      expect(observed.status).toBe(200);
      expect(observed.row).toMatchObject({ present: true, config: true, marker: true, redacted: false });
    }
  });

  it("UID alias: related reads are refused to another project's lead and an outsider exactly as by UUID; A's own lead, worker and company primary read through the alias", async () => {
    const { f, connection, uid } = await owned();
    for (const who of [f.leadB.id, f.outsider.id]) {
      const canonical = await request(f.route(who)).get(`/api/tool-connections/${connection.id}/grants`);
      const alias = await request(f.route(who)).get(`/api/tool-connections/${encodeURIComponent(uid)}/grants`);
      expect({ canonical: canonical.status, alias: alias.status, aliasGrants: !!alias.body.grants?.length }).toEqual({ canonical: 403, alias: 403, aliasGrants: false });
      const byId = await request(f.route(who)).get(`/api/tool-connections/${encodeURIComponent(uid)}`);
      expect(byId.status).toBe(200);
      expect(shape(byId.body)).toMatchObject({ config: false, marker: false, refs: false, redacted: true, identity: true });
    }
    for (const who of ["board", f.leadA.id, f.worker.id, f.primary.id]) {
      const alias = await request(f.route(who)).get(`/api/tool-connections/${encodeURIComponent(uid)}/grants`);
      expect({ who: who === "board" ? who : "agent", status: alias.status, grants: !!alias.body.grants?.length })
        .toEqual({ who: who === "board" ? who : "agent", status: 200, grants: true });
    }
  });
});
