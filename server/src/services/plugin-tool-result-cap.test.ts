// Keep: private-storage trust boundary and exact-budget failure paths, without a 10 MiB HTTP body per edge.
import { describe, expect, it, vi } from "vitest";
import type { StorageService } from "../storage/types.js";
import { pluginToolFinalBudget } from "../__tests__/fixtures/plugin-tool-final-budget.js";
import { MAX_PLUGIN_TOOL_RESULT_BYTES, preparePluginToolResult, validatePluginToolResult } from "./plugin-tool-result.js";

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
