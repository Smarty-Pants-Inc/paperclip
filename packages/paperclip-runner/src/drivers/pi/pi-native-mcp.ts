import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../private-file.js";

const NATIVE_MCP_ENV = [
  "PAPERCLIP_NATIVE_MCP_NAME",
  "PAPERCLIP_NATIVE_MCP_URL",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Configure Pi's built-in MCP with a nonsecret URL, never persisting the bearer token. */
export async function configurePiNativeMcp(agentDirectory: string, environment: NodeJS.ProcessEnv): Promise<void> {
  if (NATIVE_MCP_ENV.every((key) => environment[key] === undefined)) return;
  if (NATIVE_MCP_ENV.some((key) => !environment[key]?.trim())) {
    throw new Error("Pi native MCP requires non-empty PAPERCLIP_NATIVE_MCP_NAME, PAPERCLIP_NATIVE_MCP_URL, and PAPERCLIP_NATIVE_MCP_TOKEN together (values redacted)");
  }
  const name = environment.PAPERCLIP_NATIVE_MCP_NAME!;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Pi native MCP server name must contain only letters, digits, underscores, and hyphens (value redacted)");
  }
  const url = environment.PAPERCLIP_NATIVE_MCP_URL!;
  try {
    const parsed = new URL(url);
    // Decode escapes too: an encoded bearer must not be persisted in any URL component.
    const decoded = decodeURIComponent(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password
      || url.includes(environment.PAPERCLIP_NATIVE_MCP_TOKEN!)
      || decoded.includes(environment.PAPERCLIP_NATIVE_MCP_TOKEN!)) throw new Error();
  } catch {
    throw new Error("Pi native MCP URL must be http(s), without userinfo or the bearer token (values redacted)");
  }
  const filePath = join(agentDirectory, "mcp.json");
  let existing: unknown = {};
  try {
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 60 * 1024) throw new Error("oversized");
    existing = JSON.parse(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Pi mcp.json could not be read as bounded JSON; refusing to overwrite it (content redacted)");
    }
  }
  if (!isRecord(existing) || (existing.mcpServers !== undefined && !isRecord(existing.mcpServers))) {
    throw new Error("Pi mcp.json and mcpServers must be objects; refusing to overwrite them");
  }
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  if (Object.keys(servers).some((key) => key !== name && key.replaceAll("-", "_") === name.replaceAll("-", "_"))) {
    throw new Error("Pi native MCP server name collides with an existing server (values redacted)");
  }
  // Pi 1.5.2 expands env expressions in headers, not URL; its validator needs a literal URL.
  const entry = {
    url,
    headers: { Authorization: "Bearer ${PAPERCLIP_NATIVE_MCP_TOKEN}" },
    exposure: "codemode",
  };
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  await writePrivateFile(filePath, `${JSON.stringify({ ...existing, mcpServers: { ...servers, [name]: entry } })}\n`);
}
