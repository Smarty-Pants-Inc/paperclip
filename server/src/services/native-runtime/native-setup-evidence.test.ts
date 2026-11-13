import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupNativeSetupRuntime, createNativeSetupRuntime } from "./native-setup-evidence.js";

async function fixture() {
  const state = await mkdtemp(join(tmpdir(), "setup-evidence-safety-"));
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", state);
  return state;
}
afterEach(() => vi.unstubAllEnvs());

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

it("still removes scratch without Pi history for a non-Pi probe", async () => {
  await fixture();
  const root = await createNativeSetupRuntime("company");
  await writeFile(join(root, "scratch.txt"), "disposable scratch");
  await cleanupNativeSetupRuntime(root);
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});
