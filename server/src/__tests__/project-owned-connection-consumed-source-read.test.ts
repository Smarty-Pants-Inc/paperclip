// #20717 RFL round 3 item 1: the archived, CONSUMED project-App approval
// source still carries the same vault reference as the connection it became.
// Its details follow projectAppApprovalConsumedBy through the ONE shared
// owned-resource read decision (canReadProjectOwnedConnectionDetails): only a
// reader of the resulting connection reads them; everyone else sees identity
// only (GET-by-ID, collection) or the target's 403 (related reads). Genuine
// approval (board-session route) then a native receipt-citing first bind.
// Synthetic values only; assertions are value-free booleans and statuses.
import "./helpers/project-connections-approval-http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createDb, toolConnections } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { storedConnection } from "./helpers/project-connections-fixture.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

describe("#20717 consumed approval source: details follow the connection it became", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-projconn-consumed-source-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  const shape = (row: Record<string, unknown> | undefined) => ({
    present: !!row, config: !!row?.config, transportConfig: !!row?.transportConfig,
    refs: Array.isArray(row?.credentialSecretRefs) && (row!.credentialSecretRefs as unknown[]).length > 0,
    redacted: row?.detailsRedacted === true,
  });

  it("another project's lead and an outsider get no config or vault reference from the consumed source on any read path; the resulting connection's owner and the board still read it", async () => {
    const f = await projectConnectionFixture(db);
    const { sourceId } = await f.approve(f.a);
    const created = await f.service.createConnection(f.companyId, f.input(f.a), f.actor());
    const source = await storedConnection(db, sourceId);
    expect({ status: source.status, consumedBy: source.config.projectAppApprovalConsumedBy === created.id, refs: source.credentialSecretRefs.length > 0 })
      .toEqual({ status: "archived", consumedBy: true, refs: true });

    for (const who of [f.leadB.id, f.outsider.id]) {
      const byId = await request(f.route(who)).get(`/api/tool-connections/${sourceId}`);
      const leaked = byId.status === 200 && (shape(byId.body).config || shape(byId.body).refs || shape(byId.body).transportConfig);
      expect.soft({ byIdLeaked: leaked, byIdOk: byId.status === 200 ? shape(byId.body).redacted : byId.status === 403 }).toEqual({ byIdLeaked: false, byIdOk: true });
      const list = await request(f.route(who)).get(`/api/companies/${f.companyId}/tools/connections`);
      const listed = shape((list.body.connections as Record<string, unknown>[] | undefined)?.find(row => row.id === sourceId));
      expect.soft({ listLeaked: listed.config || listed.refs || listed.transportConfig }).toEqual({ listLeaked: false });
      const grants = await request(f.route(who)).get(`/api/tool-connections/${sourceId}/grants`);
      expect.soft({ grantsStatus: grants.status, grants: !!grants.body?.grants?.length }).toEqual({ grantsStatus: 403, grants: false });
      // Same answer as the connection it became.
      const target = await request(f.route(who)).get(`/api/tool-connections/${created.id}/grants`);
      expect.soft(target.status).toBe(403);
    }

    for (const who of ["board", f.leadA.id, f.primary.id]) {
      const byId = await request(f.route(who)).get(`/api/tool-connections/${sourceId}`);
      expect({ who: who === "board" ? who : "agent", status: byId.status, ...shape(byId.body) })
        .toMatchObject({ who: who === "board" ? who : "agent", status: 200, present: true, config: true, refs: true, redacted: false });
    }
  });

  // #20717 RFL round 4: the follow may only NARROW. Even a MUTUAL, UNIQUE link
  // from an A-owned row to a B-owned consumer keeps A's own audience as a
  // floor: B's lead (reads B, not A) and A's lead (reads A, not B) both stay
  // redacted; only a reader of BOTH rows (the company primary) and the board read.
  it("a mutual unique consumed-by link on an owned row is AND-ed with the row's own decision, never OR-ed or replaced", async () => {
    const f = await projectConnectionFixture(db);
    const a = (await f.seedConnection(f.a)).connection;
    const b = (await f.seedConnection(f.b)).connection;
    await db.update(toolConnections).set({ config: { ...a.config, projectAppApprovalConsumedBy: b.id }, transportConfig: { ...a.transportConfig, projectAppApprovalConsumedBy: b.id } }).where(eq(toolConnections.id, a.id));
    await db.update(toolConnections).set({ config: { ...b.config, projectAppApprovalSourceId: a.id }, transportConfig: { ...b.transportConfig, projectAppApprovalSourceId: a.id } }).where(eq(toolConnections.id, b.id));
    const read = async (who: string) => {
      const r = await request(f.route(who)).get(`/api/tool-connections/${a.id}`);
      const s = shape(r.body);
      return { status: r.status, details: s.config || s.refs || s.transportConfig };
    };
    expect.soft({ leadB: await read(f.leadB.id) }).toEqual({ leadB: { status: 200, details: false } });
    expect.soft({ leadA: await read(f.leadA.id) }).toEqual({ leadA: { status: 200, details: false } });
    expect.soft({ primary: await read(f.primary.id) }).toEqual({ primary: { status: 200, details: true } });
    expect.soft({ board: await read("board") }).toEqual({ board: { status: 200, details: true } });
  });
});
