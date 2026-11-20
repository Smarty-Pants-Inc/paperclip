import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktreeInstanceArtifacts,
  deriveWorktreeInstanceId,
  listKeptWorktreeInstances,
  readManagedWorktreeInstanceOwnership,
  readWorktreeInstancePointer,
  stopEmbeddedPostgresIfRunning,
} from "../services/workspace-instance-cleanup.js";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.js";
import { logger } from "../middleware/logger.js";
import { createObjectRunLogStore, readObjectRunLogSpill } from "../services/object-run-log-store.js";
import { createDurableRunLogStore } from "../services/run-log-store.js";
import { contentSpill, custodySpill, event, ids, plantSpillCustodyFault, SPILL_CUSTODY_FAULTS, SPILL_CUSTODY_ROW,
  spillCustodyFaults, spillMemory, type SpillCustodyFault } from "../services/object-run-log-spill.fixture.js";

const tempRoots = new Set<string>();

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

async function writeWorkspaceEnv(workspacePath: string, homeDir: string, instanceId: string): Promise<void> {
  const envDir = path.join(workspacePath, ".paperclip");
  await fs.mkdir(envDir, { recursive: true });
  await fs.writeFile(
    path.join(envDir, ".env"),
    `PAPERCLIP_HOME=${JSON.stringify(homeDir)}\nPAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}\n`,
    "utf8",
  );
}

function createRecorderDouble() {
  const operations: Array<{
    status: string;
    metadata: Record<string, unknown> | null;
    system: string | null;
  }> = [];
  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async () => {},
    recordOperation: async (input) => {
      const result = await input.run(async () => {});
      operations.push({
        status: result.status ?? "succeeded",
        metadata: input.metadata ?? null,
        system: result.system ?? null,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId: null,
        heartbeatRunId: null,
        issueId: null,
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };
  return { recorder, operations };
}

afterEach(async () => {
  await Promise.all(Array.from(tempRoots, (root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("worktree instance cleanup", () => {
  it("derives different instance IDs for distinct paths with the same normalized name", () => {
    const parent = path.join(os.tmpdir(), "paperclip-instance-id-collision");
    const plusPath = path.join(parent, "feature+cleanup");
    const dashPath = path.join(parent, "feature-cleanup");

    expect(deriveWorktreeInstanceId(plusPath)).not.toBe(deriveWorktreeInstanceId(dashPath));
    expect(deriveWorktreeInstanceId(plusPath)).toMatch(/^feature-cleanup-[a-f0-9]{12}$/);
    expect(deriveWorktreeInstanceId(dashPath)).toMatch(/^feature-cleanup-[a-f0-9]{12}$/);
  });
  it("removes an instance directory inside the managed worktree instances root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceId = "pap-16075";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "marker"), "remove me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);

    const pointer = await readWorktreeInstancePointer(workspacePath);
    expect(pointer).not.toBeNull();
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: instanceId,
      expectedInstanceRoot: instanceRoot,
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "removed", postgresStopped: false });
    await expect(fs.stat(instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7002475364 (rf-3 condition 4)
  // catch: rf-7 OBJLOG9 F1 (11-19): a record corrupted to zero bytes, `{}` or `[]` read as
  // "recovered", and the only copy of the spilled bytes went with the instance.
  // Keep reason: NEVER-OK trace custody. This cleanup is the one path that
  // removes a whole instance root; run-log bytes that exist ONLY in the kept
  // spill under it must never go with it. The instance's real writer at its
  // default spill root; "already in the object log" is a real recovery that
  // cleanup reads back, and every other state is a planted, named fault.
  const defaultRootSpills: Array<[string, "refused" | "removed", boolean | "unreadable" | SpillCustodyFault]> = [
    ["holds run-log bytes object storage has not taken", "refused", false],
    ["holds only spilled bytes that are already in the object log", "removed", true],
    ["has a record that cannot be read", "refused", "unreadable"],
    ...spillCustodyFaults.map((fault): [string, "refused", SpillCustodyFault] => [`has unknown custody (${fault})`, "refused", fault]),
  ];
  it.each(defaultRootSpills)("an instance whose run-log spill %s is %s", async (_case, status, state) => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceId = "pap-spill";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);
    vi.stubEnv("PAPERCLIP_HOME", worktreesDir);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", instanceId);
    vi.stubEnv("RUN_LOG_SPILL_PATH", undefined);
    vi.stubEnv("RUN_LOG_BASE_PATH", undefined);
    const m = spillMemory();
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin({ ...ids, runId: "run" });
    m.state.down = true;
    const committed = (await store.enqueue!(handle, event(1, "admitted"))).committed.catch(() => undefined);
    await store.finalize(handle);
    await committed;
    const fault = typeof state === "string" && state !== "unreadable" ? state : null;
    if (state === true || (fault && SPILL_CUSTODY_FAULTS[fault].recovered)) {
      m.state.down = false;
      await store.recoverSpill!({ ...ids, runId: "run" });
    }
    const spill = await readObjectRunLogSpill(undefined, handle.logRef);
    expect(spill.path).toBe(path.join(instanceRoot, "data", "run-logs", ".spill", "company", "agent", "run.ndjson"));
    expect(spill.unrecovered.length > 0).toBe(state === false || state === "unreadable" || (!!fault && !SPILL_CUSTODY_FAULTS[fault].recovered));
    if (state === "unreadable") await fs.writeFile(spill.indexPath, "{torn");
    if (fault) await plantSpillCustodyFault({ ...spill, m, logRef: handle.logRef }, fault);
    const bytes = await fs.readFile(spill.path), index = await fs.readFile(spill.indexPath).catch(() => null);
    // Cleanup runs in the parent server, without the instance writer's environment.
    vi.unstubAllEnvs();
    const { recorder, operations } = createRecorderDouble();
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: (await readWorktreeInstancePointer(workspacePath))!, workspaceId: "workspace-1", workspacePath,
      expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir, recorder,
    });
    expect(result.status).toBe(status);
    if (status === "refused") {
      expect(await fs.readFile(spill.path)).toEqual(bytes);
      expect(await fs.readFile(spill.indexPath).catch(() => null)).toEqual(index);
      expect(operations.at(-1)?.metadata).toMatchObject({ refusalReason: "run_log_spill_unrecovered",
        unrecoveredRunLogSpills: ["company/agent/run"] });
    } else await expect(fs.stat(instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7016708798
  // Keep reason: NEVER-OK trace custody. Real writer, spill bytes, index, and recursive instance removal.
  it.each([
    ["inside", "process", false], ["outside", "process", false],
    ["base", "process", false], ["default", "process", false],
    ["inside", "pointer", false], ["outside", "instance", false],
    ["inside", "cwd", false], ["inside", "relative", false],
    ["inside", "process", true],
  ] as const)("keeps a configured %s spill from %s until recovered=%s", async (location, source, recovered) => {
    const worktreesDir = await makeTempRoot("paperclip-configured-spill-");
    const workspacePath = await makeTempRoot("paperclip-configured-workspace-");
    const instanceId = "configured-spill";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);
    const spillRoot = location === "outside" ? path.join(worktreesDir, "outside-spill")
      : location === "default" ? path.join(instanceRoot, "data/run-logs/.spill")
      : location === "base" ? path.join(instanceRoot, "kept-run-logs/.spill")
      : path.join(instanceRoot, "kept-run-log-spill");
    vi.stubEnv("PAPERCLIP_HOME", worktreesDir);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", instanceId);
    vi.stubEnv("RUN_LOG_SPILL_PATH", undefined);
    vi.stubEnv("RUN_LOG_BASE_PATH", undefined);
    // Product keys: resolveObjectRunLogSpillDir reads RUN_LOG_SPILL_PATH before RUN_LOG_BASE_PATH.
    const key = location === "base" ? "RUN_LOG_BASE_PATH" : "RUN_LOG_SPILL_PATH";
    const value = source === "relative" ? path.relative(process.cwd(), spillRoot)
      : location === "base" ? path.dirname(spillRoot) : spillRoot;
    if (location !== "default") vi.stubEnv(key, value);
    const m = spillMemory();
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin({ ...ids, runId: "configured-cleanup" });
    m.state.down = true;
    const receipt = await store.enqueue!(handle, event(1, "the only copy of these source-less bytes"));
    const committed = receipt.committed.catch(() => undefined);
    await store.finalize(handle);
    await committed;
    const spill = await readObjectRunLogSpill(undefined, handle.logRef);
    expect(spill.path).toBe(path.join(spillRoot, `${handle.logRef}.ndjson`));
    expect(spill.unrecovered.length).toBeGreaterThan(0);
    if (recovered) {
      m.state.down = false;
      await store.recoverSpill!({ ...ids, runId: "configured-cleanup" });
      expect((await readObjectRunLogSpill(undefined, handle.logRef)).unrecovered.length).toBe(0);
    }
    const bytes = await fs.readFile(spill.path), marker = await fs.readFile(spill.indexPath);
    if (source !== "process" && source !== "relative") {
      const envPath = source === "pointer" ? path.join(workspacePath, ".paperclip/.env")
        : source === "cwd" ? path.join(workspacePath, ".env") : path.join(instanceRoot, ".env");
      await fs.appendFile(envPath, `${key}=${JSON.stringify(value)}\n`);
      vi.stubEnv(key, undefined);
    }
    const { recorder, operations } = createRecorderDouble();
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: (await readWorktreeInstancePointer(workspacePath))!, workspaceId: "workspace-1", workspacePath,
      expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir, recorder,
    });
    console.info("configured-spill-cleanup", { location, source, recovered, status: result.status,
      bytes: bytes.length, survived: await fs.stat(spill.path).then(() => true, () => false) });
    expect(result.status).toBe(recovered ? "removed" : "refused");
    if (!recovered) {
      expect(operations.at(-1)?.metadata).toMatchObject({ refusalReason: "run_log_spill_unrecovered" });
      expect((await fs.readFile(spill.path)).equals(bytes)).toBe(true);
      expect((await fs.readFile(spill.indexPath)).equals(marker)).toBe(true);
    }
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20787#issuecomment-7018965885
  // Keep reason: NEVER-OK trace custody. Real writer, changed guest env, real recursive removal.
  it.each(["guest", "drift", "unreadable", "recovered"] as const)("keeps an undiscoverable content spill (%s)", async mode => {
    const worktreesDir = await makeTempRoot("paperclip-content-instance-");
    const workspacePath = await makeTempRoot("paperclip-content-workspace-");
    const instanceId = "content-spill";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);
    const spill = await contentSpill(workspacePath, path.join(instanceRoot, "build"), mode);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: (await readWorktreeInstancePointer(workspacePath))!, workspaceId: "workspace-1", workspacePath,
      expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir,
    });
    const survived = await fs.stat(spill.path).then(() => true, () => false);
    console.info("content-custody-instance", { mode, result, survived });
    expect(result.status).toBe(mode === "recovered" ? "removed" : "refused");
    expect(survived).toBe(mode !== "recovered");
    if (survived) {
      await fs.chmod(spill.indexPath, 0o600);
      expect(await fs.readFile(spill.path)).toEqual(spill.bytes);
      expect(await fs.readFile(spill.indexPath)).toEqual(spill.index);
    }
  });

  // catch: rf-7 OBJLOG9 F1 (11-19); the bar: delete only on a positive record AND an equal read-back.
  // Keep reason: NEVER-OK trace custody. Real writer and store, real recursive removal; each fault planted and named.
  it.each(spillCustodyFaults)("keeps an instance whose content spill has unknown custody (%s)", async fault => {
    const worktreesDir = await makeTempRoot("paperclip-content-instance-");
    const workspacePath = await makeTempRoot("paperclip-content-workspace-");
    const instanceId = "content-spill";
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);
    const spill = await custodySpill(workspacePath, path.join(instanceRoot, "build"), fault);
    const warn = vi.spyOn(logger, "warn");
    const { recorder, operations } = createRecorderDouble();
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: (await readWorktreeInstancePointer(workspacePath))!, workspaceId: "workspace-1", workspacePath,
      expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir, recorder,
    });
    expect(result.status).toBe("refused");
    expect(operations.at(-1)?.metadata).toMatchObject({ refusalReason: "run_log_spill_content_kept" });
    expect(warn.mock.calls.filter(call => call[1] === SPILL_CUSTODY_ROW).map(call => call[0])).toContainEqual(
      expect.objectContaining({ reason: spill.reason,
        spill: path.join(await fs.realpath(instanceRoot), path.relative(instanceRoot, spill.path)) }));
    expect(await fs.readFile(spill.path)).toEqual(spill.bytes);
    expect(await fs.readFile(spill.indexPath).catch(() => null)).toEqual(spill.index);
  });

  // RFL rulings 11-20 (1) and (2).
  // catch: a kept instance was only a refusal inside one cleanup's result. Nothing listed
  // the instances being kept, so nobody could count them or tell them from abandoned disk.
  // Keep reason: NEVER-OK trace custody: what is kept, and why, must stay visible.
  // The real cleanup over real files; the spill is the real writer's, the local run log the real local store's.
  async function keptInstance(worktreesDir: string, instanceId: string) {
    const workspacePath = await makeTempRoot("paperclip-kept-workspace-");
    const instanceRoot = path.join(await fs.realpath(worktreesDir), "instances", instanceId);
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);
    const clean = async () => cleanupWorktreeInstanceArtifacts({
      pointer: (await readWorktreeInstancePointer(workspacePath))!, workspaceId: `workspace-${instanceId}`, workspacePath,
      expectedInstanceId: instanceId, expectedInstanceRoot: instanceRoot, worktreesDir });
    return { instanceId, instanceRoot, clean };
  }
  it("writes one custody row per kept instance, and the reader lists the kept set with its reasons", async () => {
    const worktreesDir = await makeTempRoot("paperclip-kept-instances-");
    // Kept for a spill: bytes object storage never took, at the writer's default root.
    const spilled = await keptInstance(worktreesDir, "kept-for-a-spill");
    const spillDir = path.join(spilled.instanceRoot, "data", "run-logs", ".spill");
    const m = spillMemory();
    const store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000, spillDir,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin({ ...ids, runId: "run" });
    m.state.down = true;
    const committed = (await store.enqueue!(handle, event(1, "admitted"))).committed.catch(() => undefined);
    await store.finalize(handle);
    await committed;
    const spill = await readObjectRunLogSpill(spillDir, handle.logRef);
    // Kept for a LOCAL run log: the local store's own file, with no spill record beside it.
    const local = await keptInstance(worktreesDir, "kept-for-a-local-run-log");
    const localStore = createDurableRunLogStore({ basePath: path.join(local.instanceRoot, "data", "run-logs") });
    const localHandle = await localStore.begin({ ...ids, runId: "run" });
    await localStore.append(localHandle, { stream: "stdout", chunk: "a local run log", ts: "2026-11-20T00:00:00Z" });
    await localStore.finalize(localHandle);
    const localLog = path.join(local.instanceRoot, "data", "run-logs", localHandle.logRef);
    const localBytes = await fs.readFile(localLog);
    // Control: an instance that holds no run-log bytes is removed and gets no row.
    const empty = await keptInstance(worktreesDir, "holds-nothing");

    expect([(await spilled.clean()).status, (await local.clean()).status, (await empty.clean()).status])
      .toEqual(["refused", "refused", "removed"]);

    const rowsDir = path.join(worktreesDir, "instances", ".run-log-custody");
    expect((await fs.readdir(rowsDir)).sort()).toEqual(["kept-for-a-local-run-log.json", "kept-for-a-spill.json"]);
    const rows = [
      { v: 1, instance: "kept-for-a-local-run-log", instanceRoot: local.instanceRoot, path: localLog, reason: "index_missing",
        keptPaths: 1, at: expect.any(String) },
      { v: 1, instance: "kept-for-a-spill", instanceRoot: spilled.instanceRoot, path: spill.path, reason: "unrecovered",
        keptPaths: 1, at: expect.any(String) },
    ];
    expect(await Promise.all(rows.map(async row => JSON.parse(await fs.readFile(path.join(rowsDir, `${row.instance}.json`), "utf8")))))
      .toEqual(rows);
    expect(await listKeptWorktreeInstances(worktreesDir)).toEqual(rows);
    expect((await fs.readFile(localLog)).equals(localBytes)).toBe(true);
    expect((await fs.readFile(spill.path)).length).toBe(spill.unrecovered.length);

    // A later pass that can prove the spill recovered releases the instance and takes its row.
    m.state.down = false;
    await store.recoverSpill!({ ...ids, runId: "run" });
    expect((await spilled.clean()).status).toBe("removed");
    expect(await listKeptWorktreeInstances(worktreesDir)).toEqual([rows[0]]);
  });

  it.each([
    ["another tool's records, in no run-log shape", `${JSON.stringify({ id: 1, stream: "orders", chunk: 7 })}\n`.repeat(3)],
    ["bytes that decode as nothing", Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x0a])],
  ])("keeps an instance whose spill directory holds %s", async (_case, contents) => {
    const worktreesDir = await makeTempRoot("paperclip-kept-instances-");
    const instance = await keptInstance(worktreesDir, "spill-dir-file");
    const file = path.join(instance.instanceRoot, "data", "run-logs", ".spill", "company", "agent", "run.ndjson");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
    expect((await instance.clean()).status).toBe("refused");
    expect(Buffer.from(contents).equals(await fs.readFile(file))).toBe(true);
    expect(await listKeptWorktreeInstances(worktreesDir)).toEqual([
      expect.objectContaining({ instance: "spill-dir-file", path: file, reason: "index_missing" })]);
  });

  it("control: another tool's *.ndjson outside the spill directory does not keep an instance", async () => {
    const worktreesDir = await makeTempRoot("paperclip-kept-instances-");
    const instance = await keptInstance(worktreesDir, "other-tool");
    const file = path.join(instance.instanceRoot, "tools", "export", "orders.ndjson");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ id: 1, stream: "orders", chunk: 7 })}\n`.repeat(3));
    expect((await instance.clean()).status).toBe("removed");
    await expect(fs.stat(instance.instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(worktreesDir, "instances", ".run-log-custody", "other-tool.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a collision-resistant active instance when persisted ownership is absent", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceId = deriveWorktreeInstanceId(workspacePath);
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "marker"), "remove me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, instanceId);

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: instanceId,
      expectedInstanceRoot: null,
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot });
    expect((result as { warning: string }).warning).toContain("no persisted instance root");
    await expect(fs.readFile(path.join(instanceRoot, "marker"), "utf8")).resolves.toBe("remove me");
  });

  it("refuses and logs an instance pointer outside the managed worktree root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const liveHome = await makeTempRoot("paperclip-live-home-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const liveInstanceRoot = path.join(liveHome, "instances", "default");
    await fs.mkdir(liveInstanceRoot, { recursive: true });
    await fs.writeFile(path.join(liveInstanceRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, liveHome, "default");
    const { recorder, operations } = createRecorderDouble();
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "default",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "default"),
      worktreesDir,
      recorder,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: liveInstanceRoot });
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(liveInstanceRoot, "marker"), "utf8")).toBe("keep me");
    expect(operations).toEqual([
      expect.objectContaining({
        status: "skipped",
        metadata: expect.objectContaining({
          cleanupAction: "remove_worktree_instance",
          refusalReason: "outside_managed_instances_dir",
        }),
      }),
    ]);
  });

  it("treats a missing repo-local env file as a no-op", async () => {
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    await expect(readWorktreeInstancePointer(workspacePath)).resolves.toBeNull();
  });

  it("captures the managed instance root for persisted workspace ownership", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceRoot = path.join(worktreesDir, "instances", "owned-instance");
    await fs.mkdir(instanceRoot, { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, "owned-instance");

    await expect(
      readManagedWorktreeInstanceOwnership(workspacePath, worktreesDir),
    ).resolves.toEqual({ instanceId: "owned-instance", instanceRoot });
  });
  it("stops embedded Postgres before deleting the instance root", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instanceRoot = path.join(worktreesDir, "instances", "ordered-cleanup");
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await writeWorkspaceEnv(workspacePath, worktreesDir, "ordered-cleanup");
    const calls: string[] = [];

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "ordered-cleanup",
      expectedInstanceRoot: instanceRoot,
      worktreesDir,
      dependencies: {
        stopEmbeddedPostgres: async (dataDir) => {
          expect(dataDir).toBe(path.join(instanceRoot, "db"));
          expect(await fs.stat(instanceRoot)).toBeDefined();
          calls.push("stop");
          return true;
        },
        removeInstanceRoot: async (target) => {
          calls.push("remove");
          await fs.rm(target, { recursive: true, force: true });
        },
      },
    });

    expect(result).toMatchObject({ status: "removed", postgresStopped: true });
    expect(calls).toEqual(["stop", "remove"]);
  });

  it("refuses a pointer rewritten to another workspace's managed instance", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const siblingInstanceRoot = path.join(worktreesDir, "instances", "feature-sibling");
    await fs.mkdir(path.join(siblingInstanceRoot, "db"), { recursive: true });
    await fs.writeFile(path.join(siblingInstanceRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "feature-sibling");
    const { recorder, operations } = createRecorderDouble();
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "feature-sibling",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "feature-owner"),
      worktreesDir,
      recorder,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: siblingInstanceRoot });
    expect((result as { warning: string }).warning).toContain("persisted instance root");
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(siblingInstanceRoot, "marker"), "utf8")).toBe("keep me");
    expect(operations).toEqual([
      expect.objectContaining({
        status: "skipped",
        metadata: expect.objectContaining({
          expectedInstanceRoot: path.join(worktreesDir, "instances", "feature-owner"),
          refusalReason: "instance_root_workspace_mismatch",
        }),
      }),
    ]);
  });
  it("refuses a managed-root symlink that canonically escapes the guard", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const outsideRoot = await makeTempRoot("paperclip-outside-instance-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const instancesDir = path.join(worktreesDir, "instances");
    await fs.mkdir(instancesDir, { recursive: true });
    await fs.symlink(outsideRoot, path.join(instancesDir, "escaped"), "dir");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "escaped");

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "escaped",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "escaped"),
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect((result as { warning: string }).warning).toContain("canonical path");
    await expect(fs.stat(outsideRoot)).resolves.toBeDefined();
  });

  it("refuses when the managed instances directory itself is a symlink", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const liveInstancesDir = await makeTempRoot("paperclip-live-instances-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const liveInstanceRoot = path.join(liveInstancesDir, "default");
    await fs.mkdir(liveInstanceRoot, { recursive: true });
    await fs.symlink(liveInstancesDir, path.join(worktreesDir, "instances"), "dir");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "default");

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "default",
      expectedInstanceRoot: path.join(worktreesDir, "instances", "default"),
      worktreesDir,
    });

    expect(result).toMatchObject({ status: "refused" });
    expect((result as { warning: string }).warning).toContain("managed instances directory");
    await expect(fs.stat(liveInstanceRoot)).resolves.toBeDefined();
  });
  it("refuses an instance pointer that belongs to a sibling worktree", async () => {
    const worktreesDir = await makeTempRoot("paperclip-managed-worktrees-");
    const workspacePath = await makeTempRoot("paperclip-cleanup-workspace-");
    const siblingRoot = path.join(worktreesDir, "instances", "sibling-worktree");
    await fs.mkdir(siblingRoot, { recursive: true });
    await fs.writeFile(path.join(siblingRoot, "marker"), "keep me", "utf8");
    await writeWorkspaceEnv(workspacePath, worktreesDir, "sibling-worktree");
    const stopEmbeddedPostgres = vi.fn(async () => false);
    const removeInstanceRoot = vi.fn(async () => {});

    const pointer = await readWorktreeInstancePointer(workspacePath);
    const result = await cleanupWorktreeInstanceArtifacts({
      pointer: pointer!,
      workspaceId: "workspace-1",
      workspacePath,
      expectedInstanceId: "owned-worktree",
      expectedInstanceRoot: null,
      worktreesDir,
      dependencies: { stopEmbeddedPostgres, removeInstanceRoot },
    });

    expect(result).toMatchObject({ status: "refused", instanceRoot: siblingRoot });
    expect((result as { warning: string }).warning).toContain("expected workspace instance");
    expect(stopEmbeddedPostgres).not.toHaveBeenCalled();
    expect(removeInstanceRoot).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(siblingRoot, "marker"), "utf8")).toBe("keep me");
  });

  it("treats an ESRCH signal race as an already-stopped PostgreSQL process", async () => {
    const instanceRoot = await makeTempRoot("paperclip-postgres-exit-race-");
    const dataDir = path.join(instanceRoot, "db");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "postmaster.pid"), `4242\n${dataDir}\n`, "utf8");
    const signalError = Object.assign(new Error("process exited"), { code: "ESRCH" });

    await expect(stopEmbeddedPostgresIfRunning(dataDir, {
      processIsAlive: () => true,
      readVerifiedPostgresCommand: async () => `postgres -D ${dataDir}`,
      signalProcess: () => { throw signalError; },
      wait: async () => {},
    })).resolves.toBe(false);
  });
});
