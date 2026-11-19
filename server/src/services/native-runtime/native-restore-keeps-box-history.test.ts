// smarty-dev#21273 round 2 (review-fleet-3, #20787 comment 7003852636): a
// resumed rotation on a box without either Runner-state copy prepares the host,
// which restores the verified failover backup. When the box already holds a
// different, valid Pi conversation, that restore must never copy the older
// backup over it. Real shell staging (tar) and the pack's own Pi validator.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { probePiSessionResumeFile } from "./pi-session-file-repair.js";
import { RESTORE_TARGET_HISTORY_DIFFERS, restoreHarnessBackupKeepingRemoteHistory } from "./native-session-executor.js";

const roots: string[] = [];
let providerPackRoot: string;
beforeAll(async () => {
  providerPackRoot = await mkdtemp(join(tmpdir(), "restore-history-validator-"));
  roots.push(providerPackRoot);
  await build({ entryPoints: [resolve(import.meta.dirname, "../../../../packages/paperclip-runner/src/drivers/pi/pi-session-file.ts")],
    outfile: join(providerPackRoot, "dist/drivers/pi/pi-session-file.js"), bundle: true, platform: "node", format: "esm" });
  await writeFile(join(providerPackRoot, "package.json"), JSON.stringify({ type: "module" }));
});
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
const message = (id: string, parentId: string | null, role: string, text: string) =>
  line({ type: "message", id, parentId, timestamp: "2026-11-19T07:00:00.000Z", message: { role, content: [{ type: "text", text }] } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "restore-keeps-box-history-"));
  roots.push(root);
  const sessionId = randomUUID(), filename = `${sessionId}.jsonl`;
  const header = (id = sessionId) => line({ type: "session", version: 3, id, timestamp: "2026-11-19T06:00:00.000Z", cwd: root });
  // The failover backup: the conversation as of the last checkpoint.
  const older = header() + message("u1", null, "user", "Fix the build") + message("a1", "u1", "assistant", "Looking at it");
  // The box's newer copy of the same conversation: one more assistant message.
  const newer = older + message("u2", "a1", "user", "Any luck?") + message("a2", "u2", "assistant", "Fixed: the import path was wrong");
  const backup = join(root, "backup"), box = join(root, "box");
  await mkdir(join(backup, "runner"), { recursive: true });
  await mkdir(join(backup, "pi-agent", "sessions"), { recursive: true });
  const suspended = JSON.stringify({ schema: "paperclip.runner.durable.state.v1", lifecycle: "suspended", runId: "prior" });
  await writeFile(join(backup, "runner", "runner-state.json"), suspended);
  await writeFile(join(backup, "pi-agent", "sessions", filename), older);
  await mkdir(box);
  const boxSessions = join(box, "pi-agent", "sessions"), boxSession = join(boxSessions, filename);
  const runnerState = join(box, "runner", "runner-state.json");
  const runner: CommandManagedRuntimeRunner = { execute: input => runChildProcess(`restore-history-${randomUUID()}`,
    input.command, input.args ?? [], { cwd: root, env: {}, timeoutSec: (input.timeoutMs ?? 60_000) / 1000, graceSec: 1,
      stdin: input.stdin, onLog: async () => {} }) };
  const restore = () => restoreHarnessBackupKeepingRemoteHistory({
    target: { kind: "remote" } as never, runner, backupRoot: backup,
    directories: [{ name: "runner", targetPath: join(box, "runner") }, { name: "pi-agent", targetPath: join(box, "pi-agent") }],
  });
  const validate = (id = sessionId) => probePiSessionResumeFile({ runner, node: process.execPath, providerPackRoot,
    directory: boxSessions, filename, normalizedSessionId: sessionId, providerSessionId: id, providerBackendSessionId: id,
    workingDirectory: root });
  return { root, header, older, newer, boxSessions, boxSession, runnerState, suspended, restore, validate };
}

it.each([
  ["a newer copy of the same conversation", "same"],
  ["a different conversation under the same file", "different"],
] as const)("RED-FIRST: a box holding %s keeps it byte-identical and readable; the older backup is refused", async (_label, shape) => {
  const f = await fixture();
  const otherId = randomUUID();
  const onBox = shape === "same" ? f.newer
    : f.header(otherId) + message("x1", null, "user", "A different task") + message("x2", "x1", "assistant", "Different answer");
  await mkdir(f.boxSessions, { recursive: true });
  await writeFile(f.boxSession, onBox);
  // review-fleet-3's shape: neither Runner-state copy is on the box.
  expect(existsSync(f.runnerState)).toBe(false);
  expect(await f.validate(shape === "same" ? undefined : otherId)).toBe("valid");

  const outcome = await f.restore().then(() => "restored", (error: Error) => error.message);

  // Checked first, so an overwrite shows the lost bytes.
  expect(await readFile(f.boxSession, "utf8")).toBe(onBox);
  expect(outcome).toBe(RESTORE_TARGET_HISTORY_DIFFERS);
  expect(await f.validate(shape === "same" ? undefined : otherId)).toBe("valid");
  // The refusal stages nothing: no Runner state appears beside the kept history.
  expect(existsSync(f.runnerState)).toBe(false);
});

it("an empty new box receives the verified backup (Runner state and the Pi conversation)", async () => {
  const f = await fixture();
  await f.restore();
  expect(await readFile(f.boxSession, "utf8")).toBe(f.older);
  expect(await readFile(f.runnerState, "utf8")).toBe(f.suspended);
  expect(await f.validate()).toBe("valid");
});

it("a box holding an older prefix of the same history (nothing to lose) receives the backup", async () => {
  const f = await fixture();
  await mkdir(f.boxSessions, { recursive: true });
  await writeFile(f.boxSession, f.header() + message("u1", null, "user", "Fix the build"));
  expect(f.older.startsWith(await readFile(f.boxSession, "utf8"))).toBe(true);
  await f.restore();
  expect(await readFile(f.boxSession, "utf8")).toBe(f.older);
  expect(await f.validate()).toBe("valid");
});

it("a symbolic link at the conversation path is kept, not followed or replaced", async () => {
  const f = await fixture();
  await mkdir(f.boxSessions, { recursive: true });
  const elsewhere = join(f.root, "elsewhere.jsonl");
  await writeFile(elsewhere, f.newer);
  await symlink(elsewhere, f.boxSession);
  await expect(f.restore()).rejects.toThrow(RESTORE_TARGET_HISTORY_DIFFERS);
  expect((await lstat(f.boxSession)).isSymbolicLink()).toBe(true);
  expect(await readlink(f.boxSession)).toBe(elsewhere);
  expect(await readFile(elsewhere, "utf8")).toBe(f.newer);
  expect(existsSync(f.runnerState)).toBe(false);
});
