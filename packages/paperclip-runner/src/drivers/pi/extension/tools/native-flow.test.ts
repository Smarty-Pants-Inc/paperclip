// Dependency checks are opt-in: PI_NATIVE_RUNTIME_ROOT must be an installed Pi 1.5.2 package
// root and PI_NATIVE_GUARD_ROOT the unchanged packaged guard. No paid/provider/org calls.
// Keep reason: actual protocol/data-safety boundaries hidden by unit mocks.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { admitPiRpcSession } from "../../pi-native-config.js";
import { assertNativeMcpPolicy, describeNativeMcpCall } from "../mcp/policy.js";
import { collectGuardRawArtifacts } from "./raw-artifacts.js";

const runtimeRoot = process.env.PI_NATIVE_RUNTIME_ROOT;
const guardRoot = process.env.PI_NATIVE_GUARD_ROOT;
const proofRoot = process.env.PI_NATIVE_TEST_OUT;
type Json = Record<string, any>;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function nativeFlow(scenario: "mcp" | "guard", verify: (result: { root: string; sessionRoot: string; wire: Json[]; requests: Json[]; hooks: Json[]; entries: Json[]; fixtureText: string; config: Json; launchToolSelectors: string[]; save: (name: string, bytes: string | Uint8Array) => Promise<void> }) => Promise<void>) {
  expect(JSON.parse(await readFile(join(runtimeRoot!, "package.json"), "utf8")).version).toBe("1.5.2");
  if (proofRoot) await mkdir(proofRoot, { recursive: true });
  const root = await mkdtemp(join(proofRoot ?? tmpdir(), `pi-native-${scenario}-`));
  const agentDir = join(root, ".pi", "agent"), sessionRoot = join(agentDir, "sessions"), workspace = join(root, "workspace"), hookPath = join(root, "hooks.jsonl");
  await mkdir(agentDir, { recursive: true }); await mkdir(workspace);
  const wire: Json[] = [], requests: Json[] = [], commands: Json[] = [];
  const fixtureText = "HEAD_NONCE" + "x".repeat(60 * 1024 - 10) + "MIDDLE_NONCE" + "y".repeat(60 * 1024 - 23) + "TAIL_NONCE_";
  const fixturePath = join(root, "120KiB.txt"); await writeFile(fixturePath, fixtureText);
  const toolName = scenario === "mcp" ? "codemode" : "fixture_output";
  const toolArguments = scenario === "mcp" ? { code: 'return (await tools.mcp__computer__echo({nonce:"NATIVE_MCP_NONCE_4605"})).content;' } : {};
  const server = createServer(async (req, res) => {
    try {
      expect(req.url).toBe("/v1/chat/completions");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "native-proof", object: "chat.completion.chunk", created: 1700000000, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ role: "assistant", content: "" });
      if (requests.length === 1) {
        send({ tool_calls: [{ index: 0, id: "native-call", type: "function", function: { name: toolName, arguments: JSON.stringify(toolArguments) } }] }); send({}, "tool_calls");
      } else { send({ content: "Native proof complete." }); send({}, "stop"); }
      res.end("data: [DONE]\n\n");
    } catch { res.writeHead(500); res.end("controlled peer failed"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No loopback port");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", defaultProjectTrust: "never", retry: { enabled: false }, compaction: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { controlled: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "not-a-credential-loopback-fixture", models: [{ id: "native-proof", input: ["text"], contextWindow: 32000, maxTokens: 1024 }] } } }));
  // Explicit fault injection only in this controlled regression harness.
  const config = { mcpServers: scenario === "mcp" ? { computer: { command: process.execPath, args: [fileURLToPath(new URL("../mcp/fixtures/stdio-server.mjs", import.meta.url)), join(root, "mcp-marker.jsonl")], ...(process.env.PI_NATIVE_SEED_DIRECT_MCP ? { exposure: "direct" } : {}) } } : {} };
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config));
  const extension = join(root, "audit.ts");
  let source = `import { appendFileSync, readFileSync } from "node:fs";\n`;
  if (scenario === "guard") source += `import guard from ${JSON.stringify(join(guardRoot!, "dist", "tool-context-guard.js"))};\n`;
  source += `export default function(pi) {\n`;
  if (scenario === "guard") source += `${process.env.PI_NATIVE_SEED_NO_GUARD ? "" : "guard(pi, () => []);"}\npi.registerTool({name:"fixture_output",label:"Fixture",description:"120 KiB deterministic fixture",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:readFileSync(${JSON.stringify(fixturePath)},"utf8")}],details:{}})});\n`;
  source += `pi.on("tool_call", (event) => { appendFileSync(${JSON.stringify(hookPath)}, JSON.stringify({event,tools:pi.getAllTools().map(({name,sourceInfo,namespace})=>({name,sourceInfo,namespace}))})+"\\n"); });\n}`;
  await writeFile(extension, source);
  const launchToolSelectors = scenario === "mcp" ? ["read", "codemode", ...(process.env.PI_NATIVE_SEED_DIRECT_MCP ? ["mcp__*"] : [])] : ["read", "fixture_output"];
  const argv = [join(runtimeRoot!, "dist", "cli.js"), "--mode", "rpc", "--provider", "controlled", "--model", "native-proof", "--thinking", "off", "--tools", launchToolSelectors.join(","), "--extension", extension, "--session-dir", sessionRoot, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline"];
  const child = spawn(process.execPath, argv, { cwd: workspace, env: { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? "/usr/bin:/bin", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", SMARTY_ALPHA: "0", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "close"); let stderr = "", buffer = "", sequence = 0;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let settle: (() => void) | undefined;
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk; let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      const event = JSON.parse(line); wire.push(event);
      if (event.type === "response") { const call = pending.get(event.id); if (call) { pending.delete(event.id); event.success ? call.resolve(event.data) : call.reject(new Error(event.error)); } }
      if (event.type === "agent_settled") settle?.();
    }
  });
  const request = async (command: Json) => {
    const id = `native-${++sequence}`; commands.push({ ...command, id });
    let timeout: ReturnType<typeof setTimeout>;
    try { return await new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC deadline: ${command.type}; ${stderr}`)); }, 15000); child.stdin.write(JSON.stringify({ ...command, id }) + "\n"); }); }
    finally { clearTimeout(timeout!); }
  };
  const waitExit = async (ms: number) => {
    let timeout: ReturnType<typeof setTimeout>;
    try { return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timeout!); }
  };
  const save = async (name: string, bytes: string | Uint8Array) => { if (proofRoot) { const out = resolve(proofRoot, scenario); await mkdir(out, { recursive: true }); await writeFile(join(out, name), bytes); } };
  try {
    const identity = await admitPiRpcSession({ request }, { provider: "pi_rpc", model: "controlled/native-proof", piRpcThinkingLevel: "off" }); expect(identity.providerSessionId).toBeTruthy();
    let timeout: ReturnType<typeof setTimeout>;
    const settled = new Promise<void>((resolve, reject) => { settle = resolve; timeout = setTimeout(() => reject(new Error(`Native settle deadline: ${stderr}`)), 20000); });
    try { expect((await request({ type: "prompt", message: "Run the single controlled native proof." })).disposition).toBe("started"); await settled; } finally { clearTimeout(timeout!); }
    expect(requests).toHaveLength(2);
    const hooks = (await readFile(hookPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const files = (await readdir(sessionRoot)).filter(name => name.endsWith(".jsonl"));
    const entries = (await Promise.all(files.map(name => readFile(join(sessionRoot, name), "utf8")))).flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    await verify({ root, sessionRoot, wire, requests, hooks, entries, fixtureText, config, launchToolSelectors, save });
    await save("provenance.json", JSON.stringify({ runtime: "@earendil-works/pi-coding-agent@1.5.2", cliSha256: hash(await readFile(argv[0])), guardSha256: scenario === "guard" ? hash(await readFile(join(guardRoot!, "dist", "tool-context-guard.js"))) : null, identity, command: argv, noLiveProviderCalls: true, noCredentials: true, evidenceLevel: "real_dependency_with_controlled_loopback_peer" }, null, 2));
  } finally {
    child.stdin.end();
    if (!await waitExit(5000)) { child.kill("SIGTERM"); if (!await waitExit(2000)) { child.kill("SIGKILL"); await exited; } }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await save("wire.jsonl", wire.map(value => JSON.stringify(value)).join("\n") + "\n");
    await save("requests.json", JSON.stringify(requests, null, 2)); await save("commands.json", JSON.stringify(commands, null, 2)); await save("stderr.log", stderr);
    await save("exit.json", JSON.stringify({ code: child.exitCode, signal: child.signalCode }));
    // Proof runs preserve the actual native session/spill paths, not just copied previews.
    if (!proofRoot) await rm(root, { recursive: true, force: true });
  }
  expect(child.exitCode).toBe(0);
}

describe("real pinned Pi RPC dependency flows (not HQ/Boat qualification)", () => {
  it.skipIf(!runtimeRoot)("F019: native static-home stdio computer uses nested codemode and ZERO mcp__ provider declarations", async () => {
    await nativeFlow("mcp", async result => {
      const declarations = result.requests.map(request => request.tools.map((tool: Json) => tool.function?.name ?? tool.name) as string[]);
      await result.save("declarations.json", JSON.stringify({ declarations, directMcpCount: declarations.flat().filter(name => name.startsWith("mcp__")).length, launchToolSelectors: result.launchToolSelectors }, null, 2));
      for (const providerToolNames of declarations) assertNativeMcpPolicy({ providerToolNames, launchToolSelectors: result.launchToolSelectors, config: result.config });
      const nested = result.hooks.find(hook => hook.event.toolName === "mcp__computer__echo"); expect(nested).toBeDefined(); if (!nested) throw new Error("Native nested MCP hook missing");
      const identity = describeNativeMcpCall({ event: nested.event, parent: { toolCallId: "native-call", toolName: "codemode" }, tools: nested.tools, origin: { epoch: 1, runId: "fixture-run", turnId: "fixture-turn" } });
      expect(identity.parentToolCallId).toBe("native-call");
      expect((await readFile(join(result.root, "mcp-marker.jsonl"), "utf8")).trim().split("\n")).toEqual([JSON.stringify({ nonce: "NATIVE_MCP_NONCE_4605" })]);
      expect(JSON.stringify(result.requests[1].messages)).toContain("NATIVE_MCP_NONCE_4605");
      await result.save("nested-identity.json", JSON.stringify(identity, null, 2)); await result.save("hooks.json", JSON.stringify(result.hooks, null, 2));
    });
  }, 40000);
  it.skipIf(!runtimeRoot || !guardRoot)("F024: unchanged native guard caps the real model request and retains all 120 KiB", async () => {
    await nativeFlow("guard", async result => {
      const message = result.requests[1].messages.find((message: Json) => message.role === "tool"); expect(message).toBeDefined();
      const preview = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(50 * 1024);
      const native = result.entries.find(entry => entry.type === "message" && entry.message.role === "toolResult"); expect(native).toBeDefined(); if (!native) throw new Error("Native tool result missing");
      const origin = { epoch: 1, runId: "fixture-run", turnId: "fixture-turn" };
      const raw = await collectGuardRawArtifacts({ sessionRoot: result.sessionRoot, toolCallId: "native-call", origin, details: native.message.details, entries: result.entries, retain: async (_artifact, bytes) => { const path = join(result.root, "exported-spill.json"); await writeFile(path, bytes); const readback = await readFile(path); await result.save("retained-spill.json", readback); return { sha256: hash(readback), length: readback.length }; } });
      expect(raw.completeness).toBe(true); expect(raw.artifacts).toHaveLength(1);
      const bytes = await readFile(raw.artifacts[0].path), stored = JSON.parse(bytes.toString());
      expect(stored.content[0].text).toBe(result.fixtureText); expect(Buffer.byteLength(stored.content[0].text)).toBe(120 * 1024);
      for (const nonce of ["HEAD_NONCE", "MIDDLE_NONCE", "TAIL_NONCE_"]) expect(stored.content[0].text).toContain(nonce);
      await result.save("raw-manifest.json", JSON.stringify(raw, null, 2)); await result.save("session-entries.json", JSON.stringify(result.entries, null, 2));
      await result.save("measurement.json", JSON.stringify({ modelTextBytes: Buffer.byteLength(preview), fixtureTextBytes: Buffer.byteLength(result.fixtureText), storedFileBytes: bytes.length, sha256: hash(bytes), nativeEntryIds: raw.artifacts[0].nativeEntryIds }, null, 2));
    });
  }, 40000);
});
