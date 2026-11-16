import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySecrets, createDb, secretAccessEvents } from "@paperclipai/db";
import { enqueueSecretAccessEvent, flushSecretResolutionWrites } from "../services/secret-resolution-writes.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Deterministic version of gateway afterEach's old deletion window: explicitly
// release the real deferred audit queue at that window, never a timing sleep or
// mocked SQL error. No gateway assertion is changed to obtain this proof.
describe("INT-R3 gateway fixture cleanup ordering", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-gateway-cleanup-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (db) await flushSecretResolutionWrites(db);
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
  }, 60_000);
  async function queued() {
    const [company] = await db.insert(companies).values({ name: "Queued gateway audit", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId: company!.id, key: randomUUID(), name: "Synthetic metadata only" }).returning();
    await enqueueSecretAccessEvent(db, { companyId: company!.id, secretId: secret!.id, provider: "local_encrypted", actorType: "system", consumerType: "test", consumerId: "gateway-cleanup", outcome: "allowed" });
    return { company: company!, secret: secret! };
  }
  it("old order deterministically reinserts a null-secret audit and blocks company deletion with23503", async () => {
    const f = await queued();
    try {
      await db.delete(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.company.id));
      await db.delete(companySecrets).where(eq(companySecrets.id, f.secret.id));
      await flushSecretResolutionWrites(db);
      const audits = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.company.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ companyId: f.company.id, secretId: null, consumerId: "gateway-cleanup" });
      await expect(db.delete(companies).where(eq(companies.id, f.company.id))).rejects.toMatchObject({ cause: { code: "23503", constraint_name: "secret_access_events_company_id_companies_id_fk" } });
    } finally {
      await db.delete(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.company.id));
      await db.delete(companies).where(eq(companies.id, f.company.id));
    }
  });
  it("settling the real audit queue before fixture deletes leaves no child to race parent removal", async () => {
    const f = await queued();
    await flushSecretResolutionWrites(db);
    await db.delete(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.company.id));
    await db.delete(companySecrets).where(eq(companySecrets.id, f.secret.id));
    await db.delete(companies).where(eq(companies.id, f.company.id));
    expect(await db.select().from(companies).where(eq(companies.id, f.company.id))).toHaveLength(0);
    expect(await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.companyId, f.company.id))).toHaveLength(0);
  });
});
