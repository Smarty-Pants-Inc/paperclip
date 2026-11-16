import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentIdentityKeys, agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentIdentityService } from "../services/agent-identity.js";
import { customerSuccessRunAuthority } from "../services/customer-success-authority.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";

// Trust boundary / data safety: exercise the real lifecycle transaction, migrated
// PostgreSQL storage, public HTTP projection and relying-party authorization.
describe("agent identity revocation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let directory: string;
  let companyId: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "paperclip-key-revocation-"));
    vi.stubEnv("PAPERCLIP_HOME", directory);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(directory, "master.key"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-revocation-test-secret");
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "identity-revocation-test");
    database = await startEmbeddedPostgresTestDatabase("paperclip-key-revocation-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Revocation", issuePrefix: "REV", defaultResponsibleUserId: "revocation-test-owner" }).returning();
    companyId = company.id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function fixture(provision = true) {
    const [agent] = await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    const identity = provision ? await agentIdentityService(db).ensureAgentIdentity(companyId, agent.id) : null;
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", startedAt: new Date() }).returning();
    const token = createLocalAgentJwt(agent.id, companyId, "process", run.id)!;
    return { agent, identity, token };
  }
  const identityRows = (id: string) => db.select().from(agentIdentityKeys).where(eq(agentIdentityKeys.agentId, id));
  const revocations = (id: string) => db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "agent.identity.revoked")));
  async function revokedAt(id: string) {
    // Raw SQL deliberately proves the migration, not just a projected JS field.
    const rows = await db.execute(sql`select revoked_at from agent_identity_keys where agent_id = ${id}`);
    return rows[0]?.revoked_at;
  }

  it("termination revokes the retained identity and audits keyId only, once", async () => {
    const { agent, identity } = await fixture();
    const [before] = await identityRows(agent.id);
    const lifecycle = createAgentLifecycle(db);
    const terminated = await lifecycle.terminateAgent(agent.id);
    expect(terminated?.status).toBe("terminated");
    const firstRevokedAt = await revokedAt(agent.id);
    expect(firstRevokedAt).toBeTruthy();
    expect(await identityRows(agent.id)).toEqual([{ ...before, revokedAt: expect.any(Date) }]);
    const events = await revocations(agent.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId, actorType: "system", entityType: "agent", details: { keyId: identity!.keyId } });
    expect(events[0].details).toEqual({ keyId: identity!.keyId });
    await lifecycle.terminateAgent(agent.id);
    expect(await revokedAt(agent.id)).toEqual(firstRevokedAt);
    expect(await revocations(agent.id)).toHaveLength(1);
  });

  it("GET identity exposes revokedAt without decrypting or losing the public key", async () => {
    const { agent, identity } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    const decrypt = vi.spyOn(localEncryptedProvider, "resolveVersion");
    try {
      const app = express();
      app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      const response = await request(app).get(`/api/agents/${agent.id}/identity`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ keyId: identity!.keyId, publicKeyPem: identity!.publicKeyPem, revokedAt: expect.any(String) });
      expect(new Date(response.body.revokedAt).toISOString()).toBe(response.body.revokedAt);
      expect(Object.keys(response.body).sort()).toEqual(["algorithm", "createdAt", "keyId", "publicKeyPem", "revokedAt"]);
      expect(decrypt).not.toHaveBeenCalled();
    } finally { decrypt.mockRestore(); }
  });

  it("ensure refuses a revoked identity by name, before decrypting, and never reissues it", async () => {
    const { agent } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    const before = await identityRows(agent.id);
    const decrypt = vi.spyOn(localEncryptedProvider, "resolveVersion");
    const encrypt = vi.spyOn(localEncryptedProvider, "createSecret");
    try {
      await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toMatchObject({ name: "AgentIdentityRevokedError", message: "Agent identity key is revoked" });
      // Even an erroneously restored status must not make a revoked key usable.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
      await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toMatchObject({ name: "AgentIdentityRevokedError" });
      expect(decrypt).not.toHaveBeenCalled();
      expect(encrypt).not.toHaveBeenCalled();
      expect(await identityRows(agent.id)).toEqual(before);
    } finally { decrypt.mockRestore(); encrypt.mockRestore(); }
  });

  // SUPERSEDED BY RFL F1 (11-16 05:59Z, #20832): the redaction path MUST still
  // build a redactor for a revoked key; every signing/minting use still refuses.
  it("log redactor resolution still builds for a revoked key (redaction only), while ensure refuses", async () => {
    const { agent } = await fixture();
    await createAgentLifecycle(db).terminateAgent(agent.id);
    const redactor = await agentIdentityService(db).createExistingLogRedactor(companyId, agent.id);
    expect(redactor.values.length).toBeGreaterThan(0);
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toMatchObject({ name: "AgentIdentityRevokedError" });
  });

  it("authority refuses the revoked key with its named reason, independent of agent status", async () => {
    const { agent, token } = await fixture();
    await expect(customerSuccessRunAuthority(db, token)).resolves.toMatchObject({ active: true });
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await expect(customerSuccessRunAuthority(db, token)).rejects.toMatchObject({ status: 403, message: "The agent identity key is revoked" });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
    await expect(customerSuccessRunAuthority(db, token)).rejects.toMatchObject({ status: 403, message: "The agent identity key is revoked" });
  });

  it("non-terminated agents retain their unchanged key, null revocation and active authority", async () => {
    const active = await fixture();
    const terminated = await fixture();
    const before = await identityRows(active.agent.id);
    await createAgentLifecycle(db).terminateAgent(terminated.agent.id);
    expect(await revokedAt(active.agent.id)).toBeNull();
    expect(await identityRows(active.agent.id)).toEqual(before);
    expect(await agentIdentityService(db).ensureAgentIdentity(companyId, active.agent.id)).toEqual(active.identity);
    expect(await revocations(active.agent.id)).toEqual([]);
    await expect(customerSuccessRunAuthority(db, active.token)).resolves.toMatchObject({ active: true, keyId: active.identity!.keyId });
  });

  it("never provisions a first identity after termination", async () => {
    const { agent } = await fixture(false);
    await createAgentLifecycle(db).terminateAgent(agent.id);
    await expect(agentIdentityService(db).ensureAgentIdentity(companyId, agent.id)).rejects.toMatchObject({ name: "AgentIdentityRevokedError" });
    expect(await identityRows(agent.id)).toEqual([]);
    expect(await revocations(agent.id)).toEqual([]);
  });

  it("rolls status and key revocation back together if the revocation audit fails", async () => {
    const { agent } = await fixture();
    const before = await identityRows(agent.id);
    await db.execute(sql`create function reject_identity_revocation_test() returns trigger language plpgsql as $$
      begin if new.action = 'agent.identity.revoked' then raise exception 'revocation audit unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger reject_identity_revocation_test before insert on activity_log for each row execute function reject_identity_revocation_test()`);
    try {
      await expect(createAgentLifecycle(db).terminateAgent(agent.id)).rejects.toMatchObject({
        cause: { message: "revocation audit unavailable" },
      });
      const [unchanged] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(unchanged.status).toBe("idle");
      expect(unchanged.lifecycleState).toBe("ready");
      expect(await identityRows(agent.id)).toEqual(before);
      expect(await revocations(agent.id)).toEqual([]);
    } finally {
      await db.execute(sql`drop trigger reject_identity_revocation_test on activity_log`);
      await db.execute(sql`drop function reject_identity_revocation_test()`);
    }
  });
});
