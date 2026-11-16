import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { probePiNativeEnvironment } from "./pi-environment-probe.js";
import type { PiRpcRecord, PiRpcTransport, PiRpcTransportOptions } from "./pi-rpc-transport.js";

// Keep: the observed no-env Code Reviewer RUN lost the image's four packages
// after the server injected its per-session PI_CODING_AGENT_DIR (R12). Exercise
// the real driver/probe open and Pi 1.5.2 resource loader; only the model peer is
// controlled. No provider calls or registry access are needed to load packages.
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const packageNames = ["tool-cap", "pi-subagents", "langfuse-pi", "@lll9p/pi-better-compaction"];
const model = { provider: "paperclip", id: "faux" };

class SettingsTransport {
  closed = false;
  exited = false;
  pid = null;
  loaded: string[] = [];
  queue: PiRpcRecord[] = [];
  wake?: () => void;
  loading?: Promise<void>;
  constructor(readonly options: PiRpcTransportOptions) {}
  async load() {
    const loader = new DefaultResourceLoader({ cwd: this.options.cwd!, agentDir: this.options.env!.PI_CODING_AGENT_DIR!,
      noThemes: true, noContextFiles: true });
    await loader.reload({ resolveProjectTrust: async () => false });
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    this.loaded = await Promise.all(result.extensions.map(async extension =>
      JSON.parse(await readFile(join(dirname(extension.path), "..", "package.json"), "utf8")).name as string));
  }
  async request(type: string, _input?: PiRpcRecord) {
    await (this.loading ??= this.load());
    if (type === "prompt") {
      const message = { role: "assistant", provider: "paperclip", model: "faux", timestamp: 1, responseId: "hello",
        stopReason: "stop", content: [{ type: "text", text: "hello" }] };
      this.queue.push({ type: "agent_start" }, { type: "message_start", message }, { type: "message_end", message },
        { type: "turn_end", message }, { type: "agent_end", messages: [message], willRetry: false }, { type: "agent_settled", aborted: false });
      this.wake?.();
    }
    return { data: type === "get_state" ? { sessionId: "image-settings-session", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model : type === "get_available_models" ? { models: [model] }
      : type === "get_available_thinking_levels" ? { levels: ["off"] } : type === "prompt" ? { disposition: "started" } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const value = this.queue.shift();
      if (value) yield value;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-image-settings-")); roots.push(root);
  const home = join(root, "non-default-box-home"), imageHome = join(home, ".pi", "agent"), workspace = join(root, "workspace");
  const packageRoots = packageNames.map((name, index) => index === 3
    ? join(imageHome, "npm", "node_modules", name) : join(root, "opt", "pi-packages", name));
  for (const [index, packageRoot] of packageRoots.entries()) {
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageNames[index], version: index === 3 ? "0.7.4" : "1.0.0",
      pi: { extensions: ["extensions/index.js"] } }));
    await writeFile(join(packageRoot, "extensions", "index.js"), "export default function () {}\n");
  }
  await mkdir(workspace);
  // A command that fails if Pi tries an install, in addition to offline mode and
  // an unreachable registry. The same-home control must load its cached npm root.
  const npmCommand = [process.execPath, "-e", "throw new Error('registry access forbidden')"];
  const source = { packages: [...packageRoots.slice(0, 3), "npm:@lll9p/pi-better-compaction@0.7.4"],
    defaultProvider: "image-provider", defaultModel: "image-model", compaction: { reserveTokens: 321, keepRecentTokens: 654 },
    retry: { enabled: false }, npmCommand };
  const bytes = `${JSON.stringify(source, null, 2)}\n`;
  await writeFile(join(imageHome, "settings.json"), bytes);
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("npm_config_registry", "http://127.0.0.1:1");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
  let sequence = 0;
  async function open(kind: "run" | "probe", withEnv = false, ownSettings?: object) {
    const id = `${kind}-${++sequence}`, agentHome = withEnv ? imageHome : join(root, id, "pi-agent");
    if (ownSettings) {
      await mkdir(agentHome, { recursive: true });
      await writeFile(join(agentHome, "settings.json"), JSON.stringify(ownSettings));
    }
    // No-env means no USER override: native-session-executor injects pi-agent
    // into the box process. Reproduce that value in process.env, not just options.
    vi.stubEnv("PI_CODING_AGENT_DIR", agentHome);
    let transport!: SettingsTransport;
    const driver = new PiRpcDriver({ command: process.execPath, runtimeDirectory: join(root, id, "runtime"), model: "paperclip/faux", piRpcThinkingLevel: "off",
      environment: { HOME: join(root, "projected-home-not-box-home"), PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: "1",
        PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "env", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1",
        PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => { transport = new SettingsTransport(options); return transport as unknown as PiRpcTransport; } });
    if (kind === "probe") {
      const result = await probePiNativeEnvironment({ driver, config: { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off" },
        runId: id, normalizedSessionId: id, workingDirectory: workspace, timeoutMs: 5000 });
      expect(result.helloProbePassed).toBe(true);
    } else {
      const session = await driver.openSession({ runId: id, normalizedSessionId: id, workingDirectory: workspace });
      try { expect((await session.events()[Symbol.asyncIterator]().next()).value?.payload.context).toMatchObject({ model: "paperclip/faux" }); }
      finally { await session.close({ reason: "settings test complete" }); }
    }
    expect(transport.closed).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    return { agentHome, loaded: transport.loaded, settings: JSON.parse(await readFile(join(agentHome, "settings.json"), "utf8")) };
  }
  return { home, imageHome, packageRoots, source, bytes, open };
}

it.each(["run", "probe"] as const)("R12 %s resolves the IMAGE base from runtime HOME, read-only, not the empty session home", async kind => {
  const f = await fixture();
  expect(homedir()).toBe(f.home);
  const opened = await f.open(kind);
  expect.soft(opened.settings.packages).toEqual(f.packageRoots);
  expect.soft(opened.settings.compaction).toEqual({ reserveTokens: 32000 });
  expect.soft(opened.settings.retry).toBeUndefined();
  expect.soft(opened.settings.defaultProvider).toBeUndefined();
  expect.soft(opened.settings.defaultModel).toBeUndefined();
  // RFL: packages are the only settings inherited from the image.
  expect.soft(opened.settings).toEqual({ packages: f.packageRoots, compaction: { reserveTokens: 32000 } });
  expect(await readFile(join(f.imageHome, "settings.json"), "utf8")).toBe(f.bytes);
});

it.each(["run", "probe"] as const)("R12 %s loads all four packages offline, equal to the with-env R11 control", async kind => {
  const f = await fixture();
  const withoutEnv = await f.open(kind), withEnv = await f.open(kind, true);
  expect.soft(withoutEnv.settings.packages).toEqual(f.packageRoots);
  expect.soft(withoutEnv.settings.packages?.every((source: string) => isAbsolute(source) && !source.startsWith("npm:"))).toBe(true);
  expect.soft(withoutEnv.loaded.sort()).toEqual([...packageNames].sort());
  expect.soft(withoutEnv.loaded).toEqual(withEnv.loaded.sort());
  expect(withEnv.settings.packages).toEqual(f.source.packages);
  expect(await readFile(join(f.imageHome, "settings.json"), "utf8")).toBe(f.bytes);
});

it.each(["run", "probe"] as const)("R12 %s keeps managed loopback defaults above image defaults in the per-session file", async kind => {
  const f = await fixture();
  const opened = await f.open(kind);
  expect.soft(opened.settings.defaultProvider).toBeUndefined();
  expect.soft(opened.settings.defaultModel).toBeUndefined();
  const models = JSON.parse(await readFile(join(opened.agentHome, "models.json"), "utf8"));
  expect(models.providers.paperclip.models[0].id).toBe("faux");
  expect(models.providers.paperclip.baseUrl).toBe("http://127.0.0.1:1");
  expect(await readFile(join(f.imageHome, "settings.json"), "utf8")).toBe(f.bytes);
});

it("R11 keeps the same image home's settings bytes and npm declarations unchanged", async () => {
  const f = await fixture();
  const opened = await f.open("run", true);
  expect(opened.loaded.sort()).toEqual([...packageNames].sort());
  expect(opened.settings).toEqual(f.source);
  expect(await readFile(join(f.imageHome, "settings.json"), "utf8")).toBe(f.bytes);
});

it("does not replace a session's own settings with the image base", async () => {
  const f = await fixture();
  const opened = await f.open("run", false, { packages: [], retry: { enabled: true }, compaction: { reserveTokens: 77 } });
  expect(opened.settings.packages).toEqual([]);
  expect(opened.settings.retry).toEqual({ enabled: true });
  expect(opened.settings.compaction.reserveTokens).toBe(77);
  expect(opened.loaded).toEqual([]);
  expect(await readFile(join(f.imageHome, "settings.json"), "utf8")).toBe(f.bytes);
});
