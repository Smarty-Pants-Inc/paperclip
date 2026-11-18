import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import { agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  principalPermissionGrants, agentInstructionWorkingCopies } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileSaveHeld } from "../services/agent-directory-working-copies.js";
import { agentFileSaveHeldOnLease, claimLeaseForDestroyUnlessHeld, pinLeaseForCollection, releaseLeaseDestroyClaim } from "../services/agent-file-save-hold.js";

const execFile = promisify(execFileCallback);
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_AGENT_DIRECTORY_TEST_DATABASE_URL");
const BOX_GONE = "Boat sandbox lease is no longer active.";
// Upstream paperclipai/paperclip recoverStoppedRemote (1c556d534, :632).
const UPSTREAM_STOPPED_LINE = "The remote provider stopped with its agent directory retained. Safe stopped-file retrieval is unavailable; no save or discard is claimed.";

/**
 * Gate 4 (lease a8a58439, run b9f3cc10): a Boat box stopped, then a save was
 * attempted against it and its refusal was recorded as a held save
 * (receipt.savePending) that pinned the stopped box: the destroy claim was
 * refused every pass and the agent stayed 'pausing'. Upstream saves only
 * while the box lease is active and keeps a stopped box's copy
 * pending_collection without any pin.
 */
describe("agent-file save after the box stopped", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const entryFile = "policy/INSTRUCTIONS.txt";

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "save-after-stop-")));
    process.env.PAPERCLIP_HOME = home;
    if (!external) database = await startEmbeddedPostgresTestDatabase("save-after-stop-db-");
    db = createDb(external ?? database!.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Save after stop", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Original\n");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), nextAttemptAt: null,
      receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.companyId, companyId));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() }).where(eq(environmentLeases.companyId, companyId));
  });

  /** A warm Boat copy prepared on an ACTIVE lease; the provider tree is a local
   * directory and only the transport boundary is mocked. `boxGone()` makes
   * every later provider command fail the way Boat does for a stopped box. */
  async function warmRemoteCopy() {
    const runId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const remoteCwd = await fs.mkdtemp(path.join(home, "box-"));
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      provider: "boat", providerLeaseId: `box-${leaseId}`, status: "active", metadata: { remoteCwd } });
    const remote = { kind: "remote" as const, transport: "sandbox" as const, environmentId, leaseId, remoteCwd, runner: { execute: vi.fn() } };
    vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async options => {
      const assetDirs: Record<string, string> = {};
      for (const asset of options.assets ?? []) {
        const destination = path.join(remoteCwd, "assets", randomUUID(), asset.key);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(asset.localDir, destination, { recursive: true }); assetDirs[asset.key] = destination;
      }
      if (options.syncWorkspace && options.workspaceInboundMode !== "adopt_remote") {
        await fs.mkdir(options.workspaceRemoteDir!, { recursive: true });
        await fs.cp(options.workspaceLocalDir, options.workspaceRemoteDir!, { recursive: true });
      }
      return { target: remote, workspaceRemoteDir: options.workspaceRemoteDir!, runtimeRootDir: options.runtimeRootDir ?? null, assetDirs,
        additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: async () => { await fs.cp(options.workspaceRemoteDir!, options.workspaceLocalDir, { recursive: true }); } };
    });
    let gone = false;
    const commands: string[] = [];
    vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockImplementation(async (_runId, _target, command) => {
      commands.push(command);
      if (gone) throw new Error(BOX_GONE);
      const result = await execFile("sh", ["-c", command], { cwd: remoteCwd, maxBuffer: 16 * 1024 * 1024 });
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: null };
    });
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, warm: true, target: remote }))!;
    expect(copy.location).toBe(`remote:${environmentId}`);
    expect((copy.receipt?.cleanup as { leaseId?: string } | undefined)?.leaseId).toBe(leaseId);
    const note = `remote-only-${randomUUID()}`;
    await fs.writeFile(path.join(copy.executionRoot, "unsaved-note.txt"), note);
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
    /** The box stops: Boat refuses every command; the lease leaves 'active' (live: pending_cleanup). */
    const stopBox = async () => {
      gone = true;
      await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, leaseId));
    };
    return { copies, copy, runId, leaseId, remote, note, lease, stopBox, commands, failBox: () => { gone = true; } };
  }

  it("R1 live shape: a save attempted after the box stopped records no pin, keeps pending_collection, and the destroy claim is granted", async () => {
    const fx = await warmRemoteCopy();
    await fx.stopBox();
    const before = fx.commands.length;
    // The stop collector still holds the cached Boat target (2 s after the box stop).
    const collected = (await fx.copies.collectStopped({ companyId, runId: fx.runId, target: fx.remote }))!;
    // The capped sweep's destroyRunLease gate (claimLeaseForDestroyUnlessHeld) is granted.
    const claim = await claimLeaseForDestroyUnlessHeld(db, await fx.lease());
    expect(claim).toEqual(expect.any(String));
    await releaseLeaseDestroyClaim(db, fx.leaseId, claim!);
    expect(agentFileSaveHeld(collected)).toBe(false);
    expect(collected.receipt?.savePending).toBeUndefined();
    expect(collected.state).toBe("pending_collection");
    expect(collected.errorCode).toBe("INSTRUCTION_STOPPED_REMOTE_COLLECTION_PENDING");
    expect(collected.errorMessage).toBe(UPSTREAM_STOPPED_LINE);
    expect(fx.commands.length).toBe(before); // no save is attempted against a stopped box
    expect(await agentFileSaveHeldOnLease(db, await fx.lease())).toBe(false);
    // Repeated sweeps stay pin-free (live: failures 15).
    for (let pass = 0; pass < 3; pass++) {
      const again = (await fx.copies.collectStopped({ companyId, runId: fx.runId, target: fx.remote }))!;
      expect(again.receipt?.savePending).toBeUndefined();
    }
    expect(await claimLeaseForDestroyUnlessHeld(db, await fx.lease())).toEqual(expect.any(String));
  }, 60_000);

  it("R2 existing stuck row (unavailable + savePending 'lease no longer active') keeps its NEVER-OK hold on the stopped box (RFL 14:34Z ruling 1)", async () => {
    const fx = await warmRemoteCopy();
    await fx.stopBox();
    const since = new Date(Date.now() - 4 * 3600_000);
    const savePending = { code: "AGENT_FILES_SAVE_FAILED", since: since.toISOString(), reason: BOX_GONE, failures: 15 };
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: since, errorCode: "AGENT_FILES_SAVE_FAILED",
      nextAttemptAt: new Date(Date.now() - 1000), receipt: { ...fx.copy.receipt, savePending } })
      .where(eq(agentInstructionWorkingCopies.runId, fx.runId));
    // The hold still refuses the destroy claim; the park key (held_for_unsaved_files) settles the pause instead.
    expect(await agentFileSaveHeldOnLease(db, await fx.lease())).toBe(true);
    expect(await claimLeaseForDestroyUnlessHeld(db, await fx.lease())).toBeNull();
    // Its own retry (as at base) cannot reach the stopped box: the hold stays, never released.
    const retried = (await fx.copies.collectStopped({ companyId, runId: fx.runId, target: fx.remote }))!;
    expect(agentFileSaveHeld(retried)).toBe(true);
    expect(await claimLeaseForDestroyUnlessHeld(db, await fx.lease())).toBeNull();
  }, 60_000);

  it("R3 negative: a save failing or in flight on an ACTIVE lease still holds the destroy", async () => {
    const fx = await warmRemoteCopy();
    // The box is live (lease active) but the save fails: the stopped tree is the only copy.
    fx.failBox();
    const held = (await fx.copies.collectStopped({ companyId, runId: fx.runId, target: fx.remote }))!;
    expect(agentFileSaveHeld(held)).toBe(true);
    expect((await fx.lease()).status).toBe("active");
    expect(await agentFileSaveHeldOnLease(db, await fx.lease())).toBe(true);
    expect(await claimLeaseForDestroyUnlessHeld(db, await fx.lease())).toBeNull();
    // A collection in flight (its pin) also refuses the destroy.
    const other = await warmRemoteCopy();
    const pin = await pinLeaseForCollection(db, other.leaseId, `${companyId}:${other.runId}:${agentId}`);
    expect(pin).toEqual(expect.any(String));
    expect(await claimLeaseForDestroyUnlessHeld(db, await other.lease())).toBeNull();
  }, 60_000);

  it("R4 a stop collection while the lease is active still saves (upstream branch 1)", async () => {
    const fx = await warmRemoteCopy();
    const saved = (await fx.copies.collectStopped({ companyId, runId: fx.runId, target: fx.remote }))!;
    expect(saved.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "unsaved-note.txt"), "utf8")).toBe(fx.note);
    expect(await claimLeaseForDestroyUnlessHeld(db, await fx.lease())).toEqual(expect.any(String));
  }, 60_000);
});
