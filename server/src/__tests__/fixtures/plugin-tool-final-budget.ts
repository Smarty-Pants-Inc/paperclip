import { createHash } from "node:crypto";
import { MAX_PLUGIN_TOOL_RESULT_BYTES } from "../../services/plugin-tool-result.js";

/** Synthetic boundary fixture; independently count decoded bytes + final host metadata. */
export function pluginToolFinalBudget({ companyId = "c", invocationId = "i", over = 0, metadata = {} }: {
  companyId?: string; invocationId?: string; over?: number; metadata?: Record<string, unknown>;
} = {}) {
  const bytes = Buffer.from("synthetic boundary pixels");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const block = { type: "image" as const, mimeType: "image/png" as const, data: bytes.toString("base64") };
  const imageReferences = [{ reference: `sha256:${sha256}`, sha256, sizeBytes: bytes.length,
    objectKey: `${companyId}/tool-results/${invocationId}/${sha256}`, provider: "local_disk" as const, mimeType: block.mimeType }];
  const finalData = { ...metadata, padding: "", transport: "paperclip_plugin", imageReferences };
  const emptyBudget = bytes.length + Buffer.byteLength(JSON.stringify({ data: finalData }), "utf8");
  const padding = " ".repeat(MAX_PLUGIN_TOOL_RESULT_BYTES - emptyBudget + over);
  return { block, imageReferences, result: { mcpContent: [block], data: { ...metadata, padding } },
    finalBudget: bytes.length + Buffer.byteLength(JSON.stringify({ data: { ...finalData, padding } }), "utf8") };
}
