import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { PiRpcDriver, type HarnessSession, type NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { buildNativeHarnessBackupManifest, buildNativeHarnessBackupManifestStreamed, resolveNativeHarnessPersistenceProfile, stageRemoteRunnerDirectory, syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";
import { createNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { retainNativePiConversationEvidence } from "./native-pi-conversation-evidence.js";

const binary = process.env.PI_TEST_BINARY;
it.skipIf(!binary).each(["archive", "sync"] as const)("preserves a legacy cache through a real turn, then stamps a cache-free backup and recalls history (%s)", async transfer => {
  const root = await mkdtemp(join(tmpdir(), "pi-cache-upgrade-"));
  const fact = `PI_CACHE_UPGRADE_MEMORY_${randomUUID()}`;
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const model = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as typeof requests[number]; requests.push(parsed);
      const remembers = parsed.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(fact));
      const text = requests.length === 1 || remembers ? fact : "HISTORY_LOST";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  let session: HarnessSession | undefined;
  try {
    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const address = model.address(); if (!address || typeof address === "string") throw new Error("Loopback model did not bind");
    const sessionId = "pi-cache-upgrade", scopeId = `cache-upgrade-${transfer}`;
    const stateBase = join(root, "durable-sessions"), controller = join(stateBase, createHash("sha256").update(scopeId).digest("hex"));
    const live = join(stateBase, "live"), replacement = join(stateBase, "replacement"), backup = join(controller, "failover-backups", "current");
    const hostTmp = join(root, "tmp"), workspace = join(root, "workspace");
    for (const path of [workspace, hostTmp]) await mkdir(path, { mode: 0o700 });
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "operator-home-not-used"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase); vi.stubEnv("TMPDIR", hostTmp);
    const pathFor = (sandbox: string, directory: { name: string; location: string }) => directory.location === "runner" ? join(sandbox, "runner") : join(sandbox, "filesystem", directory.name);
    const sessionPath = (sandbox: string) => join(sandbox, "filesystem", "pi", `${sessionId}.jsonl`);
    const legacy = join(live, "filesystem", "pi", "node-compile-cache", "v24-old");
    await mkdir(legacy, { recursive: true, mode: 0o700 }); await writeFile(join(legacy, "legacy-bytecode"), "disposable compiled code");
    const open = (sandbox: string, runId: string) => new PiRpcDriver({ command: binary!, model: "paperclip/faux", piRpcThinkingLevel: "off",
      runtimeDirectory: join(sandbox, "filesystem", "pi"), shutdownTimeoutMs: 1000,
      environment: { PI_CODING_AGENT_DIR: join(sandbox, "filesystem", "pi-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
        PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    }).openSession({ runId, normalizedSessionId: sessionId, workingDirectory: workspace });
    const turn = async (current: HarnessSession, text: string) => {
      const iterator = current.events()[Symbol.asyncIterator](); const { turnId } = await current.startTurn({ message: { role: "user", text } }); const replies: string[] = [];
      while (true) {
        const next = await iterator.next(); if (next.done) throw new Error("Pi exited before turn settlement"); const event = next.value;
        if (event.turnId !== turnId) continue;
        if (event.eventType === "item.completed" && event.payload.kind === "agentMessage") replies.push(String(event.payload.text));
        if (event.eventType === "turn.completed") return replies.join("");
        if (["turn.failed", "turn.cancelled"].includes(event.eventType)) throw new Error(JSON.stringify(event));
      }
    };
    session = await open(live, "first-run");
    expect(await turn(session, "Remember the fact in your response, without writing workspace files.")).toBe(fact);
    await session.close({ reason: "completed upgrade turn" }); session = undefined;
    const transcript = await readFile(sessionPath(live)); expect(transcript.toString("utf8")).toContain(fact);
    expect(await readFile(join(legacy, "legacy-bytecode"), "utf8")).toBe("disposable compiled code");
    await mkdir(join(live, "runner"), { recursive: true, mode: 0o700 });
    await writeFile(join(live, "runner", "runner-state.json"), JSON.stringify({ lifecycle: "suspended" }), { mode: 0o600 });
    const execution = { provider: { kind: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off" },
      binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "first-run", executionWorkspaceId: "workspace" },
      workspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    } as unknown as NativeExecutionInputV1;
    const profile = resolveNativeHarnessPersistenceProfile(execution);
    const copy = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string; mode?: number }> }>) => {
      for (const operation of operations) for (const file of operation.files) {
        for (const path of [file.sourcePath, file.targetPath]) expect(relative(root, path)).not.toMatch(/^\.\.(?:[\\/]|$)/u);
        await mkdir(join(file.targetPath, ".."), { recursive: true, mode: 0o700 }); await cp(file.sourcePath, file.targetPath, { recursive: true });
        if (file.mode !== undefined) await chmod(file.targetPath, file.mode);
      }
    };
    const runner = { execute: async ({ command, args, stdin }: { command: string; args: string[]; stdin?: string }) => ({
      exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync(command, args, { input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    }), ...(transfer === "sync" ? { syncIn: copy, syncOut: copy } : {}) };
    for (const directory of profile.directories) await syncRemoteRunnerDirectoryOut({ runner: runner as never, sourcePath: pathFor(live, directory), targetPath: join(backup, directory.name), mode: 0o700, excludeEntries: directory.excludeEntries, excludeDirectories: directory.excludeDirectories });
    const cachePaths = async (directory: string) => (await readdir(directory, { recursive: true })).filter(path => path.split(/[\\/]/u).includes("node-compile-cache"));
    const backupCachePaths = await cachePaths(backup);
    const manifest = await buildNativeHarnessBackupManifestStreamed({ backupRoot: backup, execution, runnerInstanceId: "runner-1", sourceProviderLeaseId: "old-sandbox", providerSessionIdentity: { providerSessionId: sessionId } });
    // All manifest and stamp paths hash exactly the already-filtered tree.
    expect(buildNativeHarnessBackupManifest({ backupRoot: backup, execution, runnerInstanceId: "runner-1", sourceProviderLeaseId: "old-sandbox", providerSessionIdentity: { providerSessionId: sessionId }, completedAt: manifest.completedAt })).toEqual(manifest);
    await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
    const stamp = createNativeHarnessBackupStamp({ manifestPath: join(backup, "manifest.json"), sessionScopeId: scopeId, authorizedProviderLeaseId: "new-sandbox", normalizedSessionId: sessionId, runnerInstanceId: "runner-1", completedAt: manifest.completedAt });
    const stampVerified = verifyNativeHarnessBackupStamp(stamp, "new-sandbox");
    expect(stampVerified).toBe(true);
    expect(await verifyNativeHarnessBackupStampAsync(stamp, "new-sandbox", new AbortController().signal, backup)).toBe(true);
    for (const directory of profile.directories) await stageRemoteRunnerDirectory({ target: { kind: "remote", transport: "provider", remoteCwd: replacement } as never, runner: runner as never, sourcePath: join(backup, directory.name), targetPath: pathFor(replacement, directory), mode: 0o700 });
    expect(await readFile(sessionPath(replacement))).toEqual(transcript);
    expect(await retainNativePiConversationEvidence(live, stateBase)).toBe(true);
    const evidenceCachePaths = await cachePaths(join(stateBase, "conversation-evidence"));
    const evidencePaths = await readdir(join(stateBase, "conversation-evidence"), { recursive: true });
    const evidenceTranscript = evidencePaths.find(path => path.endsWith(`${sessionId}.jsonl`)); expect(evidenceTranscript).toBeDefined();
    expect(await readFile(join(stateBase, "conversation-evidence", evidenceTranscript!))).toEqual(transcript);
    // Evidence is an atomic whole-tree rename, not a filtered copy. Old legacy
    // caches stay with the original trace; removing them would reintroduce the race.
    const evidenceLegacy = evidencePaths.find(path => path.endsWith("node-compile-cache/v24-old/legacy-bytecode"));
    expect(evidenceLegacy).toBeDefined();
    expect(await readFile(join(stateBase, "conversation-evidence", evidenceLegacy!), "utf8")).toBe("disposable compiled code");
    session = await open(replacement, "following-run");
    const recall = await turn(session, "Recall the fact from your previous response."); expect(recall).toBe(fact);
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.messages.filter(message => message.role === "user").some(message => JSON.stringify(message.content).includes(fact))).toBe(false);
    if (process.env.JUDGE_PROOF_DIRECTORY) {
      await mkdir(process.env.JUDGE_PROOF_DIRECTORY, { recursive: true });
      const retainedState = join(process.env.JUDGE_PROOF_DIRECTORY, `${transfer}-state`);
      await cp(stateBase, retainedState, { recursive: true });
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", retainedState);
      const retainedBackup = join(retainedState, createHash("sha256").update(scopeId).digest("hex"), "failover-backups", "current");
      const retainedStampVerified = verifyNativeHarnessBackupStamp(stamp, "new-sandbox");
      expect(retainedStampVerified).toBe(true);
      expect(await verifyNativeHarnessBackupStampAsync(stamp, "new-sandbox", new AbortController().signal, retainedBackup)).toBe(true);
      vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
      await writeFile(join(process.env.JUDGE_PROOF_DIRECTORY, `legacy-${transfer}.json`), JSON.stringify({ transfer, nativePi: binary, backupCachePaths, evidenceCachePaths, stamp, stampVerified, retainedState, retainedStampVerified, transcriptSha256: createHash("sha256").update(transcript).digest("hex"), nativeRecall: recall === fact, requestCount: requests.length }, null, 2) + "\n");
    }
    expect(backupCachePaths).toEqual([]);
    expect(evidenceCachePaths).toHaveLength(3); // root, version directory, original bytecode
  } finally {
    await session?.close({ reason: "test cleanup" }); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
