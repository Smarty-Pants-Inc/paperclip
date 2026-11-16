import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessDriver, PersistedHarnessSession } from "../../contracts/harness-driver.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { bindContent, type PiBindCommand, type PiBindResponse } from "./pi-bind-protocol.js";
import { quarantineInvalidPiSessionFile } from "./pi-session-file.js";
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
  it.each(["corrupt", "foreign-workspace", "symlink"]) ("quarantines %s without deleting or following the original entry", async kind => {
    const f = await fixture();
    try {
      const outside = join(f.root, "outside.jsonl");
      if (kind === "corrupt") await writeFile(f.file, f.content + "{bad tail}\n");
      if (kind === "foreign-workspace") await writeFile(f.file, JSON.stringify({ ...f.header, cwd: f.runtime }) + "\n");
      if (kind === "symlink") { await rm(f.file); await writeFile(outside, f.content); await symlink(outside, f.file); }
      const bytes = await readFile(f.file);
      const before = await lstat(f.file);
      await expect(f.recover()).rejects.toMatchObject({ code: "pi_session_file_invalid" });
      const preserved = await quarantineInvalidPiSessionFile(f.runtime, f.snapshot.normalizedSessionId);
      const aside = join(f.runtime, preserved);
      expect(preserved).toMatch(/^conversation\.jsonl\.invalid-\d{4}-\d{2}-\d{2}T/);
      expect(await readFile(aside)).toEqual(bytes);
      expect(await lstat(aside)).toMatchObject({ dev: before.dev, ino: before.ino, uid: before.uid, mode: before.mode });
      await expect(lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "symlink") { expect(await readlink(aside)).toBe(outside); expect(await readFile(outside)).toEqual(bytes); }
    } finally { await f.cleanup(); }
  });
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

  it("re-links the original npm package and admitted company skills after managed Pi recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-managed-restore-links-"));
    const originalPiHome = join(root, "original-pi");
    const workspace = join(root, "workspace");
    const runtime = join(root, "replacement", "filesystem", "pi");
    const agentHome = join(root, "replacement", "filesystem", "pi-agent");
    const bundle = join(root, "company-bundle");
    const sessionId = "restored-native-session";
    const normalizedSessionId = "restored-session";
    const sessionFile = join(runtime, `${normalizedSessionId}.jsonl`);
    const timestamp = "2026-11-16T00:00:00.000Z";
    let closed = false;
    let wake: (() => void) | undefined;
    let launch: PiRpcTransportOptions | undefined;
    let recoveredSession: Awaited<ReturnType<NonNullable<HarnessDriver["recoverSession"]>>>["session"];
    await mkdir(join(originalPiHome, "npm", "restore-proof-package"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    await mkdir(bundle, { recursive: true });
    await writeFile(join(originalPiHome, "npm", "restore-proof-package", "package.json"), JSON.stringify({ name: "restore-proof-package", version: "1.0.0" }));
    await writeFile(join(bundle, "SKILL.md"), "---\nname: restore-proof\ndescription: Restore proof.\n---\nRead this admitted skill.\n");
    await writeFile(sessionFile, [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: workspace },
      { type: "message", id: "prior-user", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Remember the restored conversation." }] } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    vi.stubEnv("PI_CODING_AGENT_DIR", originalPiHome);
    vi.stubEnv("HOME", root);
    const native = {
      pid: null as number | null,
      get exited() { return closed; },
      async request(type: string) {
        return { data: type === "get_state" ? { sessionId, sessionFile, model: { provider: "paperclip", id: "faux" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
          : type === "set_model" ? { provider: "paperclip", id: "faux" }
          : type === "get_available_models" ? { models: [{ provider: "paperclip", id: "faux", contextWindow: 200000, maxTokens: 8192, reasoning: true }] }
          : type === "get_available_thinking_levels" ? { levels: ["off"] } : undefined };
      },
      async *events() { while (!closed) await new Promise<void>(resolve => { wake = resolve; }); },
      async close() { closed = true; wake?.(); },
    };
    const bindRequest = async <C extends PiBindCommand>(_path: string, request: C): Promise<PiBindResponse<C>> => {
      const envelope = { schema: 1, type: request.type, nonce: request.nonce, sessionId: request.sessionId };
      if (request.type === "bind") return { ...envelope, epoch: request.epoch, runId: request.runId,
        provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) } as PiBindResponse<C>;
      if (request.type === "tool_inventory") return { ...envelope, nativeTools: [] } as PiBindResponse<C>;
      if (request.type === "park_ready") return { ...envelope, ready: true, reasons: [] } as PiBindResponse<C>;
      if (request.type === "stop_children") return { ...envelope, settled: [], uncertain: [] } as PiBindResponse<C>;
      return { ...request, ack: true } as PiBindResponse<C>;
    };
    const snapshot: PersistedHarnessSession = { driverKind: "pi_rpc", driverSessionId: sessionId, providerSessionId: sessionId,
      runId: "restored-run", normalizedSessionId, workingDirectory: workspace, activeTurnId: null, lastSourceSequence: 40 };
    try {
      // This is the driver's real recoverSession -> #open -> #openMeasured path.
      // Only the Pi RPC process is a controlled test peer; managed broker setup,
      // agent-home preparation, npm linking and skills synchronization are real.
      const driver = new PiRpcDriver({ command: process.execPath, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: runtime,
        runtimeContext: { skills: [{ bundle: { rootPath: bundle } }] }, environment: { HOME: root, PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: "1",
          PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
        transportFactory: options => { launch = options; return native as unknown as PiRpcTransport; }, bindRequest });
      const recovered = await driver.recoverSession!(snapshot, { signal: new AbortController().signal });
      expect(recovered.recovered).toBe(true);
      recoveredSession = recovered.session;
      expect(launch?.args?.slice(0, 4)).toEqual(["--mode", "rpc", "--session", sessionFile]);
      expect(launch?.env?.PI_CODING_AGENT_DIR).toBe(agentHome);
      expect(recoveredSession!.ids()).toMatchObject({ driverSessionId: sessionId, providerSessionId: sessionId });
      const npmLink = join(agentHome, "npm");
      expect((await lstat(npmLink)).isSymbolicLink()).toBe(true);
      expect(await readlink(npmLink)).toBe(join(originalPiHome, "npm"));
      expect(JSON.parse(await readFile(join(npmLink, "restore-proof-package", "package.json"), "utf8")))
        .toEqual({ name: "restore-proof-package", version: "1.0.0" });
      const namespace = join(agentHome, "skills", "paperclip-company-skills");
      expect(await readFile(join(namespace, ".owner"), "utf8")).toBe("paperclip.pi.company-skills.v1\n");
      const skillLink = (await readdir(namespace)).find(name => name.startsWith("bundle-"));
      expect(skillLink).toBeDefined();
      expect((await lstat(join(namespace, skillLink!))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(namespace, skillLink!))).toBe(bundle);
      expect(await readFile(join(namespace, skillLink!, "SKILL.md"), "utf8")).toContain("Read this admitted skill.");
    } finally {
      await recoveredSession?.close({ reason: "managed recovery test" });
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
