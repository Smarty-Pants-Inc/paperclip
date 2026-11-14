import type { ToolResult } from "@paperclipai/plugin-sdk";
import type { ToolExecutionResult } from "./plugin-tool-registry.js";
import { getStorageService, type StorageService } from "../storage/index.js";
import { toolImageReference } from "./tool-result-images.js";

export const MAX_PLUGIN_TOOL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PLUGIN_TOOL_RESULT_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_TOOL_CONTENT_ITEMS = 64;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" };
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function fail(reason: string): never {
  // Never echo a plugin-controlled body into errors/logs.
  throw new Error(`Invalid plugin tool content: ${reason}`);
}

/** Legacy data is untouched; opting into data.content opts into strict MCP limits. */
export function validatePluginToolResult(result: ToolResult): Content[] | null {
  const data = record(result.data);
  if (!data || !("content" in data)) return null;
  if (!Array.isArray(data.content) || data.content.length === 0 || data.content.length > MAX_PLUGIN_TOOL_CONTENT_ITEMS) {
    fail("content must contain 1–64 text/image blocks");
  }
  // Preserve legacy text beside native images, without duplicating a matching
  // explicit text block. Do not mutate the plugin's worker result.
  const content = typeof result.content === "string" && result.content.length > 0
    && !data.content.some(value => record(value)?.type === "text" && record(value)?.text === result.content)
    ? [{ type: "text", text: result.content }, ...data.content] : data.content;
  if (content.length > MAX_PLUGIN_TOOL_CONTENT_ITEMS) fail("content must contain 1–64 text/image blocks including legacy text");
  let decodedSize = 0;
  for (const value of content) {
    const item = record(value);
    if (item?.type === "text" && typeof item.text === "string" && Object.keys(item).every(key => ["type", "text"].includes(key))) {
      decodedSize += Buffer.byteLength(item.text, "utf8");
    } else if (item?.type === "image" && typeof item.data === "string" && ["image/png", "image/jpeg", "image/webp"].includes(String(item.mimeType)) && Object.keys(item).every(key => ["type", "data", "mimeType"].includes(key))) {
      if (item.data.length === 0 || item.data.length > Math.ceil(MAX_PLUGIN_TOOL_IMAGE_BYTES / 3) * 4) fail("image exceeds 5 MiB or is empty");
      // Node's base64 decoder is permissive; require canonical padded base64.
      if (item.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(item.data)) fail("image data must be canonical base64");
      const bytes = Buffer.from(item.data, "base64");
      if (bytes.length > MAX_PLUGIN_TOOL_IMAGE_BYTES) fail("image exceeds 5 MiB");
      if (bytes.toString("base64") !== item.data) fail("image data must be canonical base64");
      decodedSize += bytes.length;
    } else fail("only text and PNG/JPEG/WebP image blocks are supported");
    if (decodedSize > MAX_PLUGIN_TOOL_RESULT_BYTES) fail("result exceeds 10 MiB decoded");
  }
  // Bound metadata, duplicate legacy text, keys, and base64 wire expansion too.
  const { content: _content, ...metadata } = data;
  const metadataBytes = Buffer.byteLength(JSON.stringify({ ...result, data: metadata }), "utf8");
  if (decodedSize + metadataBytes > MAX_PLUGIN_TOOL_RESULT_BYTES) fail("result exceeds 10 MiB decoded including metadata");
  return content as Content[];
}

/** Store bounded images privately; logs retain only these company-scoped references. */
export async function preparePluginToolResult(
  execution: ToolExecutionResult,
  context: { companyId: string; invocationId: string; storage?: StorageService; signal?: AbortSignal },
): Promise<ToolExecutionResult> {
  const content = validatePluginToolResult(execution.result);
  if (!content) return execution;
  const imageReferences = [];
  let storage = context.storage;
  try {
    for (const item of content) {
      if (item.type !== "image") continue;
      context.signal?.throwIfAborted();
      storage ??= getStorageService();
      const reference = toolImageReference(item.data);
      const stored = await storage.putFile({
        companyId: context.companyId,
        namespace: "tool-results",
        objectKey: `${context.companyId}/tool-results/${context.invocationId}/${reference.sha256}`,
        originalFilename: null,
        contentType: item.mimeType,
        body: Buffer.from(item.data, "base64"),
        signal: context.signal,
      });
      imageReferences.push({ ...reference, objectKey: stored.objectKey, provider: stored.provider, mimeType: item.mimeType });
    }
  } catch (error) {
    // Earlier writes from this failed result must not become successful receipts.
    await Promise.allSettled(imageReferences.map(image => storage!.deleteObject(context.companyId, image.objectKey)));
    throw error;
  }
  return {
    ...execution,
    result: { ...execution.result, data: { ...record(execution.result.data), transport: "paperclip_plugin", content, imageReferences } },
  };
}

/** Only opted-in native content unwraps; historical text-only envelopes stay byte-identical. */
export function pluginGatewayToolResult(execution: ToolExecutionResult): unknown {
  const data = record(execution.result.data);
  return data?.transport === "paperclip_plugin" && Array.isArray(data.content) ? execution.result : execution;
}
