// Keep: private-storage trust boundary and exact-budget failure paths, without a 10 MiB HTTP body per edge.
import { describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";
import { pluginToolFinalBudget } from "../__tests__/fixtures/plugin-tool-final-budget.js";
import { MAX_PLUGIN_TOOL_RESULT_BYTES, preparePluginToolResult, pluginGatewayToolResult, validatePluginToolResult, validatePluginGatewayToolResult } from "./plugin-tool-result.js";
import { validateToolContent } from "./tool-content-guards.js";
import { buildGatewayToolCallResult } from "./tool-gateway-mcp-result.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

function storage(): StorageService {
  return { provider: "local_disk", deleteObject: vi.fn(async () => {}), putFile: vi.fn(async (input: any) => ({
    objectKey: input.objectKey, provider: "local_disk", byteSize: input.body.length,
    contentType: input.contentType, sha256: input.objectKey.split("/").at(-1), originalFilename: null,
  })) } as unknown as StorageService;
}

const execution = (result: ReturnType<typeof pluginToolFinalBudget>["result"]) => ({ pluginId: "capture", toolName: "frame", result });

describe("final plugin result cap including host references", () => {
  it("accepts exactly 10 MiB including transport, object key, digest and reference metadata", async () => {
    const fixture = pluginToolFinalBudget();
    expect(fixture.finalBudget).toBe(MAX_PLUGIN_TOOL_RESULT_BYTES);
    const store = storage();
    const prepared = await preparePluginToolResult(execution(fixture.result), { companyId: "c", invocationId: "i", storage: store });
    expect(() => validatePluginToolResult(prepared.result)).not.toThrow();
    expect((prepared.result.data as any).imageReferences).toEqual(fixture.imageReferences);
    expect(store.putFile).toHaveBeenCalledTimes(1);
  });

  it("rejects one final byte over before any private image write even though the input fits", async () => {
    const fixture = pluginToolFinalBudget({ over: 1 });
    expect(fixture.finalBudget).toBe(MAX_PLUGIN_TOOL_RESULT_BYTES + 1);
    expect(() => validatePluginToolResult(fixture.result)).not.toThrow();
    const store = storage();
    let rejected = false;
    try { await preparePluginToolResult(execution(fixture.result), { companyId: "c", invocationId: "i", storage: store }); }
    catch (error) { rejected = true; expect((error as Error).message).toContain("10 MiB"); }
    expect(rejected).toBe(true);
    expect(store.putFile).not.toHaveBeenCalled();
  });

  it.each([0, 1])("enforces the governed forwarded budget at exactly 10 MiB + %i bytes", async over => {
    const growth = Buffer.byteLength(REDACTED_EVENT_VALUE, "utf8") - Buffer.byteLength("x", "utf8");
    const fixture = pluginToolFinalBudget({ over: over - growth, metadata: { password: "x" } });
    const prepared = await preparePluginToolResult(execution(fixture.result), { companyId: "c", invocationId: "i", storage: storage() });
    const checked = await validateToolContent({ value: pluginGatewayToolResult(prepared), direction: "result" });
    const governed = checked.value as any;
    const { content, ...metadata } = governed.data;
    const actualBudget = Buffer.from(fixture.block.data, "base64").length + Buffer.byteLength(JSON.stringify({ data: metadata }), "utf8");
    expect(actualBudget).toBe(MAX_PLUGIN_TOOL_RESULT_BYTES + over);
    if (over) expect(() => validatePluginGatewayToolResult(governed)).toThrow("10 MiB");
    else {
      expect(() => validatePluginGatewayToolResult(governed)).not.toThrow();
      expect(buildGatewayToolCallResult({ text: "", structuredContent: governed.data }).content).toEqual(content);
    }
  });

  it("rejects unexpectedly larger storage metadata after write and cleans the private object", async () => {
    const fixture = pluginToolFinalBudget();
    const store = storage();
    const key = fixture.imageReferences[0]!.objectKey + "/unexpected";
    vi.mocked(store.putFile).mockResolvedValue({ provider: "local_disk", objectKey: key, contentType: "image/png", byteSize: 25,
      sha256: fixture.imageReferences[0]!.sha256, originalFilename: null });
    let rejected = false;
    try { await preparePluginToolResult(execution(fixture.result), { companyId: "c", invocationId: "i", storage: store }); }
    catch (error) { rejected = true; expect((error as Error).message).toContain("10 MiB"); }
    expect(rejected).toBe(true);
    expect(store.deleteObject).toHaveBeenCalledWith("c", key);
  });
});
