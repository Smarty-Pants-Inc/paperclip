import { createHash } from "node:crypto";
import { mkdtemp, mkdir, lstat, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { logger } from "../../middleware/logger.js";
vi.mock("../../middleware/logger.js", () => ({ logger: { info: vi.fn() } }));

const fsyncDirectories = vi.hoisted(() => [] as string[]);
const filesystemEvents = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const paths = new Map<number, string>();
  return {
    ...actual,
    openSync: (directory: string, ...args: unknown[]) => {
      const descriptor = actual.openSync(directory, ...(args as [number, number?]));
      paths.set(descriptor, String(directory));
      return descriptor;
    },
    fsyncSync: (descriptor: number) => {
      const directory = paths.get(descriptor) ?? "unknown";
      fsyncDirectories.push(directory);
      filesystemEvents.push(`fsync:${directory}`);
      return actual.fsyncSync(descriptor);
    },
  };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      filesystemEvents.push("rename");
      return actual.rename(...args);
    },
  };
});
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { retainNativePiConversationEvidence, retainNativeRuntimeEvidence } from "./native-pi-conversation-evidence.js";

const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = "a".repeat(64);
async function fixture(directory = "pi") {
  const base = await mkdtemp(join(tmpdir(), "pi-retention-boundary-")); roots.push(base);
  const source = join(base, scope, "failover-backups", "previous");
  await mkdir(join(source, directory, "sessions"), { recursive: true });
  await writeFile(join(source, directory, "sessions", "only.jsonl"), "only native conversation bytes\n");
  return { base, source, directory, evidence: join(base, "conversation-evidence") };
}

// Data safety + private owner scope: actual shared cleanup, not mocked deletion.
it("retains a renamed Pi JSONL session by its first-line header and preserves its bytes", async () => {
  const f = await fixture();
  await rm(join(f.source, f.directory), { recursive: true, force: true });
  const bytes = Buffer.from('{"type":"session","version":3,"id":"abc123","timestamp":"2026-11-13T09:00:00.000Z","cwd":"/tmp"}\n{"type":"message","id":"m1"}\n');
  const file = join(f.source, "renamed.data");
  await writeFile(file, bytes);
  const before = createHash("sha256").update(bytes).digest("hex");

  await removeNativeHarnessBackup(f.source);

  await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  const [leaf] = await readdir(join(f.evidence, scope));
  expect(createHash("sha256").update(await readFile(join(f.evidence, scope, leaf!, "renamed.data"))).digest("hex")).toBe(before);
});

it("fails closed and retains bytes when a candidate first line exceeds the scan bound", async () => {
  const f = await fixture();
  await rm(join(f.source, f.directory), { recursive: true, force: true });
  const bytes = Buffer.alloc(4 * 1024 + 8, 0x61);
  await writeFile(join(f.source, "opaque.bin"), bytes);

  await removeNativeHarnessBackup(f.source);

  await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  const [leaf] = await readdir(join(f.evidence, scope));
  expect(createHash("sha256").update(await readFile(join(f.evidence, scope, leaf!, "opaque.bin"))).digest("hex"))
    .toBe(createHash("sha256").update(bytes).digest("hex"));
});

it.each(["pi", "pi-agent", "acpx/conversation/pi-home", "legacy/.pi"])(
  "retains a scoped %s history on shared publication cleanup", async directory => {
    const f = await fixture(directory);
    await removeNativeHarnessBackup(f.source);
    await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    const scoped = join(f.evidence, scope);
    const [leaf] = await readdir(scoped);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith({ event: "native_evidence_retained", source: f.source,
      destination: join(scoped, leaf!), scope, totalBytes: 31, fileCount: 1 });
    expect((await lstat(scoped)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(scoped, leaf, directory, "sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
    for (const target of [f.evidence, scoped, join(scoped, leaf)]) {
      await expect(removeNativeHarnessBackup(target)).rejects.toThrow("native_pi_evidence_not_expirable");
    }
    expect(await readFile(join(scoped, leaf, directory, "sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
  },
);
it("leaves the sole source intact and emits no success log if inventory exceeds its depth bound", async () => {
  const f = await fixture();
  await mkdir(join(f.source, ...Array.from({ length: 129 }, () => "deep")), { recursive: true });
  await expect(retainNativeRuntimeEvidence(f.source)).rejects.toThrow("native_evidence_inventory_limit");
  expect(await readFile(join(f.source, "pi/sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
  expect(logger.info).not.toHaveBeenCalled();
});

it("syncs both rename parents after retaining the source tree", async () => {
  const f = await fixture();
  fsyncDirectories.length = 0;
  filesystemEvents.length = 0;
  expect(await retainNativePiConversationEvidence(f.source)).toBe(true);
  expect(fsyncDirectories).toContain(f.base);
  expect(fsyncDirectories).toContain(join(f.evidence, scope));
  const renameIndex = filesystemEvents.indexOf("rename");
  expect(renameIndex).toBeGreaterThanOrEqual(0);
  expect(filesystemEvents.slice(renameIndex + 1)).toContain(`fsync:${join(f.base, scope, "failover-backups")}`);
  expect(filesystemEvents.slice(renameIndex + 1)).toContain(`fsync:${join(f.evidence, scope)}`);
});
it("fails closed without deleting source when the private evidence directory is replaced by a symlink", async () => {
  const f = await fixture(), outside = join(f.base, "other-owner");
  await mkdir(outside); await symlink(outside, f.evidence);
  await expect(removeNativeHarnessBackup(f.source)).rejects.toThrow("native_pi_evidence_directory_unsafe");
  expect(await readFile(join(f.source, "pi/sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
  expect(await readdir(outside)).toEqual([]);
});
it("keeps an invalid symlink aside without following it into another owner's bytes", async () => {
  const f = await fixture(), outside = join(f.base, "foreign.jsonl");
  await writeFile(outside, "foreign-owner conversation\n");
  await symlink(outside, join(f.source, "pi/only.jsonl.invalid-foreign"));
  expect(await retainNativePiConversationEvidence(f.source)).toBe(true);
  const scoped = join(f.evidence, scope), [leaf] = await readdir(scoped);
  expect(logger.info).toHaveBeenCalledExactlyOnceWith({ event: "native_evidence_retained", source: f.source,
    destination: join(scoped, leaf!), scope, totalBytes: 31 + Buffer.byteLength(outside), fileCount: 2 });
  expect(await readlink(join(scoped, leaf, "pi/only.jsonl.invalid-foreign"))).toBe(outside);
  expect(await readFile(outside, "utf8")).toBe("foreign-owner conversation\n");
});
