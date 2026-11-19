// smarty-dev#21273 round 2 (review-fleet-3, #20787 comment 7003852636): a
// resumed rotation on a box without either Runner-state copy prepares the host,
// which restores the verified failover backup. When the box already holds a
// different, valid Pi conversation, that restore must never copy the older
// backup over it. Real shell staging (tar) and the pack's own Pi validator.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { probePiSessionResumeFile } from "./pi-session-file-repair.js";
import { RESTORE_TARGET_HISTORY_DIFFERS, RESTORE_TARGET_HOLDS_OTHER_CONVERSATION, RESTORE_TARGET_KEPT_PERSON_LINE,
  restoreHarnessBackupKeepingRemoteHistory, restoreTargetHoldsOtherConversationCode } from "./native-session-executor.js";

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
  // A provider runner's native syncIn: a directory is destroyed, then replaced.
  const replacingRunner: CommandManagedRuntimeRunner = { execute: runner.execute, syncIn: async operations => {
    for (const operation of operations) for (const file of operation.files) {
      await rm(file.targetPath, { recursive: true, force: true });
      await cp(file.sourcePath, file.targetPath, { recursive: true });
    }
    return { operations: [] } as never;
  } };
  const restore = (via: "command" | "syncIn" = "command") => restoreHarnessBackupKeepingRemoteHistory({
    target: { kind: "remote" } as never, runner: via === "syncIn" ? replacingRunner : runner, backupRoot: backup,
    directories: [{ name: "runner", targetPath: join(box, "runner") }, { name: "pi-agent", targetPath: join(box, "pi-agent") }],
  });
  const validate = (id = sessionId) => probePiSessionResumeFile({ runner, node: process.execPath, providerPackRoot,
    directory: boxSessions, filename, normalizedSessionId: sessionId, providerSessionId: id, providerBackendSessionId: id,
    workingDirectory: root });
  // The real producer: the runner's pinned Pi SessionManager builds the context
  // the next turn sends to the model from the box's conversation file.
  const nextTurnContext = async () => {
    const pi = await import(pathToFileURL(resolve(import.meta.dirname,
      "../../../../packages/paperclip-runner/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href) as {
      SessionManager: { open(file: string, dir: string): { buildSessionContext(): { messages: unknown[] } } } };
    return pi.SessionManager.open(boxSession, boxSessions).buildSessionContext().messages;
  };
  const backupSession = join(backup, "pi-agent", "sessions", filename);
  return { root, header, older, newer, boxSessions, boxSession, backupSession, runnerState, suspended, restore, validate, nextTurnContext };
}

// smarty-dev#21273 round 3 (rf-3 ruling, #4605 09:05Z): a Retry onto a new
// box resumes or continues, never a bare failure.
// (a) The box holds a NEWER copy of the same conversation (the backup is a byte
//     prefix of it): the box's file is the latest conversation. It is kept
//     as-is (nothing copied over it), the rest of the backup is staged, and the
//     next turn's context carries the newer assistant message.
it.each(["command", "syncIn"] as const)("(a) a box holding a NEWER copy of the same conversation is resumed from it: kept byte-identical, the newer reply in the next turn's context (%s staging)", async via => {
  const f = await fixture();
  await mkdir(f.boxSessions, { recursive: true });
  await writeFile(f.boxSession, f.newer);
  expect(existsSync(f.runnerState)).toBe(false);

  await f.restore(via);

  // Nothing was copied over the newer conversation.
  expect(await readFile(f.boxSession, "utf8")).toBe(f.newer);
  // The rest of the verified backup (the Runner state) is staged beside it.
  expect(await readFile(f.runnerState, "utf8")).toBe(f.suspended);
  expect(await f.validate()).toBe("valid");
  // The real Pi SessionManager builds the next turn's context from the box's file.
  const texts = (await f.nextTurnContext()).map(entry => JSON.stringify(entry));
  expect(texts.some(text => text.includes("Fixed: the import path was wrong"))).toBe(true);
  expect(texts.filter(text => text.includes("Fixed: the import path was wrong"))).toHaveLength(1);
  // The backup's own copy is unchanged.
  expect(await readFile(f.backupSession, "utf8")).toBe(f.older);
});

// (b) A DIFFERENT conversation under the same file: touch nothing; the restore
//     refuses with the fresh-thread code the run continues on (the executor row
//     in native-session-executor.test.ts shows the fresh thread and the note).
it("(b) a box holding a DIFFERENT conversation keeps both files byte-identical and refuses with the fresh-thread code", async () => {
  const f = await fixture();
  const otherId = randomUUID();
  const other = f.header(otherId) + message("x1", null, "user", "A different task") + message("x2", "x1", "assistant", "Different answer");
  await mkdir(f.boxSessions, { recursive: true });
  await writeFile(f.boxSession, other);

  const failure = await f.restore().then(() => null, (error: Error) => error);

  expect(await readFile(f.boxSession, "utf8")).toBe(other);
  expect(await readFile(f.backupSession, "utf8")).toBe(f.older);
  expect(failure).not.toBeNull();
  expect((failure as Error & { code?: string }).code).toBe(RESTORE_TARGET_HOLDS_OTHER_CONVERSATION);
  expect(restoreTargetHoldsOtherConversationCode(failure)).toBe(RESTORE_TARGET_HOLDS_OTHER_CONVERSATION);
  expect(await f.validate(otherId)).toBe("valid");
  // Nothing staged beside the kept conversation.
  expect(existsSync(f.runnerState)).toBe(false);
});

// (c) Unreadable: touch nothing and refuse with the true line, which says
//     plainly what the person can do.
it("(c) an unreadable conversation file on the box is kept and refused with a plain line", async () => {
  const f = await fixture();
  await mkdir(f.boxSessions, { recursive: true });
  await writeFile(f.boxSession, f.newer);
  await chmod(f.boxSession, 0o000);
  try {
    const failure = await f.restore().then(() => null, (error: Error) => error);
    expect(failure?.message).toContain(RESTORE_TARGET_HISTORY_DIFFERS);
    expect(failure?.message).toContain(RESTORE_TARGET_KEPT_PERSON_LINE);
    expect(restoreTargetHoldsOtherConversationCode(failure)).toBeNull();
  } finally { await chmod(f.boxSession, 0o600); }
  expect(await readFile(f.boxSession, "utf8")).toBe(f.newer);
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

it("(c) a symbolic link at the conversation path is kept, not followed or replaced, and refused with a plain line", async () => {
  const f = await fixture();
  await mkdir(f.boxSessions, { recursive: true });
  const elsewhere = join(f.root, "elsewhere.jsonl");
  await writeFile(elsewhere, f.newer);
  await symlink(elsewhere, f.boxSession);
  await expect(f.restore()).rejects.toThrow(RESTORE_TARGET_HISTORY_DIFFERS);
  await expect(f.restore()).rejects.toThrow(RESTORE_TARGET_KEPT_PERSON_LINE);
  expect((await lstat(f.boxSession)).isSymbolicLink()).toBe(true);
  expect(await readlink(f.boxSession)).toBe(elsewhere);
  expect(await readFile(elsewhere, "utf8")).toBe(f.newer);
  expect(existsSync(f.runnerState)).toBe(false);
});

// smarty-dev#21273 round 4 (rf-3 #20787 comment 7007193445, never-OK): the
// restore's TOCTOU race. The box's conversation is appended AFTER the real
// hash probe and BEFORE the staging writes. The restore re-checks the
// destination right before the final placement and never writes over it: the
// appended bytes survive, via the runner's syncIn AND via tar-extract.
const RACE_ROUNDS = [1, 2, 3] as const;
for (const via of ["syncIn", "command"] as const) {
  it.each(RACE_ROUNDS)(`(race) a conversation appended after the hash probe keeps the appended bytes (${via === "command" ? "tar" : via} staging, round %i)`, async () => {
    const f = await fixture();
    await mkdir(f.boxSessions, { recursive: true });
    // The box holds exactly the backup's conversation: the probe says "stage".
    await writeFile(f.boxSession, f.older);
    const appended = message("a2", "a1", "assistant", "Appended while the restore ran: the fix is in src/build/paths.ts line 42.");
    const live = f.older + appended;
    let probes = 0;
    const { appendFile } = await import("node:fs/promises");
    const restore = (runner: CommandManagedRuntimeRunner) => restoreHarnessBackupKeepingRemoteHistory({
      target: { kind: "remote" } as never, backupRoot: join(f.root, "backup"),
      directories: [{ name: "runner", targetPath: join(f.root, "box", "runner") }, { name: "pi-agent", targetPath: join(f.root, "box", "pi-agent") }],
      runner: {
        ...runner,
        execute: async input => {
          const result = await runner.execute(input);
          // The concurrent writer: right after the real probe answered.
          if (input.args?.includes("paperclip-runner-restore-history-probe")) { probes += 1; await appendFile(f.boxSession, appended); }
          return result;
        },
      },
    });
    const base: CommandManagedRuntimeRunner = { execute: input => runChildProcess(`restore-race-${randomUUID()}`,
      input.command, input.args ?? [], { cwd: f.root, env: {}, timeoutSec: (input.timeoutMs ?? 60_000) / 1000, graceSec: 1,
        stdin: input.stdin, onLog: async () => {} }) };
    const syncInCalls: string[] = [];
    const runner: CommandManagedRuntimeRunner = via === "command" ? base : { execute: base.execute, syncIn: async operations => {
      for (const operation of operations) for (const file of operation.files) {
        syncInCalls.push(file.targetPath);
        await rm(file.targetPath, { recursive: true, force: true });
        await cp(file.sourcePath, file.targetPath, { recursive: true });
      }
      return { operations: [] } as never;
    } };

    const outcome = await restore(runner).then(value => ({ value }), (error: Error) => ({ error }));

    expect(probes).toBe(1);
    // Never overwritten: the appended bytes are intact, byte for byte.
    expect(await readFile(f.boxSession, "utf8")).toBe(live);
    expect(Buffer.byteLength(appended)).toBeGreaterThan(100);
    // Now NEWER than the backup: kept per (a); the rest of the backup staged.
    expect(outcome).toEqual({ value: { keptNewerOnBox: [`pi-agent/sessions/${f.boxSession.split("/").pop()}`] } });
    expect(await readFile(f.runnerState, "utf8")).toBe(f.suspended);
    expect(await f.validate()).toBe("valid");
    // A path that can hold a live conversation is never given to syncIn.
    expect(syncInCalls.filter(path => path.endsWith("pi-agent"))).toEqual([]);
    // No staging leftovers beside the target.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(f.root, "box"))).sort()).toEqual(["pi-agent", "runner"]);
    expect((await readdir(f.boxSessions)).sort()).toEqual([f.boxSession.split("/").pop()]);
  });
}
