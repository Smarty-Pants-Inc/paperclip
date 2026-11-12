import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { configurePiNativeMcp } from "./pi-native-mcp.js";

const environment: NodeJS.ProcessEnv = {
  PAPERCLIP_NATIVE_MCP_NAME: "paperclip-assigned",
  PAPERCLIP_NATIVE_MCP_URL: "https://gateway.invalid/mcp",
  PAPERCLIP_NATIVE_MCP_TOKEN: "fake-unit-token-never-persist",
};
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup() { directory = await mkdtemp(join(tmpdir(), "pi-native-mcp-")); return join(directory, "mcp.json"); }

describe("configurePiNativeMcp (credential and configuration safety)", () => {
  it("does nothing for relay routes with all three bindings absent", async () => {
    const file = await setup();
    await configurePiNativeMcp(directory, {});
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("writes a literal nonsecret URL, header env expression, codemode exposure, and private permissions", async () => {
    const file = await setup();
    await configurePiNativeMcp(directory, environment);
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toEqual({ mcpServers: { "paperclip-assigned": {
      url: environment.PAPERCLIP_NATIVE_MCP_URL,
      headers: { Authorization: "Bearer ${PAPERCLIP_NATIVE_MCP_TOKEN}" },
      exposure: "codemode",
    } } });
    expect(text).not.toContain(environment.PAPERCLIP_NATIVE_MCP_TOKEN);
    expect(text).toContain(environment.PAPERCLIP_NATIVE_MCP_URL);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it.each([
    "${PAPERCLIP_NATIVE_MCP_URL}", "not-a-url", "file:///tmp/mcp", "ftp://gateway.invalid/mcp",
    "https://user:password@gateway.invalid/mcp", "https://user@gateway.invalid/mcp",
    `https://gateway.invalid/${environment.PAPERCLIP_NATIVE_MCP_TOKEN}`,
    `https://gateway.invalid/?token=${environment.PAPERCLIP_NATIVE_MCP_TOKEN}`,
    `https://gateway.invalid/#${environment.PAPERCLIP_NATIVE_MCP_TOKEN}`,
    `https://gateway.invalid/?token=${encodeURIComponent(environment.PAPERCLIP_NATIVE_MCP_TOKEN!).replaceAll("-", "%2D")}`,
  ])("rejects unsafe URL %s without file changes or value disclosure", async (url) => {
    const file = await setup();
    const before = '{"mcpServers":{"computer":{"command":"computer-mcp"}}}\n';
    await writeFile(file, before);
    const error = await configurePiNativeMcp(directory, { ...environment, PAPERCLIP_NATIVE_MCP_URL: url }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/URL.*values redacted/);
    expect((error as Error).message).not.toContain(url);
    expect((error as Error).message).not.toContain(environment.PAPERCLIP_NATIVE_MCP_TOKEN);
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it.skipIf(!process.env.PAPERCLIP_TEST_PI_MCP_CONFIG_MODULE)("is accepted by the real installed Pi validator (fake bindings only)", async () => {
    const moduleUrl = pathToFileURL(process.env.PAPERCLIP_TEST_PI_MCP_CONFIG_MODULE!).href;
    const { validateMcpServerConfig } = await import(/* @vite-ignore */ moduleUrl);
    const file = await setup();
    await configurePiNativeMcp(directory, environment);
    const text = await readFile(file, "utf8");
    const entry = JSON.parse(text).mcpServers[environment.PAPERCLIP_NATIVE_MCP_NAME!];
    expect(validateMcpServerConfig(environment.PAPERCLIP_NATIVE_MCP_NAME, entry).kind).toBe("http");
    expect(entry.headers.Authorization).toBe("Bearer ${PAPERCLIP_NATIVE_MCP_TOKEN}");
    expect(text).not.toContain(environment.PAPERCLIP_NATIVE_MCP_TOKEN);
    expect(validateMcpServerConfig(environment.PAPERCLIP_NATIVE_MCP_NAME, { ...entry, url: "${PAPERCLIP_NATIVE_MCP_URL}" }).kind).toBe("invalid");
  });
  it("preserves computer and every unrelated entry and top-level setting across repeated merges", async () => {
    const file = await setup();
    const computer = { command: "computer-mcp", args: ["--local"], exposure: "codemode" };
    const other = { url: "https://other.invalid/mcp", headers: { Authorization: "Bearer ${OTHER_TOKEN}" } };
    await writeFile(file, JSON.stringify({ autoEnableCodemode: true, extra: { keep: 1 }, mcpServers: {
      computer, other, "paperclip-assigned": { url: "https://stale.invalid", enabled: false },
    } }), { mode: 0o644 });
    await configurePiNativeMcp(directory, environment);
    const once = await readFile(file, "utf8");
    await configurePiNativeMcp(directory, environment);
    expect(await readFile(file, "utf8")).toBe(once);
    expect(JSON.parse(once)).toMatchObject({ autoEnableCodemode: true, extra: { keep: 1 }, mcpServers: { computer, other } });
    expect(JSON.parse(once).mcpServers["paperclip-assigned"].enabled).toBeUndefined();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
  it.each([1, 2, 3, 4, 5, 6])("rejects partial binding mask %i without logging values or changing the file", async (mask) => {
    const file = await setup();
    await writeFile(file, "{}\n");
    const partial = Object.fromEntries(Object.entries(environment).filter((_, index) => mask & (1 << index)));
    await expect(configurePiNativeMcp(directory, partial)).rejects.toThrow(/requires non-empty PAPERCLIP_NATIVE_MCP_NAME.*values redacted/);
    expect(await readFile(file, "utf8")).toBe("{}\n");
  });
  it.each(["", " ", "bad/name", "${FAKE_NAME}"])("rejects invalid names or empty bindings (%s) safely", async (name) => {
    await setup();
    const error = await configurePiNativeMcp(directory, { ...environment, PAPERCLIP_NATIVE_MCP_NAME: name }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(environment.PAPERCLIP_NATIVE_MCP_TOKEN);
  });
  it.each(["{fake-sensitive-json", "[]", '{"mcpServers":[]}', '{"mcpServers":null}'])("refuses invalid existing configuration without leaking or replacing it", async (text) => {
    const file = await setup();
    await writeFile(file, text);
    await expect(configurePiNativeMcp(directory, environment)).rejects.toThrow(/refusing to overwrite/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
  it("rejects Pi's hyphen/underscore server-name collision without losing computer", async () => {
    const file = await setup();
    const text = JSON.stringify({ mcpServers: { computer: { command: "computer-mcp" }, paperclip_assigned: { command: "other" } } });
    await writeFile(file, text);
    await expect(configurePiNativeMcp(directory, environment)).rejects.toThrow(/collides/);
    expect(await readFile(file, "utf8")).toBe(text);
  });
});
