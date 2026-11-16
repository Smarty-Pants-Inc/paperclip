// INT-R3: secret removal takes FOR UPDATE NOWAIT on the company_secrets row. The
// deferred secret-resolution writer (1s-batched audit INSERTs, whose FK check takes
// KEY SHARE on that row, and lastResolvedAt UPDATEs) can hold a short lock on the same
// row right after a run used the secret. Three IMMEDIATE NOWAIT retries made a removal
// right after use fail spuriously with "Secret changed during removal. Retry removal."
// (tool-gateway reconnect/archive, 55P03). Removal now backs off between bounded
// attempts; a lock that outlives the bound still gets the same named conflict.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companySecrets, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let holderDb: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-r3-probe-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "r3-probe");
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
  database = await startEmbeddedPostgresTestDatabase("paperclip-r3-probe-");
  db = createDb(database.connectionString);
  holderDb = createDb(database.connectionString);
}, 90_000);

afterAll(async () => {
  await holderDb?.$client.end({ timeout: 1 });
  await db?.$client.end({ timeout: 1 });
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function seed() {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "R3 probe", issuePrefix: `R${companyId.slice(0, 6)}` });
  return secretService(db).create(companyId, { name: `r3-${companyId.slice(0, 6)}`, provider: "local_encrypted", value: "probe-value" });
}

async function holdRowLock(secretId: string, mode: "update" | "key-share", release: Promise<void>) {
  let locked!: () => void;
  const isLocked = new Promise<void>(done => { locked = done; });
  const holder = holderDb.$client.begin(async tx => {
    if (mode === "update") await tx`UPDATE company_secrets SET last_resolved_at = now() WHERE id = ${secretId}`;
    else await tx`SELECT id FROM company_secrets WHERE id = ${secretId} FOR KEY SHARE`;
    locked();
    await release;
  });
  await isLocked;
  return { holder };
}

describe("INT-R3 secret removal waits out a short concurrent row lock", () => {
  it("control: removal succeeds when no other transaction holds the row", async () => {
    const secret = await seed();
    await expect(secretService(db).remove(secret.id)).resolves.toMatchObject({ id: secret.id });
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toHaveLength(0);
  });

  it.each(["update", "key-share"] as const)("a short %s row lock held by another transaction (deferred touch / audit FK) does not fail the removal", async mode => {
    const secret = await seed();
    let holder: Promise<unknown> | undefined;
    const attempt = secretService(db).remove(secret.id, {
      beforeDelete: async () => {
        // Released 60 ms after the removal starts its NOWAIT attempts: a normal deferred write.
        // Returns once the other transaction HOLDS the lock, before any NOWAIT attempt.
        ({ holder } = await holdRowLock(secret.id, mode, new Promise(done => setTimeout(done, 60))));
      },
    });
    await expect(attempt).resolves.toMatchObject({ id: secret.id });
    await holder;
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toHaveLength(0);
  });

  it("a row lock that outlives the bounded backoff still returns the named retryable conflict", async () => {
    const secret = await seed();
    let release!: () => void;
    const released = new Promise<void>(done => { release = done; });
    let holder: Promise<unknown> | undefined;
    const attempt = secretService(db).remove(secret.id, {
      beforeDelete: async () => {
        let locked!: () => void;
        const isLocked = new Promise<void>(done => { locked = done; });
        // Same lock mode the deferred touch writer's UPDATE takes on this row.
        holder = holderDb.$client.begin(async tx => {
          await tx`UPDATE company_secrets SET last_resolved_at = now() WHERE id = ${secret.id}`;
          locked();
          await released;
        });
        await isLocked;
      },
    });
    await expect(attempt).rejects.toMatchObject({ message: "Secret changed during removal. Retry removal." });
    release();
    await holder;
    // The row survives in its deleted-marked state; an explicit later retry succeeds.
    const [marked] = await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id));
    expect(marked?.status).toBe("deleted");
    await expect(secretService(db).remove(secret.id)).resolves.toMatchObject({ id: secret.id });
    expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secret.id))).toHaveLength(0);
  });
});
