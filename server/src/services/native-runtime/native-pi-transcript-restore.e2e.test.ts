import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiRpcDriver, type HarnessSession, type NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { resolveNativeHarnessPersistenceProfile, stageRemoteRunnerDirectory, syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";

// Opt-in, like the driver's existing faux-provider integration suite: set
// PI_TEST_BINARY to the qualified Pi executable. No model credentials required.
// Keep reason: data safety. A fact in Pi's assistant history, absent from every
// user prompt, must survive backup and restore into a different runtime root.
const binary = process.env.PI_TEST_BINARY;
it.skipIf(!binary)("recalls a Pi-only fact after restoring a completed turn into a fresh sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-restore-"));
  const privateFact = `PI_PRIVATE_MEMORY_${randomUUID()}`;
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const model = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as typeof requests[number];
      requests.push(parsed);
      const remembers = parsed.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
      const text = requests.length === 1 || remembers ? privateFact : "HISTORY_LOST";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  let session: HarnessSession | undefined;
  try {
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Loopback model did not bind");
    const sessionId = "pi-native-restore";
    const live = join(root, "old-sandbox");
    const replacement = join(root, "fresh-sandbox");
    const backup = join(root, "backup");
    // Replacement changes the runtime root, not the logical task workspace.
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const runtimePath = (sandbox: string, directory: { name: string; location: string }) =>
      directory.location === "runner" ? join(sandbox, "runner") : join(sandbox, "filesystem", directory.name);
    const sessionPath = (sandbox: string) => join(sandbox, "filesystem", "pi", `${sessionId}.jsonl`);
    // Isolate even the driver's original-model discovery from the operator home.
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "operator-home-not-used"));
    const open = async (sandbox: string, runId: string) => {
      await mkdir(sandbox, { recursive: true, mode: 0o700 });
      return new PiRpcDriver({ command: binary!, model: "paperclip/faux", piRpcThinkingLevel: "off",
        runtimeDirectory: join(sandbox, "filesystem", "pi"), shutdownTimeoutMs: 1000,
        environment: { PI_CODING_AGENT_DIR: join(sandbox, "filesystem", "pi-agent"), PI_OFFLINE: "1",
          PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`,
          PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      }).openSession({ runId, normalizedSessionId: sessionId, workingDirectory: workspace });
    };
    const turn = async (current: HarnessSession, text: string) => {
      const iterator = current.events()[Symbol.asyncIterator]();
      const { turnId } = await current.startTurn({ message: { role: "user", text } });
      const replies: string[] = [];
      while (true) {
        const next = await iterator.next();
        if (next.done) throw new Error("Pi exited before turn settlement");
        const event = next.value;
        if (event.turnId !== turnId) continue;
        if (event.eventType === "item.completed" && event.payload.kind === "agentMessage") replies.push(String(event.payload.text));
        if (event.eventType === "turn.completed") return replies.join("");
        if (["turn.failed", "turn.cancelled"].includes(event.eventType)) throw new Error(JSON.stringify(event));
      }
    };
    session = await open(live, "first-run");
    expect(await turn(session, "Remember the fact in your response; do not write any workspace files.")).toBe(privateFact);
    await session.close({ reason: "checkpoint completed turn" }); session = undefined;
    const transcript = await readFile(sessionPath(live));
    expect(transcript.toString("utf8")).toContain(privateFact);
    await mkdir(join(live, "runner"), { recursive: true, mode: 0o700 });
    await writeFile(join(live, "runner", "runner-state.json"), JSON.stringify({ lifecycle: "suspended" }), { mode: 0o600 });
    const execution = { provider: { kind: "pi_rpc" }, session: { normalizedSessionId: sessionId, driverKind: "pi_rpc" } } as unknown as NativeExecutionInputV1;
    const profile = resolveNativeHarnessPersistenceProfile(execution);
    const runner = { execute: async ({ command, args, stdin }: { command: string; args: string[]; stdin?: string }) => ({
      exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync(command, args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    }) };
    for (const directory of profile.directories)
      await syncRemoteRunnerDirectoryOut({ runner: runner as never, sourcePath: runtimePath(live, directory),
        targetPath: join(backup, directory.name), mode: 0o700, excludeEntries: directory.excludeEntries });
    await rm(live, { recursive: true, force: true });
    await expect(access(replacement)).rejects.toMatchObject({ code: "ENOENT" });
    for (const directory of profile.directories)
      await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: replacement } as never,
        runner: runner as never, sourcePath: join(backup, directory.name), targetPath: runtimePath(replacement, directory), mode: 0o700 });
    // Byte equality is checked before a new Pi process can open or append.
    expect(await readFile(sessionPath(replacement))).toEqual(transcript);
    session = await open(replacement, "following-run");
    expect(await turn(session, "Recall the fact from your previous response.")).toBe(privateFact);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(request.messages.filter(message => message.role === "user").some(message => JSON.stringify(message.content).includes(privateFact))).toBe(false);
    expect(requests[1]!.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(privateFact))).toBe(true);
  } finally {
    await session?.close({ reason: "test cleanup" });
    model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
