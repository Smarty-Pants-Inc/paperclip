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

/** Only the new top-level field opts in; all historical data remains opaque. */
export function validatePluginToolResult(result: ToolResult): Content[] | null {
  if (!Object.prototype.hasOwnProperty.call(result, "mcpContent")) return null;
  if (!Array.isArray(result.mcpContent) || result.mcpContent.length === 0 || result.mcpContent.length > MAX_PLUGIN_TOOL_CONTENT_ITEMS) {
    fail("content must contain 1–64 text/image blocks");
  }
  // Preserve legacy text beside native images, without duplicating a matching
  // explicit text block. Do not mutate the plugin's worker result.
  const content = typeof result.content === "string" && result.content.length > 0
    && !result.mcpContent.some(value => record(value)?.type === "text" && record(value)?.text === result.content)
    ? [{ type: "text", text: result.content }, ...result.mcpContent] : result.mcpContent;
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
  const { mcpContent: _content, ...metadata } = result;
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
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
  context.signal?.throwIfAborted();
  let storage = context.storage;
  if (content.some(item => item.type === "image")) storage ??= getStorageService();
  const plannedReferences = content.flatMap(item => {
    if (item.type !== "image") return [];
    const reference = toolImageReference(item.data);
    return [{ ...reference, objectKey: `${context.companyId}/tool-results/${context.invocationId}/${reference.sha256}`,
      provider: storage!.provider, mimeType: item.mimeType }];
  });
  const withReferences = (imageReferences: typeof plannedReferences): ToolExecutionResult => ({
    ...execution,
    result: { ...execution.result, mcpContent: content, data: { ...record(execution.result.data), transport: "paperclip_plugin", imageReferences } },
  });
  // Host metadata is part of the advertised total, not a post-validation bonus.
  // Reject its entire known budget before the first private image write.
  validatePluginToolResult(withReferences(plannedReferences).result);
  const imageReferences: typeof plannedReferences = [];
  try {
    for (const item of content) {
      if (item.type !== "image") continue;
      context.signal?.throwIfAborted();
      const planned = plannedReferences[imageReferences.length]!;
      const stored = await storage!.putFile({
        companyId: context.companyId,
        namespace: "tool-results",
        objectKey: planned.objectKey,
        originalFilename: null,
        contentType: item.mimeType,
        body: Buffer.from(item.data, "base64"),
        signal: context.signal,
      });
      imageReferences.push({ ...planned, objectKey: stored.objectKey, provider: stored.provider });
    }
    const prepared = withReferences(imageReferences);
    // Do not trust a provider to return metadata of the planned byte length.
    validatePluginToolResult(prepared.result);
    return prepared;
  } catch (error) {
    // Earlier writes, including a late metadata-cap failure, are not success.
    await Promise.allSettled(imageReferences.map(image => storage!.deleteObject(context.companyId, image.objectKey)));
    throw error;
  }
}

/** Only opted-in native content unwraps; historical text-only envelopes stay byte-identical. */
export function pluginGatewayToolResult(execution: ToolExecutionResult): unknown {
  if (!Object.prototype.hasOwnProperty.call(execution.result, "mcpContent")) return execution;
  const { mcpContent, ...result } = execution.result;
  // Adapt only explicit native results into #16517's existing governed shape.
  // No second wire projection, and no duplicate body in structured metadata.
  return { ...result, data: { ...record(result.data), transport: "paperclip_plugin", content: mcpContent } };
}

/** Reuse the same validator on #16517's governed deliverable before success. */
export function validatePluginGatewayToolResult(value: unknown): void {
  const result = record(value);
  const data = record(result?.data);
  if (data?.transport !== "paperclip_plugin") return;
  const { content: mcpContent, ...metadata } = data;
  validatePluginToolResult({ ...result, data: metadata, mcpContent } as ToolResult);
}
