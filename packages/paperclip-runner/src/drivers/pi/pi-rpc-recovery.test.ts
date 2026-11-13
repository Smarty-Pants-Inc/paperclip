import { chmod, chown, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessDriver, PersistedHarnessSession } from "../../contracts/harness-driver.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport, PiRpcTransportOptions } from "./pi-rpc-transport.js";

// Keep reason: data safety and trust boundary. Pi itself can silently turn a
// missing/corrupt --session into a fresh history; recovery must refuse first.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-recovery-"));
  const runtime = join(root, "runtime"); await mkdir(runtime);
  const file = join(runtime, "conversation.jsonl");
  const header = { type: "session", version: 3, id: "native-session", timestamp: new Date().toISOString(), cwd: root };
  const content = JSON.stringify(header) + "\n" + JSON.stringify({ type: "message", id: "entry-1", parentId: null, timestamp: header.timestamp,
    message: { role: "assistant", content: [{ type: "text", text: "Pi-only private fact" }] } }) + "\n";
  await writeFile(file, content, { mode: 0o600 });
  let closed = false;
  let wake: (() => void) | undefined;
  let nativeId = header.id, nativeFile = file;
  const requests: string[] = [];
  const transport = {
    pid: null, get exited() { return closed; },
    async request(type: string) {
      requests.push(type);
      return { data: type === "get_state" ? { sessionId: nativeId, sessionFile: nativeFile, model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
        : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
        : type === "set_model" ? { provider: "neutral", id: "model" }
        : type === "get_available_thinking_levels" ? { levels: ["high"] }
        : type === "prompt" ? { disposition: "handled" } : undefined };
    },
    async *events(): AsyncIterable<PiRpcRecord> { while (!closed) await new Promise<void>(resolve => { wake = resolve; }); },
    async close() { closed = true; wake?.(); },
  };
  const factory = vi.fn((_options: PiRpcTransportOptions) => transport as unknown as PiRpcTransport);
  const driver: HarnessDriver = new PiRpcDriver({ runtimeDirectory: runtime, model: "neutral/model", piRpcThinkingLevel: "high",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: factory });
  const snapshot: PersistedHarnessSession & { sessionFile: string } = { driverKind: "pi_rpc", driverSessionId: header.id, providerSessionId: header.id,
    runId: "run-new", normalizedSessionId: "conversation", workingDirectory: root, activeTurnId: null, lastSourceSequence: 40, sessionFile: file };
  const recover = () => driver.recoverSession!(snapshot, { signal: new AbortController().signal });
  return { root, runtime, file, header, content, driver, snapshot, recover, factory, requests, transport,
    changeNative(id: string, path = file) { nativeId = id; nativeFile = path; },
    async cleanup() { await transport.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("Pi driver verified cold recovery", () => {
  it("loads the exact file/id and admits a warm session with current home/settings", async () => {
    const f = await fixture();
    try {
      expect((await f.driver.descriptor()).capabilities.resume).toBe(true);
      const result = await f.recover(); expect(result.recovered).toBe(true);
      const session = result.session!;
      try {
        expect(session.ids()).toMatchObject({ driverSessionId: f.header.id, providerSessionId: f.header.id });
        const launch = f.factory.mock.calls[0]![0];
        expect(launch.args!.slice(0, 4)).toEqual(["--mode", "rpc", "--session", f.file]);
        expect(launch.cwd).toBe(f.root); expect(launch.env?.PI_CODING_AGENT_DIR).toBe(join(f.root, "agent"));
        expect(f.requests).toContain("set_model"); expect(f.requests).toContain("set_thinking_level");
        expect(f.requests).not.toContain("prompt");
        const saved = await session.snapshot();
        expect(saved).toMatchObject({ ...f.snapshot, activeTurnId: null, lastSourceSequence: expect.any(Number) });
        expect(saved.lastSourceSequence).toBeGreaterThanOrEqual(40);
        expect(await readFile(f.file, "utf8")).toBe(f.content);
        await session.attachRun!({ runId: "run-next" });
        await session.startTurn({ message: { role: "user", text: "/handled" } });
        expect(f.requests.filter(type => type === "prompt")).toHaveLength(1);
      } finally { await session.close({ reason: "test" }); }
    } finally { await f.cleanup(); }
  });

  it("recovers the prior proxy snapshot shape (no explicit file) by normalized id", async () => {
    const f = await fixture();
    try {
      delete (f.snapshot as Partial<typeof f.snapshot>).sessionFile;
      const result = await f.recover(); expect(result.recovered).toBe(true);
      await result.session!.close({ reason: "test" });
    } finally { await f.cleanup(); }
  });

  it("reports a typed missing file without starting Pi or creating history", async () => {
    const f = await fixture();
    try {
      await rm(f.file);
      await expect(f.recover()).rejects.toMatchObject({ code: "pi_session_file_missing" });
      expect(f.factory).not.toHaveBeenCalled();
      await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.cleanup(); }
  });

  it.each(["wrong-id", "corrupt-header", "corrupt-tail", "malformed-entry", "duplicate-entry", "malformed-message", "empty", "foreign-workspace", "symlink", "foreign-file"]) (
    "refuses %s by name and leaves evidence untouched", async kind => {
      const f = await fixture();
      try {
        if (kind === "wrong-id") await writeFile(f.file, JSON.stringify({ ...f.header, id: "someone-else" }) + "\n");
        if (kind === "corrupt-header") await writeFile(f.file, "{invalid json}\n");
        if (kind === "corrupt-tail") await writeFile(f.file, f.content + "{corrupt tail}\n");
        if (kind === "malformed-entry") await writeFile(f.file, f.content + JSON.stringify({ type: "message", id: "entry-2" }) + "\n");
        if (kind === "duplicate-entry") await writeFile(f.file, f.content + f.content.split("\n")[1] + "\n");
        if (kind === "malformed-message") await writeFile(f.file, f.content + JSON.stringify({ type: "message", id: "entry-2", parentId: "entry-1", timestamp: f.header.timestamp, message: null }) + "\n");
        if (kind === "empty") await writeFile(f.file, "");
        if (kind === "foreign-workspace") await writeFile(f.file, JSON.stringify({ ...f.header, cwd: f.runtime }) + "\n");
        if (kind === "symlink") { await rm(f.file); await writeFile(join(f.root, "foreign.jsonl"), f.content); await symlink(join(f.root, "foreign.jsonl"), f.file); }
        if (kind === "foreign-file") f.snapshot.sessionFile = join(f.root, "foreign.jsonl");
        const before = await readFile(f.file, "utf8");
        await expect(f.recover()).rejects.toMatchObject({ code: "pi_session_file_invalid" });
        expect(f.factory).not.toHaveBeenCalled();
        expect(await readFile(f.file, "utf8")).toBe(before);
      } finally { await f.cleanup(); }
    });

  it.skipIf(process.getuid?.() !== 0)("refuses a foreign OS owner without rewriting the file", async () => {
    const f = await fixture();
    try {
      await chown(f.file, 65534, 65534); await chmod(f.file, 0o644);
      await expect(f.recover()).rejects.toMatchObject({ code: "pi_session_file_invalid" });
      expect(f.factory).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it.each(["id", "file"]) ("checks live get_state %s before admitting, closes mismatched Pi", async field => {
    const f = await fixture();
    try {
      f.changeNative(field === "id" ? "wrong-live-id" : f.header.id, field === "file" ? join(f.root, "wrong.jsonl") : f.file);
      await expect(f.recover()).rejects.toMatchObject({ code: "pi_session_file_invalid" });
      expect(f.transport.exited).toBe(true); expect(f.requests).not.toContain("prompt");
      expect(await readFile(f.file, "utf8")).toBe(f.content);
    } finally { await f.cleanup(); }
  });
});
