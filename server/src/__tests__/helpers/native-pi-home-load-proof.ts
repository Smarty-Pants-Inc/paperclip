import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

export async function prepareNativePiHomeProof(root: string, fixture: string) {
  const agentDir = join(root, "pi-agent-fixture");
  await cp(join(fixture, "agent"), agentDir, { recursive: true, errorOnExist: true });
  const manifestSha256 = createHash("sha256").update(readFileSync(join(fixture, "SHA256SUMS"))).digest("hex");
  expect(manifestSha256).toBe(process.env.PAPERCLIP_PI_E2E_FIXTURE_MANIFEST_SHA256);
  await cp(join(fixture, "SHA256SUMS"), join(root, "fixture-SHA256SUMS"));
  await cp(join(fixture, "README.md"), join(root, "fixture-README.md"));
  // The scripted loopback model is not in Pi's public model catalog. Declare
  // its capabilities in this COPY, not in the host fixture or product code.
  // Unknown real models correctly default to reasoning:false on this head;
  // requesting xhigh alone must never manufacture a capability in production.
  const modelsPath = join(agentDir, "models.json");
  const models = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
  models.providers ??= {};
  models.providers.paperclip ??= {};
  const priorModels = models.providers.paperclip.models ?? [];
  models.providers.paperclip.models = [
    ...priorModels.filter((model: { id?: string }) => model.id !== "faux"),
    { id: "faux", reasoning: true, contextWindow: 128000, maxTokens: 8192, thinkingLevelMap: { xhigh: "xhigh" } },
  ];
  await writeFile(modelsPath, JSON.stringify(models, null, 2) + "\n");
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  await writeFile(join(root, "fixture-settings.original.json"), JSON.stringify(settings, null, 2) + "\n");
  const packagesRoot = join(fixture, "pi-packages");
  const toolCapRoot = join(packagesRoot, "tool-cap");
  const includedSubagents = process.env.PAPERCLIP_PI_E2E_EXCLUDE_SUBAGENTS !== "1";
  if (!includedSubagents) settings.packages = settings.packages.filter((entry: unknown) => entry !== join(packagesRoot, "pi-subagents"));
  const includedToolCap = existsSync(join(toolCapRoot, "redact-secrets.ts"));
  if (!includedToolCap) settings.packages = settings.packages.filter((entry: unknown) => entry !== toolCapRoot);
  // The staged langfuse-pi wrapper has no pi.extensions. Use the real plugin's
  // declared package entry in this COPY; never patch the staged fixture.
  const langfusePackage = join(packagesRoot, "langfuse-pi", "node_modules", "@langfuse", "pi-observability-plugin");
  const plugin = JSON.parse(readFileSync(join(langfusePackage, "package.json"), "utf8"));
  expect(plugin.pi.extensions).toContain("./src/index.ts");
  settings.packages = settings.packages.map((entry: unknown) => entry === join(packagesRoot, "langfuse-pi") ? langfusePackage : entry);
  if (!settings.packages.includes(langfusePackage)) settings.packages.push(langfusePackage);
  const observerPath = join(agentDir, "l2-load-proof.ts");
  settings.packages.unshift(observerPath);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  await writeFile(join(root, "fixture-settings.used.json"), JSON.stringify(settings, null, 2) + "\n");
  const receiptPath = join(root, "native-pi-home-load-proof.json");
  // Observation only: native public APIs and actual RPC stdout, no fake tools,
  // model events, settings-derived loaded list, or second native stdin writer.
  await writeFile(observerPath, `
import { writeFileSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
export default function(pi) {
  const receiptPath = ${JSON.stringify(receiptPath)};
  const data = { schema: "l2-native-pi-home-load-proof/v1", pid: process.pid,
    agentDir: process.env.PI_CODING_AGENT_DIR, piLangfuseDebug: process.env.PI_LANGFUSE_DEBUG,
    langfuseEnvironmentKeys: Object.keys(process.env).filter(key => key.startsWith("LANGFUSE_")),
    commands: [], tools: [], ui: [], extensionErrors: [], networkRequests: [], boundaries: [], nativeStderr: "",
    rpcRecordMax: 0, rpcRecordMaxByType: {}, rpcRecordCounts: {}, toolExecutions: [],
    agentHome: process.env.AGENT_HOME || "EMPTY", tmpdir: process.env.TMPDIR || "EMPTY" };
  const save = () => writeFileSync(receiptPath, JSON.stringify(data, null, 2) + "\\n");
  const recordNetwork = (kind, message) => {
    const request = message.request;
    if (!request) return;
    data.networkRequests.push({ kind, method: String(request.method ?? ""),
      origin: String(request.origin ?? request.host ?? ""), path: String(request.path ?? "") });
    save();
  };
  channel("http.client.request.start").subscribe(message => recordNetwork("http", message));
  channel("undici:request:create").subscribe(message => recordNetwork("undici", message));
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = function(...args) {
    const chunk = args[0];
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) { data.nativeStderr = (data.nativeStderr + chunk.toString()).slice(-65536); save(); }
    return originalStderrWrite.apply(process.stderr, args);
  };
  let pending = "";
  // Pi takes over stdout before loading extensions and retains a bound write.
  // Observe its actual lower-level stream write without changing any bytes.
  const originalWrite = process.stdout._write;
  process.stdout._write = function(...args) {
    const chunk = args[0];
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      pending += chunk.toString();
      let at;
      while ((at = pending.indexOf("\\n")) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        try {
          const frame = JSON.parse(line);
          const bytes = Buffer.byteLength(line);
          if (bytes > data.rpcRecordMax) {
            data.largestRecord = { bytes, type: frame.type, customType: frame.entry?.customType, toolCallId: frame.toolCallId };
            if (bytes > 256 * 1024) writeFileSync(receiptPath.replace(/\\.json$/, ".largest-rpc-record.json"), line);
          }
          data.rpcRecordMax = Math.max(data.rpcRecordMax, bytes);
          if (["tool_execution_start", "tool_execution_end"].includes(frame.type)) {
            data.toolExecutions.push({ type: frame.type, toolCallId: frame.toolCallId, toolName: frame.toolName, monotonicMs: performance.now(),
              isError: frame.isError, ...(frame.toolName === "paperclip_finish" ? { result: frame.result } : {}) });
          }
          data.rpcRecordMaxByType[frame.type] = Math.max(data.rpcRecordMaxByType[frame.type] ?? 0, bytes);
          data.rpcRecordCounts[frame.type] = (data.rpcRecordCounts[frame.type] ?? 0) + 1;
          save();
          if (frame.type === "extension_error") { data.extensionErrors.push(frame); save(); }
          if (frame.type === "extension_ui_request") { data.ui.push(frame); save(); }
        } catch { /* non-JSON output is not invented into native evidence */ }
      }
    }
    return originalWrite.apply(this, args);
  };
  const snapshot = (boundary, ctx) => {
    data.sessionId = ctx.sessionManager.getSessionId();
    data.sessionFile = ctx.sessionManager.getSessionFile();
    data.commands = pi.getCommands();
    data.tools = pi.getAllTools().map(tool => ({ name: tool.name, sourceInfo: tool.sourceInfo }));
    data.boundaries.push(boundary); save();
  };
  pi.on("session_start", (_event, ctx) => snapshot("session_start", ctx));
  pi.on("before_agent_start", (_event, ctx) => snapshot("before_agent_start", ctx));
  pi.on("agent_end", (_event, ctx) => snapshot("agent_end", ctx));
  pi.on("session_shutdown", (_event, ctx) => snapshot("session_shutdown", ctx));
  save();
}
`);
  const metadata = { fixture, agentDir, manifestSha256, includedToolCap, includedSubagents,
    subagentsProof: includedSubagents ? "required: actual turn-1 model tools and native package-origin command/tool sourceInfo" : "UNPROVEN: explicitly excluded from parent COPY only after native fixture yaml load failure; separate repaired-fixture gate pending",
    toolCapProof: includedToolCap ? "hook-only; no direct registered-tool/command seam; native fatal-load rule and zero extension_error, effect UNPROVEN" : "SKIPPED: private tool-cap/redact-secrets code not supplied by PAPERCLIP_PI_E2E_HOME_FIXTURE",
    langfuseLoadEvidence: "Pi package factory native stderr marker with PI_LANGFUSE_DEBUG=true; UI status assertion not used because RPC delivered no UI frame in prior run",
    commandEvidence: "native public pi.getCommands(), same registered list exposed by RPC get_commands; no second RPC stdin writer",
    langfusePackage, settings, remoteTargetTransport: "local (remoteTarget absent, NOT sandbox)" };
  await writeFile(join(root, "native-pi-home-preparation.json"), JSON.stringify(metadata, null, 2) + "\n");
  return { ...metadata, receiptPath };
}

export function readNativePiHomeProof(path: string): Record<string, any> | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export async function assertNativePiHomeProof(home: Awaited<ReturnType<typeof prepareNativePiHomeProof>>, piPid: number) {
  const native = readNativePiHomeProof(home.receiptPath);
  expect(native, "Pi's own receipt must exist, not just fixture settings").not.toBeNull();
  expect(native!.pid).toBe(piPid);
  expect(native!.agentDir).toBe(home.agentDir);
  const env = readFileSync(`/proc/${piPid}/environ`, "utf8").split("\0");
  expect(env.find(entry => entry.startsWith("PI_CODING_AGENT_DIR="))).toBe(`PI_CODING_AGENT_DIR=${home.agentDir}`);
  expect(native!.langfuseEnvironmentKeys).toEqual([]);
  if (home.includedSubagents) {
    expect(native!.tools).toContainEqual(expect.objectContaining({ name: "subagent", sourceInfo: expect.objectContaining({ origin: "package", baseDir: join(home.fixture, "pi-packages", "pi-subagents") }) }));
    expect(native!.commands).toContainEqual(expect.objectContaining({ source: "extension", sourceInfo: expect.objectContaining({ origin: "package", baseDir: join(home.fixture, "pi-packages", "pi-subagents") }) }));
  } else {
    expect(native!.tools.map((tool: any) => tool.name)).not.toContain("subagent");
  }
  expect(native!.piLangfuseDebug).toBe("true");
  expect(native!.nativeStderr, "Pi Langfuse package factory actually executed").toContain("[pi-langfuse] factory start");
  expect(native!.extensionErrors).toEqual([]);
  expect(native!.nativeStderr).not.toMatch(/Failed to load extension|Cannot find module/);
  const externalPosts = native!.networkRequests.filter((request: any) => request.method === "POST" && !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(request.origin));
  expect(externalPosts, "no non-loopback POST, including Langfuse export").toEqual([]);
  return { piPid, agentDir: native!.agentDir, subagentActualRegistered: home.includedSubagents, subagentsProof: home.subagentsProof, langfuseNativeLoadEvidence: "[pi-langfuse] factory start", noKeys: native!.langfuseEnvironmentKeys.length === 0, uiStatusAssertion: "not used; RPC delivered no status frame; native factory debug stderr is authoritative", extensionErrors: native!.extensionErrors.length, externalPosts: externalPosts.length, includedToolCap: home.includedToolCap, toolCapProof: home.toolCapProof, commandEvidence: home.commandEvidence, receiptPath: home.receiptPath };
}
