// Keep: data safety at the real worker/host framing and logger boundary (R1).
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

vi.mock("../middleware/logger.js", () => {
  const logger: Record<string, unknown> = Object.fromEntries(["trace", "debug", "info", "warn", "error", "fatal"].map(level => [level, vi.fn()]));
  logger.child = vi.fn(() => logger);
  return { logger, httpLogger: vi.fn() };
});
import { logger } from "../middleware/logger.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";

const data = Buffer.from("private malformed frame bytes: never preview this").toString("base64");
const manifest: PaperclipPluginManifestV1 = {
  id: "test.private-frame", apiVersion: 1, version: "1.0.0", displayName: "Privacy fixture", description: "Synthetic framing test",
  author: "Paperclip", categories: ["automation"], capabilities: [], entrypoints: { worker: "unused.cjs" },
};

describe("worker image framing privacy", () => {
  it.each(["json", "version"])("references a malformed %s frame without body fragments and still delivers the next reply", async mode => {
    vi.clearAllMocks();
    const handle = createPluginWorkerHandle(manifest.id, {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-malformed-image.cjs", import.meta.url)),
      manifest, config: {}, instanceInfo: { instanceId: "test", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {}, autoRestart: false,
    });
    try {
      await handle.start();
      const result = await handle.call("executeTool", { toolName: "frame", parameters: { mode }, runContext: { companyId: "c", agentId: "a", runId: "r", projectId: "" } });
      expect(result).toMatchObject({ mcpContent: [{ type: "image", data, mimeType: "image/png" }] });
      const warnings = vi.mocked(logger.warn).mock.calls;
      expect(warnings).toHaveLength(1);
      const logs = JSON.stringify([logger.trace, logger.debug, logger.info, logger.warn, logger.error, logger.fatal].flatMap(log => vi.mocked(log).mock.calls));
      expect({ fullBody: logs.includes(data), fragment: logs.includes(data.slice(0, 16)), dataUrl: logs.includes("data:image/") }).toEqual({ fullBody: false, fragment: false, dataUrl: false });
      // The child returns only digest/bytes for its invalid line, so assert the
      // exact framing reference without ever printing the body on a failure.
      expect(warnings[0]![0]).toMatchObject((result as unknown as { framing: { sizeBytes: number; sha256: string } }).framing);
      expect(warnings[0]![0]).not.toHaveProperty("rawLine");
    } finally { await handle.stop(); }
  });
});
