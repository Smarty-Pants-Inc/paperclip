import { existsSync, promises as fs, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { onNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { publishNativeHarnessBackup } from "./native-harness-backup-publication.js";

describe("native harness backup publication", () => {
  let backupRoot = "";
  let unsubscribe: (() => void) | undefined;
  afterEach(async () => {
    unsubscribe?.(); unsubscribe = undefined;
    // Kept superseded copies preserve immutable (0555) skill directories.
    const writable = async (directory: string): Promise<void> => {
      await fs.chmod(directory, 0o700);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await writable(path.join(directory, entry.name));
      }
    };
    if (backupRoot && existsSync(backupRoot)) await writable(backupRoot);
    if (backupRoot) await fs.rm(backupRoot, { recursive: true, force: true });
  });
  async function fixture() {
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-publication-"));
    const current = path.join(backupRoot, "current"), pendingRoot = path.join(backupRoot, "pending");
    await fs.mkdir(current); await fs.mkdir(pendingRoot);
    await fs.writeFile(path.join(current, "manifest.json"), "saved");
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), "replacement");
    return { db: {}, companyId: "company", scopeDigest: "scope", backupRoot, pendingRoot, current };
  }
  it("restores the existing backup when its lease stamp fails without publishing a false change", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await expect(publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
      throw new Error("stamp transaction rejected");
    } })).rejects.toThrow("stamp transaction rejected");
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("saved");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); expect(changes).toEqual([]);
  });
  // Retargeted (rotation-keep, RFL 11-19 03:00Z): the predecessor and a leftover
  // 'previous' are kept in failover-backups/superseded, never removed.
  it("publishes the completed replacement once and keeps its predecessor and a leftover previous in superseded", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    const previous = path.join(backupRoot, "previous");
    for (const root of [input.current, previous]) {
      const skill = path.join(root, "skills", "immutable");
      await fs.mkdir(skill, { recursive: true });
      await fs.writeFile(path.join(skill, "SKILL.md"), "saved instructions", { mode: 0o444 });
      await fs.chmod(skill, 0o555);
    }
    unsubscribe = onNativeHarnessBackupChange(input.db, change => {
      expect(existsSync(previous)).toBe(false);
      changes.push(change);
    });
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(changes).toEqual([]);
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
    } });
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    expect((await fs.readdir(backupRoot)).sort()).toEqual(["current", "superseded"]);
    const kept = (await fs.readdir(path.join(backupRoot, "superseded"))).sort();
    expect(kept).toHaveLength(2);
    for (const name of kept) {
      const skill = path.join(backupRoot, "superseded", name, "skills", "immutable");
      expect(await fs.readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("saved instructions");
      expect((await fs.stat(skill)).mode & 0o777, "modes kept: moved, not copied").toBe(0o555);
    }
    expect(await fs.readFile(path.join(backupRoot, "superseded", kept[1]!, "manifest.json"), "utf8")).toBe("saved");
    expect(changes).toEqual([{ companyId: input.companyId, scopeDigest: input.scopeDigest }]);
  });
  it("restores the old current directory when the pending rename fails", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await fs.rm(input.pendingRoot, { recursive: true });
    await expect(publishNativeHarnessBackup(input)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("saved");
    expect(changes).toEqual([]);
  });

  // Retargeted (rotation-keep): publication no longer removes the retired tree,
  // so there is no long removal to stay responsive through; the request is
  // still served during publication and the 2,000-file tree is kept whole.
  // Trigger retargeted again (rf-3 04:04Z, amended record): the stamp holds
  // publication until the probe response is served, so the request lands while
  // the retired 2,000-file tree is moved aside ('previous', not yet in
  // superseded). The strength is kept: exactly "1" (served while publication
  // is still active), as before the keep; accepting "0" was a weakening.
  it("serves an unrelated request while the retired backup is moved aside and keeps it whole", async () => {
    const input = await fixture();
    for (let index = 0; index < 40; index++) {
      const directory = path.join(input.current, `skill-${index}`);
      await fs.mkdir(directory);
      await Promise.all(Array.from({ length: 50 }, (_, file) =>
        fs.writeFile(path.join(directory, `file-${file}`), "retired instructions", { mode: 0o444 })));
      await fs.chmod(directory, 0o555);
    }
    let publishing = false;
    let servedWhileAside: { previous: boolean; superseded: boolean } | undefined;
    let probeReceived: (response: ServerResponse | null) => void;
    const probeReady = new Promise<ServerResponse | null>(resolve => { probeReceived = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/probe") { probeReceived(response); return; }
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP probe did not start");
    const client = spawn(process.execPath, ["--input-type=module", "-e", `
      import { Agent, get } from "node:http";
      const agent = new Agent({ keepAlive: true });
      const request = path => new Promise((resolve, reject) => {
        get({ hostname: "127.0.0.1", port: Number(process.argv[1]), path, agent }, response => {
          response.resume();
          response.on("end", () => resolve(response.headers["x-publication-active"]));
        }).on("error", reject);
      });
      await request("/");
      process.send({ kind: "ready" });
      process.once("message", async () => {
        const active = await request("/probe");
        process.send({ kind: "result", active }, () => { agent.destroy(); process.disconnect(); });
      });
    `, String(address.port)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const message = (kind: string) => new Promise<{ active?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`HTTP probe ${kind} timed out`)); }, 10_000);
      const received = (value: { kind?: string; active?: string }) => {
        if (value.kind === kind) { cleanup(); resolve(value); }
      };
      const failed = () => { cleanup(); reject(new Error(`HTTP probe exited before ${kind}`)); };
      const cleanup = () => {
        clearTimeout(timer); client.off("message", received); client.off("exit", failed); client.off("error", failed);
      };
      client.on("message", received); client.once("exit", failed); client.once("error", failed);
    });
    let publication: Promise<void> | undefined;
    try {
      await message("ready");
      const response = message("result");
      publishing = true;
      publication = publishNativeHarnessBackup({
        ...input,
        stamp: async () => {
          client.send({ kind: "probe" });
          const response = await probeReady;
          if (!response) return;
          await new Promise<void>(served => {
            response.once("finish", served); response.once("close", served);
            setImmediate(() => {
              servedWhileAside = {
                previous: existsSync(path.join(backupRoot, "previous", "skill-39", "file-49")),
                superseded: existsSync(path.join(backupRoot, "superseded")),
              };
              response.setHeader("x-publication-active", publishing ? "1" : "0");
              response.end("ok");
            });
          });
        },
      }).finally(() => { publishing = false; });
      const result = await response;
      await publication;
      expect(result.active).toBe("1");
      expect(servedWhileAside).toEqual({ previous: true, superseded: false });
      expect((await fs.readdir(backupRoot)).sort()).toEqual(["current", "superseded"]);
      expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
      const [kept] = await fs.readdir(path.join(backupRoot, "superseded"));
      for (let index = 0; index < 40; index++) {
        expect(await fs.readdir(path.join(backupRoot, "superseded", kept!, `skill-${index}`))).toHaveLength(50);
      }
    } finally {
      probeReceived!(null);
      try { await publication; }
      finally {
        client.kill();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  }, 15_000);
});

// BRIEF rotation-keep (RFL 11-19 03:00Z, never-OK): a superseded backup IS a
// trace unless shown byte-identical to, or a byte-prefix of, the newer copy.
// Pi 1.5.2 rewrites its session file in place (session-manager.js _rewriteFile,
// open "w") when it loads an older-version file, and drops malformed lines; the
// control-plane journal is a whole-file snapshot. So rotation must keep it.
describe("native harness backup rotation keeps the superseded copy (rotation-keep)", () => {
  let stateBase = "";
  afterEach(async () => { if (stateBase) await fs.rm(stateBase, { recursive: true, force: true }); stateBase = ""; });
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  async function scopeRoot() {
    stateBase = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-rotation-"));
    const scope = createHash("sha256").update("rotation-keep-scope").digest("hex");
    const root = path.join(stateBase, scope);
    await fs.mkdir(root, { recursive: true });
    return { scope, root, backupRoot: path.join(root, "failover-backups") };
  }
  async function publish(backupRoot: string, scope: string, files: Record<string, Buffer | string>) {
    await fs.mkdir(backupRoot, { recursive: true });
    const pendingRoot = path.join(backupRoot, `.pending-${Math.random().toString(16).slice(2)}`);
    for (const [relative, bytes] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(pendingRoot, relative)), { recursive: true });
      await fs.writeFile(path.join(pendingRoot, relative), bytes);
    }
    await publishNativeHarnessBackup({ db: {}, companyId: "company", scopeDigest: scope, backupRoot, pendingRoot });
  }
  /** Every file under `root` whose bytes hash to `digest`. */
  async function filesWithHash(root: string, digest: string): Promise<string[]> {
    const found: string[] = [];
    const visit = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(filename);
        else if (entry.isFile() && sha(await fs.readFile(filename)) === digest) found.push(path.relative(root, filename));
      }
    };
    await visit(root);
    return found.sort();
  }
  async function superseded(backupRoot: string) {
    const kept = path.join(backupRoot, "superseded");
    const names = existsSync(kept) ? (await fs.readdir(kept)).sort() : [];
    for (const name of names) expect(name).toMatch(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    return names.map(name => path.join(kept, name));
  }

  it("ROT-1 (real producer, Pi 1.5.2): a session file Pi rewrote in place, then published twice, keeps every earlier byte in failover-backups/superseded and each copy re-hashes", async () => {
    const { scope, root, backupRoot } = await scopeRoot();
    // Real producer: the runner's pinned Pi SessionManager (packages/paperclip-runner, 1.5.2).
    const pi = await import(pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/paperclip-runner/node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href) as {
      SessionManager: { open(file: string, dir: string): { appendCompaction(summary: string, firstKeptEntryId: string | null, tokensBefore: number): string; getLeafId(): string | null } };
    };
    const live = path.join(root, "pi"); await fs.mkdir(live);
    const sessionFile = path.join(live, "2026-11-01T00-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
    const s0 = Buffer.from([
      JSON.stringify({ type: "session", version: 1, id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/w" }),
      JSON.stringify({ type: "message", timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: "first question", timestamp: 1 } }),
      '{"type":"message","partial line the next load drops',
      JSON.stringify({ type: "message", timestamp: "2026-11-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 2 } }),
    ].join("\n") + "\n");
    await fs.writeFile(sessionFile, s0);
    const manifest = JSON.stringify({ providerKind: "pi_rpc", directories: [{ name: "pi" }] });
    const relative = path.join("pi", path.basename(sessionFile));
    await publish(backupRoot, scope, { "manifest.json": manifest, [relative]: s0 });
    // Pi opens the older-version file, migrates and rewrites it, then compacts (appends).
    const session = pi.SessionManager.open(sessionFile, live);
    session.appendCompaction("summary of the first exchange", session.getLeafId(), 1234);
    const s1 = await fs.readFile(sessionFile);
    expect(s1.subarray(0, s0.length).equals(s0), "Pi rewrote earlier bytes: the old copy is not a prefix").toBe(false);
    expect(s1.includes(Buffer.from("partial line the next load drops"))).toBe(false);
    await publish(backupRoot, scope, { "manifest.json": manifest, [relative]: s1 });
    session.appendCompaction("summary after the second turn", session.getLeafId(), 2345);
    const s2 = await fs.readFile(sessionFile);
    await publish(backupRoot, scope, { "manifest.json": manifest, [relative]: s2 });

    // The earlier bytes still exist somewhere under the state base...
    expect(await filesWithHash(stateBase, sha(s0)), "s0 (pre-rewrite) bytes kept").not.toEqual([]);
    // ...and specifically in the kept superseded copies, oldest first.
    const kept = await superseded(backupRoot);
    expect(kept).toHaveLength(2);
    expect(sha(await fs.readFile(path.join(kept[0]!, relative)))).toBe(sha(s0));
    expect(sha(await fs.readFile(path.join(kept[1]!, relative)))).toBe(sha(s1));
    expect(sha(await fs.readFile(path.join(backupRoot, "current", relative)))).toBe(sha(s2));
    expect((await fs.readdir(backupRoot)).sort()).toEqual(["current", "superseded"]);
  }, 30_000); // importing the real Pi SessionManager takes seconds under load

  it("ROT-2 (planted: a non-Pi codex rollout rewritten by summarisation), published twice: the earlier bytes are kept and re-hash", async () => {
    const { scope, backupRoot } = await scopeRoot();
    const relative = "codex-home/sessions/rollout-1.jsonl";
    const v0 = Buffer.from('{"turn":1,"text":"only copy of turn one"}\n{"turn":2,"text":"turn two"}\n');
    const v1 = Buffer.from('{"summary":"turns 1-2 summarised"}\n{"turn":3,"text":"turn three"}\n'); // planted rewrite
    const v2 = Buffer.from('{"summary":"turns 1-3 summarised"}\n');
    for (const bytes of [v0, v1, v2]) await publish(backupRoot, scope, { "manifest.json": '{"providerKind":"codex_app_server"}', [relative]: bytes });
    expect(await filesWithHash(stateBase, sha(v0)), "v0 bytes kept").not.toEqual([]);
    const kept = await superseded(backupRoot);
    expect(kept.map(root => sha(readFileSync(path.join(root, relative))))).toEqual([sha(v0), sha(v1)]);
    expect(await fs.readFile(path.join(backupRoot, "current", relative))).toEqual(v2);
  });

  it("ROT-3: a leftover 'previous' from an interrupted publish is moved aside by rename, never deleted", async () => {
    const { scope, backupRoot } = await scopeRoot();
    await publish(backupRoot, scope, { "manifest.json": "first", "codex-home/a.jsonl": "first bytes" });
    const previous = path.join(backupRoot, "previous");
    await fs.mkdir(path.join(previous, "codex-home"), { recursive: true });
    await fs.writeFile(path.join(previous, "codex-home", "a.jsonl"), "leftover bytes");
    const leftoverInode = (await fs.stat(previous)).ino;
    await publish(backupRoot, scope, { "manifest.json": "second", "codex-home/a.jsonl": "second bytes" });
    const kept = await superseded(backupRoot);
    expect(kept).toHaveLength(2);
    expect(await fs.readFile(path.join(kept[0]!, "codex-home", "a.jsonl"), "utf8")).toBe("leftover bytes");
    expect((await fs.stat(kept[0]!)).ino, "rename, not copy").toBe(leftoverInode);
    expect(await fs.readFile(path.join(kept[1]!, "codex-home", "a.jsonl"), "utf8")).toBe("first bytes");
    expect(existsSync(previous)).toBe(false);
  });
});
