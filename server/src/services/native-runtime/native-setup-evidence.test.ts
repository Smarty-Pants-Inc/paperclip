import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupNativeSetupRuntime, createNativeSetupRuntime } from "./native-setup-evidence.js";
import { logger } from "../../middleware/logger.js";

vi.mock("../../middleware/logger.js", () => ({ logger: { info: vi.fn() } }));

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "setup-evidence-safety-"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", state);
  return state;
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

// Keep: company isolation and sole-copy data safety. All filesystem operations
// are real. Evidence fixtures deliberately survive the test process.
it("retains metadata-only raw diagnostics in separate private company scopes", async () => {
  const state = await fixture();
  const first = await createNativeSetupRuntime("first-company");
  const second = await createNativeSetupRuntime("second-company");
  await writeFile(join(first, "provider-trace.ndjson"), "opaque first\n");
  await writeFile(join(second, "provider-trace.ndjson"), "opaque second\n");
  await cleanupNativeSetupRuntime(first, true);
  await cleanupNativeSetupRuntime(second, true);
  for (const [source, totalBytes] of [[first, 13], [second, 14]] as const) expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
    event: "native_evidence_retained", source, destination: expect.any(String), scope: expect.any(String), totalBytes, fileCount: 1,
  }));
  const evidence = join(state, "conversation-evidence");
  expect((await lstat(evidence)).mode & 0o777).toBe(0o700);
  const scopes = await readdir(evidence);
  expect(scopes).toHaveLength(2);
  const values: string[] = [];
  for (const scope of scopes) {
    const directory = join(evidence, scope);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    const [id] = await readdir(directory);
    values.push(await readFile(join(directory, id!, "provider-trace.ndjson"), "utf8"));
  }
  expect(values.sort()).toEqual(["opaque first\n", "opaque second\n"]);
  await expect(lstat(first)).rejects.toMatchObject({ code: "ENOENT" });
  await cleanupNativeSetupRuntime(first, true); // repeated retirement is safe
});

it.each(["symlink", "public"])("leaves the sole source intact when evidence is %s", async kind => {
  const state = await fixture();
  const root = await createNativeSetupRuntime("company");
  await mkdir(join(root, "pi"));
  const history = join(root, "pi", "history.jsonl");
  await writeFile(history, "opaque original\n");
  const evidence = join(state, "conversation-evidence");
  if (kind === "symlink") {
    const outside = join(state, "outside"); await mkdir(outside);
    await symlink(outside, evidence);
  } else { await mkdir(evidence, { mode: 0o755 }); await chmod(evidence, 0o755); }
  await expect(cleanupNativeSetupRuntime(root, true)).rejects.toThrow("native_pi_evidence_directory_unsafe");
  expect(await readFile(history, "utf8")).toBe("opaque original\n");
});

it("pulls real raw bytes through the existing backup tar path before source retirement", async () => {
  const state = await fixture();
  const local = await createNativeSetupRuntime("remote-company");
  const remote = join(state, "remote-setup");
  await mkdir(join(remote, "pi"), { recursive: true, mode: 0o700 });
  const bytes = process.env.PAPERCLIP_SETUP_RETENTION_INPUT
    ? await readFile(process.env.PAPERCLIP_SETUP_RETENTION_INPUT) : Buffer.from("opaque provider-owned history\n");
  await writeFile(join(remote, "pi", "history.jsonl"), bytes, { mode: 0o600 });
  const execute = promisify(execFile);
  const { syncRemoteRunnerDirectoryOut } = await import("./native-session-executor.js");
  await syncRemoteRunnerDirectoryOut({ sourcePath: remote, targetPath: join(local, "remote-runtime"), mode: 0o700,
    runner: { execute: async input => {
      try {
        const result = await execute(input.command, [...input.args ?? []], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        return { ...result, exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: null };
      } catch (error) { throw error; }
    } },
  });
  await cleanupNativeSetupRuntime(local, true);
  const evidence = join(state, "conversation-evidence");
  const [scope] = await readdir(evidence), [id] = await readdir(join(evidence, scope!));
  const retained = join(evidence, scope!, id!, "remote-runtime", "pi", "history.jsonl");
  expect(await readFile(retained)).toEqual(bytes);
  // The bytes have a verified permanent copy before the physical source rm.
  await execute("rm", ["-rf", "--", remote]);
  expect(await readFile(retained)).toEqual(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(state, "remote-transfer-receipt.json"), JSON.stringify({ retained, bytes: bytes.length, beforeSha256: sha256,
    afterSha256: createHash("sha256").update(await readFile(retained)).digest("hex"), sourceRemoved: true }, null, 2));
}, 60_000);

it("retains records while excluding only the audited runner binary and compile cache at both evidence copies", async () => {
  const state = await fixture();
  const local = await createNativeSetupRuntime("static-exclusion-company");
  const remote = join(state, "remote-static-tree");
  const cache = join(remote, "pi", "node-compile-cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await mkdir(join(remote, "bin"), { recursive: true, mode: 0o700 });
  await writeFile(join(remote, "bin", "paperclip-runnerd"), Buffer.alloc(1024 * 1024, 7));
  for (let i = 0; i < 100; i++) await writeFile(join(cache, `cache-${i}.blob`), Buffer.alloc(1024, i));
  const retainedFiles = [
    "control-plane/metadata.json", "diagnostics/stderr", "runner/state.json",
    "pi/setup-probe-123.jsonl", "stdout.log", "stderr.log", "unknown-new-file.bin",
  ];
  for (const entry of retainedFiles) {
    const path = join(remote, entry);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, entry === "diagnostics/stderr" ? Buffer.alloc(0) : Buffer.from(`record:${entry}`), { mode: 0o600 });
  }
  const execute = promisify(execFile);
  const { syncRemoteRunnerDirectoryOut } = await import("./native-session-executor.js");
  const localCopy = join(local, "remote-runtime");
  await syncRemoteRunnerDirectoryOut({ sourcePath: remote, targetPath: localCopy, mode: 0o700,
    excludeEntries: ["bin/paperclip-runnerd", "pi/node-compile-cache"], runner: { execute: async input => {
      const result = await execute(input.command, [...input.args ?? []], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return { ...result, exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: null };
    } } });
  const inventory = async (root: string): Promise<{ bytes: number; paths: string[] }> => {
    let bytes = 0; const paths: string[] = [];
    const visit = async (directory: string, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
        else { bytes += (await lstat(join(directory, entry.name))).size; paths.push(relative); }
      }
    };
    await visit(root);
    return { bytes, paths };
  };
  const beforeRetention = await inventory(localCopy);
  expect(beforeRetention.bytes).toBe(150);
  expect(beforeRetention.paths).not.toContain("bin/paperclip-runnerd");
  expect(beforeRetention.paths.some(path => path.startsWith("pi/node-compile-cache/"))).toBe(false);
  for (const entry of retainedFiles) expect(beforeRetention.paths).toContain(entry);
  expect(await lstat(join(localCopy, "diagnostics", "stderr")).then(item => item.size)).toBe(0);
  await cleanupNativeSetupRuntime(local, true);
  const evidence = join(state, "conversation-evidence");
  const [scope] = await readdir(evidence), [id] = await readdir(join(evidence, scope!));
  const durable = join(evidence, scope!, id!, "remote-runtime");
  const afterRetention = await inventory(durable);
  expect(afterRetention.bytes).toBe(beforeRetention.bytes);
  expect(afterRetention.bytes).toBe(150);
  expect(afterRetention.paths).not.toContain("bin/paperclip-runnerd");
  expect(afterRetention.paths.some(path => path.startsWith("pi/node-compile-cache/"))).toBe(false);
  for (const entry of retainedFiles) expect(afterRetention.paths).toContain(entry);
  console.info(`probe static byte check before=${beforeRetention.bytes} after=${afterRetention.bytes}; excluded runner=1048576 cache=102400`);
}, 60_000);

it("fails closed when cleanup did not create the source", async () => {
  const root = await fixture(); // An arbitrary existing tree is not setup scratch.
  const trace = join(root, "raw-session.ndjson");
  await writeFile(trace, "sole copy\n");
  await expect(cleanupNativeSetupRuntime(root, true)).rejects.toThrow("native_setup_evidence_not_owned");
  expect(await readFile(trace, "utf8")).toBe("sole copy\n");
  expect(logger.info).not.toHaveBeenCalled();
});

// Keep: the full-server regression reads runtime-context.json again on a warm
// session. Setup cleanup must never retire that live root, even if misdirected.
it.each([
  { wholeTree: false, piHistory: false }, { wholeTree: true, piHistory: false },
  { wholeTree: false, piHistory: true }, { wholeTree: true, piHistory: true },
])("refuses a live session root during setup cleanup ($wholeTree, Pi=$piHistory)", async ({ wholeTree, piHistory }) => {
  const state = await fixture();
  const live = join(state, "f".repeat(64));
  await mkdir(live, { mode: 0o700 });
  const context = join(live, "runtime-context.json");
  await writeFile(context, '{"session":"live"}\n');
  if (piHistory) {
    await mkdir(join(live, "pi"));
    await writeFile(join(live, "pi", "history.jsonl"), "live history\n");
  }
  const setup = await createNativeSetupRuntime("company");
  await writeFile(join(setup, "provider-trace.ndjson"), "retired probe\n");
  await cleanupNativeSetupRuntime(setup, true);
  expect(await readFile(context, "utf8")).toBe('{"session":"live"}\n');
  let cleanupError: unknown;
  try { await cleanupNativeSetupRuntime(live, wholeTree); } catch (error) { cleanupError = error; }
  // Read before checking the refusal: on the regressed code this is the same
  // ENOENT as the full-server context read, not merely a mock-call mismatch.
  expect(await readFile(context, "utf8")).toBe('{"session":"live"}\n');
  if (piHistory) expect(await readFile(join(live, "pi", "history.jsonl"), "utf8")).toBe("live history\n");
  expect(cleanupError).toMatchObject({ message: "native_setup_evidence_not_owned" });
  expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ source: live }));
});

it("refuses a replacement directory at a previously owned scratch path", async () => {
  await fixture();
  const root = await createNativeSetupRuntime("company");
  await writeFile(join(root, "provider-trace.ndjson"), "original evidence\n");
  await rename(root, `${root}.original`);
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "runtime-context.json"), "foreign replacement\n");
  await expect(cleanupNativeSetupRuntime(root, true)).rejects.toThrow("native_setup_evidence_not_owned");
  expect(await readFile(join(root, "runtime-context.json"), "utf8")).toBe("foreign replacement\n");
  expect(await readFile(join(`${root}.original`, "provider-trace.ndjson"), "utf8")).toBe("original evidence\n");
  expect(logger.info).not.toHaveBeenCalled();
});

it("still removes scratch without Pi history for a non-Pi probe", async () => {
  await fixture();
  const root = await createNativeSetupRuntime("company");
  await writeFile(join(root, "scratch.txt"), "disposable scratch");
  await cleanupNativeSetupRuntime(root);
  expect(logger.info).toHaveBeenCalledWith({ event: "native_scratch_removed", path: root, totalBytes: 18, fileCount: 1 });
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});
