import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { projectConnectionRunSnapshot } from "../services/project-connection-run-context.js";

// Data safety: the registry already locks and reads the complete run snapshot.
// Repeated/concurrent registration must preserve its immutable admission pair,
// every unrelated field and all registered values without a second SQL wrapper.
describe("project admission pair across row-locked secret registration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("project-redaction-registration-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    vi.unstubAllEnvs();
  });

  it("concurrent and replayed registrations retain the DB-owned pair and every encrypted entry", async () => {
    const f = await projectConnectionFixture(db);
    const bound = await f.run(f.a, f.leadA.id, { retainedContext: { message: "keep this field" } });
    const original = bound.run.contextSnapshot!;
    const registry = createRunSecretRedactionRegistry(db);
    const values = ["synthetic-first-registration-12345", "synthetic-second-registration-67890"];
    await Promise.all(values.map(value => registry.register(f.companyId, bound.run.id, value)));
    await registry.register(f.companyId, bound.run.id, values[0]!);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, bound.run.id));
    expect(saved!.contextSnapshot!.projectConnectionRunContext).toEqual(original.projectConnectionRunContext);
    expect(saved!.contextSnapshot!.retainedContext).toEqual(original.retainedContext);
    expect(saved!.contextSnapshot!.paperclipSecretRedactions).toHaveLength(2);
    expect(JSON.stringify(saved!.contextSnapshot)).not.toContain(values[0]);
    expect(JSON.stringify(saved!.contextSnapshot)).not.toContain(values[1]);
    expect(await registry.redactForRun(f.companyId, bound.run.id, { text: values.join(" / ") }))
      .toEqual({ text: "***REDACTED*** / ***REDACTED***" });
  });

  it("registration after a protected snapshot replacement retains the original pair, not its caller hint", async () => {
    const f = await projectConnectionFixture(db);
    const bound = await f.run();
    await db.update(heartbeatRuns).set({ contextSnapshot: projectConnectionRunSnapshot({
      afterReplacement: true,
      projectConnectionRunContext: { version: 1, issueId: null, projectId: null },
    }) }).where(eq(heartbeatRuns.id, bound.run.id));
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(f.companyId, bound.run.id, "synthetic-post-replacement-secret-12345");
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, bound.run.id));
    expect(saved!.contextSnapshot!.projectConnectionRunContext).toEqual(bound.run.contextSnapshot!.projectConnectionRunContext);
    expect(saved!.contextSnapshot!.afterReplacement).toBe(true);
    expect(saved!.contextSnapshot!.paperclipSecretRedactions).toHaveLength(1);
  });
});
