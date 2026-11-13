import { mkdtemp, mkdir, lstat, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { retainNativePiConversationEvidence } from "./native-pi-conversation-evidence.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const scope = "a".repeat(64);
async function fixture(directory = "pi") {
  const base = await mkdtemp(join(tmpdir(), "pi-retention-boundary-")); roots.push(base);
  const source = join(base, scope, "failover-backups", "previous");
  await mkdir(join(source, directory, "sessions"), { recursive: true });
  await writeFile(join(source, directory, "sessions", "only.jsonl"), "only native conversation bytes\n");
  return { base, source, directory, evidence: join(base, "conversation-evidence") };
}

// Data safety + private owner scope: actual shared cleanup, not mocked deletion.
it.each(["pi", "pi-agent", "acpx/conversation/pi-home", "legacy/.pi"])(
  "retains a scoped %s history on shared publication cleanup", async directory => {
    const f = await fixture(directory);
    await removeNativeHarnessBackup(f.source);
    await expect(lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    const scoped = join(f.evidence, scope);
    const [leaf] = await readdir(scoped);
    expect((await lstat(scoped)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(scoped, leaf, directory, "sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
    for (const target of [f.evidence, scoped, join(scoped, leaf)]) {
      await expect(removeNativeHarnessBackup(target)).rejects.toThrow("native_pi_evidence_not_expirable");
    }
    expect(await readFile(join(scoped, leaf, directory, "sessions/only.jsonl"), "utf8")).toBe("only native conversation bytes\n");
  },
);
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
  expect(await readlink(join(scoped, leaf, "pi/only.jsonl.invalid-foreign"))).toBe(outside);
  expect(await readFile(outside, "utf8")).toBe("foreign-owner conversation\n");
});
