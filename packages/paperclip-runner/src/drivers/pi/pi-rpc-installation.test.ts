import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { verifyPiRpcDistribution, PI_RPC_DISTRIBUTION } from "./pi-rpc-installation.js";

// Trust boundary: an installed manifest can never authorize an invented release.
describe("native Pi-only distribution", () => {
  it("rejects an invented tree even if it copies the expected declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-unqualified-"));
    try {
      await writeFile(join(root, "pi-distribution.json"), JSON.stringify(PI_RPC_DISTRIBUTION));
      await expect(verifyPiRpcDistribution(root, "linux-x64")).rejects.toThrow("trusted complete closure");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not imply unsupported platforms are qualified", async () => {
    await expect(verifyPiRpcDistribution("/not-read", "linux-arm64")).rejects.toThrow("target unsupported");
  });
  it.skipIf(!process.env.PAPERCLIP_TEST_PI_RPC_RUNTIME)("verifies every byte of the actual native 1.5.2 graph", async () => {
    await expect(verifyPiRpcDistribution(process.env.PAPERCLIP_TEST_PI_RPC_RUNTIME!)).resolves.toMatchObject({ version: "1.5.2", closureDigest: PI_RPC_DISTRIBUTION.targets["linux-x64"].closureSha256 });
  }, 60_000);
});
