// Keep reason: credential/configuration trust boundary at the real driver's spawn boundary.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcTransportOptions } from "./pi-rpc-transport.js";

const native = {
  PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
  PAPERCLIP_NATIVE_MCP_URL: "http://127.0.0.1:9/mcp",
  PAPERCLIP_NATIVE_MCP_TOKEN: "fake-driver-only-bearer-never-persist",
};
const computer = { command: process.execPath, args: ["computer-fixture.mjs"], exposure: "codemode" };
const stop = new Error("controlled stop at native spawn boundary");

// A throwing transport factory inspects the actual launch inputs and written file;
// no helper mock, source-text assertion, child process, or provider request is used.
describe("Pi RPC native MCP integration before spawn", () => {
  it.each([
    { route: "broker", model: "paperclip/faux", credential: "broker" },
    { route: "managed env", model: "paperclip/faux", credential: "env" },
    { route: "native custom", model: "controlled/faux", credential: "env" },
  ])("configures $route from the unfiltered driver environment without losing native home", async ({ model, credential }) => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-native-mcp-"));
    const home = join(root, "agent"), workspace = join(root, "workspace");
    await mkdir(home); await mkdir(workspace);
    await writeFile(join(home, "mcp.json"), JSON.stringify({ autoEnableCodemode: true, mcpServers: { computer } }));
    let launch: PiRpcTransportOptions | undefined;
    try {
      const driver = new PiRpcDriver({ model, piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), systemInstructions: "HOST_INSTRUCTIONS_STAY", environment: {
        PI_CODING_AGENT_DIR: home, HOME: root, PAPERCLIP_PI_RPC_CREDENTIAL_MODE: credential,
        PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:9/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat",
        PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "fake-provider-only", ...native,
      }, transportFactory: options => { launch = options; throw stop; } });
      await expect(driver.openSession({ runId: "mcp", normalizedSessionId: "mcp", workingDirectory: workspace })).rejects.toBe(stop);
      expect(launch).toBeDefined();
      expect(launch!.env).toMatchObject({ ...native, PI_CODING_AGENT_DIR: home });
      const file = join(launch!.env!.PI_CODING_AGENT_DIR!, "mcp.json");
      const text = await readFile(file, "utf8");
      expect(JSON.parse(text)).toEqual({ autoEnableCodemode: true, mcpServers: {
        computer, "paperclip-assigned": { url: native.PAPERCLIP_NATIVE_MCP_URL, headers: { Authorization: "Bearer ${PAPERCLIP_NATIVE_MCP_TOKEN}" }, exposure: "codemode" },
      } });
      expect(text).not.toContain(native.PAPERCLIP_NATIVE_MCP_TOKEN);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      for (const flag of ["--no-mcp", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]) expect(launch!.args).not.toContain(flag);
      expect(launch!.args).toContain("--append-system-prompt");
      expect(launch!.args).toContain("--extension");
      expect(launch!.args).toContain("--no-approve");
      expect(launch!.args).toContain("--no-themes");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses partial native bindings before constructing the transport on a native route", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-native-mcp-partial-"));
    let spawned = false;
    try {
      const driver = new PiRpcDriver({ model: "controlled/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), environment: {
        PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_NATIVE_MCP_TOKEN: native.PAPERCLIP_NATIVE_MCP_TOKEN,
      }, transportFactory: () => { spawned = true; throw stop; } });
      await expect(driver.openSession({ runId: "partial", normalizedSessionId: "partial", workingDirectory: root })).rejects.toThrow(/requires non-empty.*values redacted/);
      expect(spawned).toBe(false);
      await expect(stat(join(root, "agent", "mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("leaves relay native home untouched when all three native bindings are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-native-mcp-relay-"));
    const home = join(root, "agent"); await mkdir(home);
    const file = join(home, "mcp.json"), before = JSON.stringify({ mcpServers: { computer }, autoEnableCodemode: false });
    await writeFile(file, before);
    try {
      const driver = new PiRpcDriver({ model: "controlled/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), environment: { PI_CODING_AGENT_DIR: home }, transportFactory: () => { throw stop; } });
      await expect(driver.openSession({ runId: "relay", normalizedSessionId: "relay", workingDirectory: root })).rejects.toBe(stop);
      expect(await readFile(file, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
