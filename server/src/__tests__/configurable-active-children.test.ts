import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("configured active child limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("configured-active-children-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // Keep: data-safety boundary, including terminal-child exclusion and the exact refusal.
  it.each([
    [undefined, 25], ["", 25], ["invalid", 25], ["0", 25], ["-1", 25],
    ["1.5", 25], ["9007199254740992", 25], [" 30 ", 30],
  ] as const)("enforces %s at its own boundary, not the former cap", async (raw, limit) => {
    vi.stubEnv("PAPERCLIP_MAX_ACTIVE_CHILD_ISSUES", raw);
    const companyId = randomUUID(), parentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Child limits", issuePrefix: companyId.slice(0, 8) });
    await db.insert(issues).values({ id: parentId, companyId, title: "Parent", status: "todo" });
    await db.insert(issues).values(Array.from({ length: limit - 1 }, (_, n) => ({
      companyId, parentId, title: `Active ${n}`, status: "todo" as const,
    })));
    await db.insert(issues).values([
      { companyId, parentId, title: "Finished", status: "done" },
      { companyId, parentId, title: "Cancelled", status: "cancelled" },
    ]);
    const service = issueService(db);
    const final = await service.createChild(parentId, { title: "Last allowed child", status: "todo" });
    expect(final.issue.parentId).toBe(parentId);
    await expect(service.createChild(parentId, { title: "Over cap", status: "todo" })).rejects.toMatchObject({
      status: 422, message: `Parent issue already has the maximum ${limit} active child issues for this helper`,
    });
  });
});
