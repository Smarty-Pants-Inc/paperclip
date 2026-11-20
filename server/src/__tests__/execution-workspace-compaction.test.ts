import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executionWorkspaceService,
  type ExecutionWorkspaceServiceOptions,
} from "../services/execution-workspaces.ts";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.ts";
import { WORKSPACE_COMPACTION_TRASH_DIR } from "../services/workspace-compaction.ts";
import { logger } from "../middleware/logger.js";
import { contentSpill, custodyRows, custodySpill, plantHungStore, readAll, recoveredSpills, sha, SPILL_CUSTODY_ROW,
  spillCustodyFaults } from "../services/object-run-log-spill.fixture.js";
import { cleanupExecutionWorkspaceArtifacts } from "../services/workspace-runtime.js";
import { listKeptObjectRunLogSpills, RUN_LOG_SPILL_READ_BACK_BUDGET_MS } from "../services/object-run-log-store.js";
import { cleanupWorktreeInstanceArtifacts, deriveWorktreeInstanceId, listKeptWorktreeInstances,
  readWorktreeInstancePointer } from "../services/workspace-instance-cleanup.js";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace compaction tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function git(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim();
}

async function exists(filePath: string) {
  return fs.lstat(filePath).then(() => true, () => false);
}

async function writeFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createRepo() {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-compaction-")));
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await git(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await writeFile(path.join(repoRoot, "README.md"), "# Test repo\n");
  await writeFile(
    path.join(repoRoot, ".gitignore"),
    ["node_modules/", "dist/", ".env", ".paperclip/", "local-data/", ""].join("\n"),
  );
  await git(repoRoot, ["add", "README.md", ".gitignore"]);
  await git(repoRoot, ["commit", "-m", "Initial commit"]);
  await git(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

// Files a finished task leaves behind. The regenerable directories are the
// only paths compaction may remove; everything else is work or data.
const REGENERABLE_PATHS = ["node_modules", "packages/app/node_modules", "dist"];
const PRESERVED_PATHS = [
  "notes/findings.md",
  ".env",
  "local-data/state.json",
  ".paperclip/instances/default/db.txt",
];

async function populateWorktree(worktreePath: string) {
  await writeFile(path.join(worktreePath, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  await writeFile(path.join(worktreePath, "packages/app/node_modules/dep/index.js"), "module.exports = 2;\n");
  await writeFile(path.join(worktreePath, "dist/server.js"), "built\n");
  await writeFile(path.join(worktreePath, "notes/findings.md"), "untracked agent notes\n");
  await writeFile(path.join(worktreePath, ".env"), "TOKEN=local\n");
  await writeFile(path.join(worktreePath, "local-data/state.json"), "{}\n");
  await writeFile(path.join(worktreePath, ".paperclip/instances/default/db.txt"), "instance data\n");
  await fs.appendFile(path.join(worktreePath, "README.md"), "uncommitted edit\n");
}

describeEmbeddedPostgres("terminal workspace compaction", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-compaction-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null, parentId: null });
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(options: ExecutionWorkspaceServiceOptions = {}) {
    return executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      workspaceReaperCooldownDays: 0,
      workspaceCompactionDelayMs: 0,
      ...options,
    });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.slice(0, 7).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Compaction", status: "in_progress" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, projectId, agentId, issuePrefix };
  }

  async function seedWorkspace(options: {
    worktreePath?: string;
    repoRoot?: string;
    commitOnBranch?: boolean;
    populate?: boolean;
    terminalAgoMs?: number;
    mode?: "isolated_workspace" | "shared_workspace";
  } = {}) {
    const repoRoot = options.repoRoot ?? await createRepo();
    tempDirs.add(repoRoot);
    const branchName = `PAP-${Math.floor(Math.random() * 100000)}-finished-task`;
    let worktreePath = options.worktreePath;
    if (!worktreePath) {
      worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
      await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, "main"]);
    }
    if (options.commitOnBranch) {
      await writeFile(path.join(worktreePath, "src/feature.ts"), "export const unmerged = true;\n");
      await git(worktreePath, ["add", "src/feature.ts"]);
      await git(worktreePath, ["commit", "-m", "Unmerged work"]);
    }
    if (options.populate !== false) await populateWorktree(worktreePath);

    const company = await seedCompany();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId: company.companyId,
      projectId: company.projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: repoRoot,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: company.companyId,
      projectId: company.projectId,
      projectWorkspaceId,
      mode: options.mode ?? "isolated_workspace",
      strategyType: "git_worktree",
      name: branchName,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      baseRef: "main",
      branchName,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId: company.companyId,
      projectId: company.projectId,
      identifier: `${company.issuePrefix}-1`,
      title: "Finished task",
      status: "done",
      priority: "medium",
      completedAt: new Date(Date.now() - (options.terminalAgoMs ?? 2 * HOUR_MS)),
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { ...company, repoRoot, worktreePath, branchName, executionWorkspaceId, sourceIssueId };
  }

  async function workspaceStatus(executionWorkspaceId: string) {
    const [row] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return row?.status ?? null;
  }

  async function expectRegenerablePresent(worktreePath: string, present: boolean) {
    for (const relativePath of REGENERABLE_PATHS) {
      expect(await exists(path.join(worktreePath, relativePath)), relativePath).toBe(present);
    }
  }

  async function expectWorkPreserved(worktreePath: string) {
    for (const relativePath of PRESERVED_PATHS) {
      expect(await exists(path.join(worktreePath, relativePath)), relativePath).toBe(true);
    }
    expect(await fs.readFile(path.join(worktreePath, "README.md"), "utf8")).toContain("uncommitted edit");
  }

  it.each([false, true])("compacts an undelivered workspace and preserves source with Git expiration %s", async gitCacheExpirationEnabled => {
    const seeded = await seedWorkspace({ commitOnBranch: true });
    const headBefore = await git(seeded.worktreePath, ["rev-parse", "HEAD"]);
    const statusBefore = await git(seeded.worktreePath, ["status", "--porcelain", "--untracked-files=all"]);

    const sweep = await service({ gitCacheExpirationEnabled }).sweepTerminalWorkspaces();

    // The branch carries unmerged work, so the reaper keeps the workspace.
    expect(sweep).toMatchObject({ compacted: 1, compactionFailed: 0, archived: 0 });
    if (!gitCacheExpirationEnabled) expect(sweep.skippedUndelivered).toBe(1);
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");
    await expectRegenerablePresent(seeded.worktreePath, false);
    await expectWorkPreserved(seeded.worktreePath);
    expect(await exists(path.join(seeded.worktreePath, "src/feature.ts"))).toBe(true);
    expect(await git(seeded.worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(seeded.repoRoot, ["rev-parse", `refs/heads/${seeded.branchName}`])).toBe(headBefore);
    // Removing ignored directories never changes what Git sees as work.
    expect(await git(seeded.worktreePath, ["status", "--porcelain", "--untracked-files=all"])).toBe(statusBefore);
    // The moved files are deleted, not parked.
    const trashRoot = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR);
    expect(await fs.readdir(trashRoot).catch(() => [])).toEqual([]);

    const [activity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, seeded.executionWorkspaceId),
        eq(activityLog.action, "execution_workspace.regenerable_files_removed"),
      ));
    expect((activity?.details as { removedPaths?: string[] } | undefined)?.removedPaths?.sort())
      .toEqual([...REGENERABLE_PATHS].sort());
  }, 30_000);

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7018965885
  // Keep reason: NEVER-OK trace custody. Actual DB-backed sweep, writer and filesystem.
  it.each([
    ["guest", true], ["drift", true], ["unreadable", true], ["recovered", true],
    ["guest", false], ["drift", false], ["unreadable", false], ["recovered", false],
  ] as const)("scheduled sweep keeps undiscoverable content (%s, unmerged=%s)", async (mode, unmerged) => {
    const seeded = await seedWorkspace({ commitOnBranch: unmerged, populate: false });
    await fs.appendFile(path.join(seeded.repoRoot, ".gitignore"), "build/\n");
    await git(seeded.repoRoot, ["add", ".gitignore"]);
    await git(seeded.repoRoot, ["commit", "-m", "Ignore build output"]);
    await git(seeded.worktreePath, unmerged ? ["cherry-pick", "main"] : ["merge", "--ff-only", "main"]);
    const spill = await contentSpill(seeded.worktreePath, path.join(seeded.worktreePath, "build"), mode);
    await writeFile(path.join(seeded.worktreePath, "dist", "control.js"), "regenerable\n");
    const sweep = await service().sweepTerminalWorkspaces();
    const survived = await exists(spill.path);
    console.info("content-custody-scheduled", { mode, unmerged, sweep, survived });
    expect(sweep).toMatchObject({ compacted: 1, compactionFailed: 0,
      archived: mode === "recovered" && !unmerged ? 1 : 0 });
    expect(survived).toBe(mode !== "recovered");
    expect(await exists(path.join(seeded.worktreePath, "dist"))).toBe(false);
    if (survived) {
      await fs.chmod(spill.indexPath, 0o600);
      expect(await fs.readFile(spill.path)).toEqual(spill.bytes);
      expect(await fs.readFile(spill.indexPath)).toEqual(spill.index);
    }
  }, 30_000);

  // catch: rf-7 OBJLOG9 F1 (11-19); the bar: delete only on a positive record AND an equal read-back.
  // Keep reason: NEVER-OK trace custody. Actual DB-backed sweep, writer, store and filesystem; each fault planted and named.
  it.each(spillCustodyFaults)("scheduled sweep keeps a spill of unknown custody (%s)", async fault => {
    const seeded = await seedWorkspace({ commitOnBranch: false, populate: false });
    await fs.appendFile(path.join(seeded.repoRoot, ".gitignore"), "build/\n");
    await git(seeded.repoRoot, ["add", ".gitignore"]);
    await git(seeded.repoRoot, ["commit", "-m", "Ignore build output"]);
    await git(seeded.worktreePath, ["merge", "--ff-only", "main"]);
    const spill = await custodySpill(seeded.worktreePath, path.join(seeded.worktreePath, "build"), fault);
    await writeFile(path.join(seeded.worktreePath, "dist", "control.js"), "regenerable\n");
    const warn = vi.spyOn(logger, "warn");
    const sweep = await service().sweepTerminalWorkspaces();
    const rows = warn.mock.calls.filter(call => call[1] === SPILL_CUSTODY_ROW).map(call => call[0]);
    warn.mockRestore();
    expect(sweep).toMatchObject({ compacted: 1, compactionFailed: 0, archived: 0 });
    expect(await exists(path.join(seeded.worktreePath, "dist"))).toBe(false);
    expect(rows).toContainEqual(expect.objectContaining({ spill: spill.path, reason: spill.reason }));
    expect(await fs.readFile(spill.path)).toEqual(spill.bytes);
    expect(await fs.readFile(spill.indexPath).catch(() => null)).toEqual(spill.index);
  }, 30_000);

  it.each(["guest", "drift", "unreadable", "recovered"] as const)("whole-worktree removal keeps undiscoverable content (%s)", async mode => {
    const seeded = await seedWorkspace({ populate: false });
    const spill = await contentSpill(seeded.worktreePath, path.join(seeded.worktreePath, "build"), mode);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const result = await cleanupExecutionWorkspaceArtifacts({ workspace: workspace!, projectWorkspace: { cwd: seeded.repoRoot, cleanupCommand: null } });
    const survived = await exists(spill.path);
    console.info("content-custody-whole-worktree", { mode, result, survived });
    expect(result.cleaned).toBe(mode === "recovered");
    expect(survived).toBe(mode !== "recovered");
  }, 30_000);

  // RFL ruling 11-20 (1): the run-log-shape test is for `*.ndjson` OUTSIDE a spill directory only.
  it.each([
    ["elsewhere in the worktree does not block it", "build/export/orders.ndjson", true],
    ["inside a spill directory keeps the worktree", "build/data/run-logs/.spill/company/agent/run.ndjson", false],
  ] as const)("whole-worktree removal: another tool's *.ndjson %s", async (_case, file, removed) => {
    const seeded = await seedWorkspace({ populate: false });
    const contents = `${JSON.stringify({ id: 1, stream: "orders", chunk: 7 })}\n`.repeat(3);
    await writeFile(path.join(seeded.worktreePath, file), contents);
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const result = await cleanupExecutionWorkspaceArtifacts({ workspace: workspace!, projectWorkspace: { cwd: seeded.repoRoot, cleanupCommand: null } });
    expect(result.cleaned).toBe(removed);
    expect(await exists(seeded.worktreePath)).toBe(!removed);
    if (!removed) expect(await fs.readFile(path.join(seeded.worktreePath, file), "utf8")).toBe(contents);
  }, 30_000);

  // The independent observer of the workspace lifecycle lock: its own database
  // connection, reading Postgres' own lock table. It never takes the lock and
  // shares nothing with the cleanup under test. Each hold is bounded from both
  // sides: `seenHeldMs` between two sightings of the lock, `heldAtMostMs`
  // between the last sighting without it before and the first one after.
  function observeLifecycleLock(workspaceId: string, onSighting: (heldAtMostMs: number) => void) {
    const observer = createDb(tempDb!.connectionString);
    const holds: Array<{ seenHeldMs: number; heldAtMostMs: number }> = [];
    let stopped = false, lastFree = Date.now(), firstHeld: number | null = null, lastHeld = 0;
    const watching = (async () => {
      while (!stopped || firstHeld !== null) {
        const [row] = await observer.execute(sql`
          select count(*)::int as held from pg_locks
          where locktype = 'advisory' and granted
            and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0)`);
        const at = Date.now();
        if (Number(row?.held) > 0) {
          firstHeld ??= at;
          lastHeld = at;
          onSighting(at - lastFree);
        } else {
          if (firstHeld !== null) holds.push({ seenHeldMs: lastHeld - firstHeld, heldAtMostMs: at - lastFree });
          firstHeld = null;
          lastFree = at;
        }
        await delay(20);
      }
      await observer.$client.end({ timeout: 1 });
    })();
    return { async stop() {
      stopped = true;
      await watching;
      return holds.sort((a, b) => b.heldAtMostMs - a.heldAtMostMs);
    } };
  }

  // RFL ruling 11-20 (3).
  // catch: bb-objlog11's limit (11-20): every recovered spill is read back while the cleanup holds the
  // workspace lifecycle lock, and a store that stops answering costs one journal read deadline (15 s)
  // PER SPILL: 20 spills held the lock 300 s, and a person's next turn on that workspace waits on that lock.
  // Keep reason: NEVER-OK trace custody must not cost the person their turn. One guard pass spends at
  // most one read-back budget; what it could not read back is KEPT for the next pass, never released.
  // The real scheduled sweep and its real lifecycle lock (embedded Postgres), the real writer, store,
  // journal, instance cleanup and files. The one planted fault is `store-hung`.
  it.each([undefined, "2000"])("a hung object store holds the lifecycle lock for one read-back budget (env override %s); every unread spill is kept, then proven once the store answers", async (override) => {
    // RFL's bound: one guard pass reads back for 10 s by default, or the configured budget.
    // On top of it, the cleanup's own work under the lock (Git, the database, the filesystem).
    vi.stubEnv("RUN_LOG_SPILL_READ_BACK_BUDGET_MS", override);
    const BUDGET_MS = override ? Number(override) : 10_000, LOCK_WORK_ALLOWANCE_MS = 5_000;
    const seeded = await seedWorkspace({ populate: false });
    const worktreesDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-budget-instances-")));
    tempDirs.add(worktreesDir);
    // A seeded worktree instance, as provisioning leaves it: the pointer in the worktree, the root on the row.
    const instanceId = deriveWorktreeInstanceId(seeded.worktreePath);
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await writeFile(path.join(seeded.worktreePath, ".paperclip", ".env"),
      `PAPERCLIP_HOME=${JSON.stringify(worktreesDir)}\nPAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}\n`);
    await db.update(executionWorkspaces).set({ metadata: { worktreeInstanceRoot: instanceRoot } })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const pointer = (await readWorktreeInstancePointer(seeded.worktreePath))!;
    // 20 spills at the instance's default root, each genuinely recovered: releasable, once read back.
    const { m, store, spills } = await recoveredSpills(path.join(instanceRoot, "data", "run-logs", ".spill"), 20);
    expect(spills.map(spill => spill.unrecoveredBytes)).toEqual(Array(20).fill(0));
    vi.stubEnv("PAPERCLIP_WORKTREES_DIR", worktreesDir);
    const hung = plantHungStore(m);
    const warn = vi.spyOn(logger, "warn");
    // Should the lock outlive its bound, let the store answer so this row ends: it has already failed.
    const lock = observeLifecycleLock(seeded.executionWorkspaceId, heldAtMostMs => {
      if (heldAtMostMs > BUDGET_MS + LOCK_WORK_ALLOWANCE_MS) hung.heal();
    });
    let sweep, holds;
    try {
      // Compaction is off so that this sweep asks about the spills once, under the lock.
      sweep = await service({ workspaceCompactionDelayMs: null }).sweepTerminalWorkspaces();
    } finally {
      holds = await lock.stop();
      vi.unstubAllEnvs();
    }
    const rows = custodyRows(warn);
    warn.mockRestore();
    const stillHung = hung.state.hung;
    hung.heal();
    console.info("read-back-budget", { sweep, holds: holds.slice(0, 3), unansweredGets: hung.state.unansweredGets,
      waitedMs: hung.state.lastGiveUpAt - hung.state.firstGetAt, reasons: rows.map(row => row.reason) });

    // The lock, from the observer: held for the budget plus the cleanup's own work, not 20 read deadlines.
    expect(holds[0]!.heldAtMostMs).toBeLessThanOrEqual(BUDGET_MS + LOCK_WORK_ALLOWANCE_MS);
    expect(stillHung).toBe(true);
    // The read-backs, from the store: the pass waited on it no longer than its budget.
    expect(RUN_LOG_SPILL_READ_BACK_BUDGET_MS).toBe(10_000);
    expect(hung.state.unansweredGets).toBeGreaterThan(0);
    expect(hung.state.lastGiveUpAt - hung.state.firstGetAt).toBeLessThanOrEqual(BUDGET_MS + 250);
    // KEPT: all 20, each with a custody row; the ones the budget did not reach say so.
    expect(rows.map(row => row.spill).sort()).toEqual(spills.map(spill => spill.path).sort());
    const reasons = rows.map(row => row.reason);
    expect(reasons.filter(reason => reason === "read_back_budget_exhausted").length).toBeGreaterThanOrEqual(19);
    expect(reasons.filter(reason => !["read_back_budget_exhausted", "recovered_copy_read_timeout", "recovered_copy_unreadable"].includes(reason))).toEqual([]);
    for (const spill of spills) {
      expect((await fs.readFile(spill.path)).equals(spill.bytes)).toBe(true);
      expect((await fs.readFile(spill.indexPath)).equals(spill.index)).toBe(true);
    }
    expect(await listKeptWorktreeInstances(worktreesDir)).toEqual([
      expect.objectContaining({ instance: instanceId, instanceRoot, keptPaths: 20 })]);

    // The store answers again: the next pass reads all 20 back and proves them, so custody keeps none.
    // TODAY then keeps the instance by its own rule: recovered spill files stay as raw traces.
    expect(await listKeptObjectRunLogSpills(path.join(instanceRoot, "data", "run-logs", ".spill"))).toEqual([]);
    const next = await cleanupWorktreeInstanceArtifacts({ pointer, workspaceId: seeded.executionWorkspaceId,
      workspacePath: seeded.worktreePath, expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir });
    expect(next.status).toBe("refused");
    expect(await listKeptWorktreeInstances(worktreesDir)).toEqual([expect.objectContaining({ instance: instanceId,
      path: path.join(instanceRoot, "data", "run-logs"), reason: "raw_traces_kept" })]);
    for (const spill of spills) expect((await fs.readFile(spill.path)).equals(spill.bytes)).toBe(true);
    // Nothing was lost with the spills: the object log still serves every admitted byte.
    for (const spill of spills) expect((await readAll(store, spill.logRef)).equals(spill.log)).toBe(true);
  }, 150_000);

  it("compacts a delivered workspace that is still inside the archive cooldown", async () => {
    const seeded = await seedWorkspace();
    await git(seeded.worktreePath, ["checkout", "--", "README.md"]);

    const sweep = await service({ workspaceReaperCooldownDays: 7 }).sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 1, archived: 0, skippedCooldown: 1 });
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");
    await expectRegenerablePresent(seeded.worktreePath, false);
    expect(await exists(path.join(seeded.worktreePath, "notes/findings.md"))).toBe(true);
  }, 30_000);

  it.each([false, true])("retains skipped startup compaction for the next sweep with Git expiration %s", async gitCacheExpirationEnabled => {
    const seeded = await seedWorkspace();
    const svc = service({ workspaceReaperCooldownDays: 7, gitCacheExpirationEnabled, gitCacheExpirationDryRun: true });

    expect(await svc.sweepTerminalWorkspaces(50, undefined, { compact: false })).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    // The skipped compaction stays scheduled, so the worker wakes for it.
    const next = await svc.nextTerminalWorkspaceSweepAt();
    expect(next).not.toBeNull();
    expect(next!).toBeLessThanOrEqual(Date.now());

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    await expectRegenerablePresent(seeded.worktreePath, false);
  }, 30_000);

  // catch: rf-7 OBJLOG16 F4 (11-20): each stale entry restarted the 10 s budget.
  // Keep reason: NEVER-OK trace custody must bound the whole purge without deleting unread spills.
  // Exercise both real sweep callers, real writer/recovery/files, with only the provider hung.
  it.each(["immediate", "deferred"] as const)("one %s trash purge shares its read-back budget across stale entries", async mode => {
    vi.stubEnv("RUN_LOG_SPILL_READ_BACK_BUDGET_MS", undefined);
    const seeded = await seedWorkspace({ populate: false });
    const svc = service({ workspaceReaperCooldownDays: 7 });
    const trashRoot = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR);
    const groups = [];
    for (let n = 0; n < 2; n++) {
      const entry = path.join(trashRoot, `interrupted-${n}`);
      const group = await recoveredSpills(path.join(entry, "0", ".spill"), 10);
      expect(group.spills.map(spill => spill.unrecoveredBytes)).toEqual(Array(10).fill(0));
      const old = new Date(Date.now() - 2 * HOUR_MS);
      await fs.utimes(entry, old, old);
      groups.push({ ...group, entry });
    }
    // The deferred caller drains the queue from the startup sweep, before visiting candidates.
    if (mode === "deferred") await svc.sweepTerminalWorkspaces(50, undefined, { compact: false });
    const hung = groups.map(group => plantHungStore(group.m));
    const warn = vi.spyOn(logger, "warn");
    try {
      const started = Date.now();
      await svc.sweepTerminalWorkspaces();
      const finished = Date.now();
      const proof = [];
      for (const spill of groups.flatMap(group => group.spills)) {
        const bytes = await fs.readFile(spill.path), index = await fs.readFile(spill.indexPath);
        proof.push({ path: spill.path, beforeSha: sha(spill.bytes), afterSha: sha(bytes),
          beforeIndexSha: sha(spill.index), afterIndexSha: sha(index) });
        expect(bytes).toEqual(spill.bytes);
        expect(index).toEqual(spill.index);
      }
      const rows = custodyRows(warn);
      console.info("stale-trash-purge-caller-budget", { mode, operationMs: finished - started,
        firstGetToFinishMs: finished - Math.min(...hung.map(store => store.state.firstGetAt).filter(Boolean)),
        rows, proof });
      expect(proof).toHaveLength(20);
      expect(finished - started).toBeLessThanOrEqual(15_000);
      // Each content guard stops at its first kept spill; the second entry is kept without a fresh wait.
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.reason === "read_back_budget_exhausted")).toHaveLength(1);
      for (const store of hung) store.heal();
      // A new purge, after healing, can prove and remove both recovered entries normally.
      await service({ workspaceReaperCooldownDays: 7 }).sweepTerminalWorkspaces();
      for (const group of groups) {
        expect(await exists(group.entry)).toBe(false);
        for (const spill of group.spills) expect(await readAll(group.store, spill.logRef)).toEqual(spill.log);
      }
    } finally {
      for (const store of hung) store.heal();
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  }, 90_000);

  it("leaves leftover trash for a later sweep when a sweep skips compaction", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    // The cooldown keeps the workspace a candidate across both sweeps.
    const svc = service({ workspaceReaperCooldownDays: 7 });

    await svc.sweepTerminalWorkspaces(50, undefined, { compact: false });
    expect(await exists(trashEntry)).toBe(true);

    await svc.sweepTerminalWorkspaces();
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("purges skipped trash after a startup sweep archives the last workspace beside it", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    const svc = service();

    // No cooldown: the startup sweep archives the only workspace in this
    // directory, so no later sweep has a candidate there.
    expect(await svc.sweepTerminalWorkspaces(50, undefined, { compact: false })).toMatchObject({ archived: 1 });
    expect(await exists(trashEntry)).toBe(true);

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ checked: 0 });
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("keeps skipped trash queued when the next sweep is aborted", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);
    const svc = service();
    await svc.sweepTerminalWorkspaces(50, undefined, { compact: false });

    const controller = new AbortController();
    controller.abort();
    await expect(svc.sweepTerminalWorkspaces(50, controller.signal)).rejects.toThrow();
    expect(await exists(trashEntry)).toBe(true);

    await svc.sweepTerminalWorkspaces();
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("waits for the compaction delay after the issue tree becomes terminal", async () => {
    const seeded = await seedWorkspace({ terminalAgoMs: 10 * 60 * 1000 });
    const svc = service({ workspaceReaperCooldownDays: 7, workspaceCompactionDelayMs: HOUR_MS });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    // The worker wakes when the delay ends, not when the archive cooldown ends.
    const next = await svc.nextTerminalWorkspaceSweepAt();
    expect(next).not.toBeNull();
    expect(next!).toBeLessThan(Date.now() + HOUR_MS);

    await db
      .update(issues)
      .set({ completedAt: new Date(Date.now() - 2 * HOUR_MS) })
      .where(eq(issues.id, seeded.sourceIssueId));
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    await expectRegenerablePresent(seeded.worktreePath, false);
  }, 30_000);

  it("leaves files alone while a run is active on the task", async () => {
    const seeded = await seedWorkspace();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, seeded.sourceIssueId));

    const sweep = await service().sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a queued run targets the task through its context", async () => {
    const seeded = await seedWorkspace();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "queued",
      contextSnapshot: { issueId: seeded.sourceIssueId },
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a child issue is unfinished", async () => {
    const seeded = await seedWorkspace();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      parentId: seeded.sourceIssueId,
      identifier: `${seeded.issuePrefix}-2`,
      title: "Follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, skippedNonTerminalTree: 1 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("leaves files alone while a runtime service runs from the worktree", async () => {
    const seeded = await seedWorkspace();
    await db.insert(workspaceRuntimeServices).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      executionWorkspaceId: seeded.executionWorkspaceId,
      issueId: seeded.sourceIssueId,
      scopeType: "execution_workspace",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: seeded.worktreePath,
      provider: "local_process",
      healthStatus: "healthy",
    });

    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("restores the files when the task reopens while they are being moved", async () => {
    const seeded = await seedWorkspace();
    const svc = service({
      afterWorkspaceCompactionMove: async () => {
        await db.update(issues).set({ status: "todo", completedAt: null }).where(eq(issues.id, seeded.sourceIssueId));
      },
    });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, compactionFailed: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
    expect(await fs.readFile(path.join(seeded.worktreePath, "node_modules/left-pad/index.js"), "utf8"))
      .toBe("module.exports = 1;\n");
    const trashRoot = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR);
    expect(await fs.readdir(trashRoot).catch(() => [])).toEqual([]);
  }, 30_000);

  it("restores the files when a run starts while they are being moved", async () => {
    const seeded = await seedWorkspace();
    const svc = service({
      afterWorkspaceCompactionMove: async () => {
        await db.insert(heartbeatRuns).values({
          id: randomUUID(),
          companyId: seeded.companyId,
          agentId: seeded.agentId,
          status: "queued",
          contextSnapshot: { issueId: seeded.sourceIssueId },
        });
      },
    });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);

  it("never compacts a shared workspace or a main checkout", async () => {
    const shared = await seedWorkspace({ mode: "shared_workspace" });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(shared.worktreePath, true);

    // A workspace row that points at the repository's main checkout (its .git
    // is a directory) is never compacted, whatever its strategy says.
    const repoRoot = await createRepo();
    await populateWorktree(repoRoot);
    await seedWorkspace({ repoRoot, worktreePath: repoRoot, populate: false });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(repoRoot, true);
  }, 30_000);

  it("compacts once per terminal cycle and again after the task finishes a later cycle", async () => {
    const seeded = await seedWorkspace();
    const svc = service({ workspaceReaperCooldownDays: 7 });

    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    // A resumed run regenerates dependencies, and the task finishes again.
    await writeFile(path.join(seeded.worktreePath, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    expect(await exists(path.join(seeded.worktreePath, "node_modules"))).toBe(true);

    await db
      .update(issues)
      .set({ completedAt: new Date(Date.now() - HOUR_MS) })
      .where(eq(issues.id, seeded.sourceIssueId));
    expect(await svc.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    expect(await exists(path.join(seeded.worktreePath, "node_modules"))).toBe(false);
  }, 30_000);

  it("regenerates removed files when the task resumes in the compacted worktree", async () => {
    const repoRoot = await createRepo();
    tempDirs.add(repoRoot);
    const provisionCommand = "mkdir -p node_modules/left-pad && echo regenerated > node_modules/left-pad/index.js";
    const realizationInput = {
      base: {
        baseCwd: repoRoot,
        source: "project_primary" as const,
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: { workspaceStrategy: { type: "git_worktree", baseRef: "main", provisionCommand } },
      issue: { id: "issue-1", identifier: "PAP-9", title: "Resume after compaction" },
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
    } satisfies Parameters<typeof realizeExecutionWorkspace>[0];
    const first = await realizeExecutionWorkspace(realizationInput);
    expect(first.created).toBe(true);
    await writeFile(path.join(first.cwd, "notes/findings.md"), "untracked agent notes\n");
    await writeFile(path.join(first.cwd, "src/feature.ts"), "export const unmerged = true;\n");
    await git(first.cwd, ["add", "src/feature.ts"]);
    await git(first.cwd, ["commit", "-m", "Unmerged work"]);
    const head = await git(first.cwd, ["rev-parse", "HEAD"]);

    const seeded = await seedWorkspace({ repoRoot, worktreePath: first.cwd, populate: false });
    expect(await service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    expect(await exists(path.join(first.cwd, "node_modules"))).toBe(false);
    expect(await workspaceStatus(seeded.executionWorkspaceId)).toBe("active");

    const resumed = await realizeExecutionWorkspace({
      ...realizationInput,
      recordedBranchOwnership: { branchName: first.branchName!, createdByRuntime: true },
    });

    expect(resumed.created).toBe(false);
    expect(resumed.cwd).toBe(first.cwd);
    expect(await fs.readFile(path.join(first.cwd, "node_modules/left-pad/index.js"), "utf8")).toBe("regenerated\n");
    expect(await fs.readFile(path.join(first.cwd, "notes/findings.md"), "utf8")).toBe("untracked agent notes\n");
    expect(await git(first.cwd, ["rev-parse", "HEAD"])).toBe(head);
  }, 60_000);

  it("purges leftover trash even when the workspace has nothing left to compact", async () => {
    const seeded = await seedWorkspace({ populate: false });
    const trashEntry = path.join(path.dirname(seeded.worktreePath), WORKSPACE_COMPACTION_TRASH_DIR, "interrupted");
    await writeFile(path.join(trashEntry, "0/left-pad/index.js"), "module.exports = 1;\n");
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR_MS);
    await fs.utimes(trashEntry, twoHoursAgo, twoHoursAgo);

    const sweep = await service().sweepTerminalWorkspaces();

    expect(sweep).toMatchObject({ compacted: 0, compactionFailed: 0 });
    expect(await exists(trashEntry)).toBe(false);
  }, 30_000);

  it("does not compact when compaction is disabled", async () => {
    const seeded = await seedWorkspace();
    expect(await service({ workspaceCompactionDelayMs: null }).sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerablePresent(seeded.worktreePath, true);
  }, 30_000);
});
