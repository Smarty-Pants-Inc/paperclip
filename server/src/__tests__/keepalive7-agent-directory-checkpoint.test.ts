import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, agentInstructionWorkingCopies, authUsers, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import * as checkpointsModule from "../services/agent-file-checkpoints.js";
import { withWorkspaceSourceLocks } from "../services/workspace-source-lock.js";

// pl/keepalive7: the real warm checkpoint, run inside a held source lock that is lost (and taken by another
// owner) while the first capture is in flight, takes NO further capture and writes NO fallback receipt.
describe("keepalive7 agent-directory checkpoint after an outer lock loss", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ka7-agent-directory-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("ka7-agent-directory-");
    db = createDb(database.connectionString);
    const [row] = await db.execute(sql`select current_database() as name`);
    await db.execute(sql.raw(`alter database "${row.name}" set idle_in_transaction_session_timeout = '3s'`));
  }, 120_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("KA7 AGENT CHECKPOINT: no second capture and no fallback receipt patch after the outer source lock is lost", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID();
    const entryFile = "INSTRUCTIONS.md";
    await db.insert(companies).values({ id: companyId, name: "KA7 agent dir", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Original\n");
    const copies = agentInstructionWorkingCopyService(db);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, warm: true }))!;
    await fs.writeFile(path.join(copy.localRoot, "edit.txt"), "changed in the run\n");
    const before = (await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId)))[0]!;

    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = checkpointsModule.captureAgentFileCheckpoint;
    let calls = 0, callsAfterLoss = 0, lost = false;
    const spy = vi.spyOn(checkpointsModule, "captureAgentFileCheckpoint").mockImplementation(async (...args) => {
      calls += 1; if (lost) callsAfterLoss += 1;
      const value = await capture(...args);
      if (calls === 1) { entered(); await gate; }
      return value;
    });
    const op = withWorkspaceSourceLocks(db, { companyId, issueIds: [issueId] },
      () => copies.checkpointWarm({ companyId, runId })).then(value => ({ value }), (error: unknown) => ({ error: String(error) }));
    try {
      await Promise.race([inside, op.then(x => { throw new Error(`early ${JSON.stringify(x)}`); })]);
      const key = `isolated_repository_source:${companyId}:${issueId}`;
      const owners = await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted
        and classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${key},0)&4294967295)`);
      expect(owners).toHaveLength(1);
      await db.execute(sql`select pg_terminate_backend(${owners[0]!.pid})`);
      expect(await db.transaction(async tx => (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`))[0]!.acquired)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 2_500));
      lost = true;
      release();
      const result = await op;
      // A dead outer connection can reject the caller early: give any late step time to land.
      await new Promise(resolve => setTimeout(resolve, 3_000));
      const after = (await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId)))[0]!;
      const proof = { calls, callsAfterLoss, result, before: { state: before.state, errorCode: before.errorCode, baseHash: before.baseHash },
        after: { state: after.state, errorCode: after.errorCode, baseHash: after.baseHash, updatedAtChanged: after.updatedAt.getTime() !== before.updatedAt.getTime() },
        canonicalEdit: await fs.readFile(path.join(root, "edit.txt"), "utf8").catch(() => null) };
      console.log("KA7_AGENT_CHECKPOINT", JSON.stringify(proof));
      if (process.env.TASK_OUT) await fs.writeFile(path.join(process.env.TASK_OUT, "ka7-agent-checkpoint.json"), JSON.stringify(proof, null, 2));
      expect("error" in result).toBe(true);
      expect(proof.calls).toBe(1);
      expect(proof.callsAfterLoss).toBe(0);
      expect(proof.after).toEqual({ state: before.state, errorCode: before.errorCode, baseHash: before.baseHash, updatedAtChanged: false });
      expect(proof.canonicalEdit).toBe(null);
    } finally { release(); await op; spy.mockRestore(); }
  }, 60_000);
});
