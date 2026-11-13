import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { SandboxStoppedError } from "../sandbox-stopped-error.js";
import { stageProviderPackArchive } from "./provider-pack-archive.js";
import { uploadVerifiedProviderPack } from "./provider-pack-upload.js";
import type { ProviderPackLayers } from "./provider-pack-layers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const result = (stderr = "", exitCode: number | null = 0) => ({
  exitCode, signal: null, pid: null, startedAt: null, timedOut: false, stdout: "[]", stderr,
});
const rpc = (message: string) => new JsonRpcCallError({ code: -32000, message });
const refusal = (id = "bx_1", route = "commands") =>
  rpc(`Boat POST /sandboxes/${id}/${route} failed (409): Sandbox ${id} is stopped.`);

async function fixture(version: "v1" | "v2") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pack-staging-regression-"));
  roots.push(root);
  const bytes = Buffer.alloc(4096, 42);
  const metadata = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const sourcePath = path.join(root, "overlay.tar.zst");
  await fs.writeFile(sourcePath, bytes);
  const archive = version === "v1" ? { ...metadata, sourcePath } : {
    kind: "layers", sourceRoot: root, overlay: metadata, files: [],
  } satisfies ProviderPackLayers;
  const remote = {
    execute: vi.fn<CommandManagedRuntimeRunner["execute"]>().mockResolvedValue(result()),
    syncIn: vi.fn<NonNullable<CommandManagedRuntimeRunner["syncIn"]>>().mockResolvedValue({ operations: [] }),
  };
  return { root, sourcePath, archive, remote, bytes, targetPath: path.join(root, "target"), providerLeaseId: "bx_1" };
}

it.each(["v1", "v2"] as const)("accepts successful %s extraction despite unrelated stopped stderr", async version => {
  const input = await fixture(version);
  input.remote.execute.mockResolvedValue(result("a helper service is stopped; extraction succeeded"));
  await expect(stageProviderPackArchive({ ...input, runner: input.remote })).resolves.toBe(true);
});

it.each(["v1", "v2"] as const)("preserves a generic %s commands HTTP 404 instead of declaring sandbox stopped", async version => {
  const input = await fixture(version);
  const error = Object.assign(new Error("HTTP route not found"), { status: 404 });
  input.remote.execute.mockImplementation(async command => {
    if (command.timeoutMs === 120_000) throw error;
    return result();
  });
  await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toBe(error);
});

it("allows healthy layer reads to progress beyond one verification timeout interval", async () => {
  const input = await fixture("v2");
  const handle = await fs.open(input.sourcePath, "r");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  vi.spyOn(prototype, "createReadStream").mockImplementation(options => {
    return Readable.from((async function* () {
      for (let offset = 0; offset < input.bytes.length; offset += 512) {
        await delay(25, undefined, { signal: options?.signal });
        yield input.bytes.subarray(offset, offset + 512);
      }
    })()) as ReturnType<typeof handle.createReadStream>;
  });
  input.remote.syncIn.mockImplementation(async operations => {
    expect(await fs.readFile(operations[0]!.files[0]!.sourcePath)).toEqual(input.bytes);
    return { operations: [] };
  });
  await expect(stageProviderPackArchive({ ...input, runner: input.remote, verifyTimeoutMs: 100 })).resolves.toBe(true);
  expect(input.remote.syncIn).toHaveBeenCalledOnce();
});

it("still times out when layer reads stop making progress after the first chunk", async () => {
  const input = await fixture("v2");
  const handle = await fs.open(input.sourcePath, "r");
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  await handle.close();
  vi.spyOn(prototype, "createReadStream").mockImplementation(options => {
    return Readable.from((async function* () {
      yield input.bytes.subarray(0, 512);
      await delay(5_000, undefined, { signal: options?.signal });
      yield input.bytes.subarray(512);
    })()) as ReturnType<typeof handle.createReadStream>;
  });
  await expect(stageProviderPackArchive({ ...input, runner: input.remote, verifyTimeoutMs: 50 }))
    .rejects.toThrow("runner_remote_provider_archive_verify_timeout");
  expect(input.remote.syncIn).not.toHaveBeenCalled();
});

it.each(["v1", "v2"] as const)("preserves a %s refusal without an acquired allocation identity", async version => {
  const input = await fixture(version);
  const error = refusal();
  input.remote.syncIn.mockRejectedValue(error);
  await expect(stageProviderPackArchive({ ...input, providerLeaseId: undefined, runner: input.remote })).rejects.toBe(error);
});

it.each(["v1", "v2"] as const)("names only exact allocation %s command refusals and retains their cause", async version => {
  const input = await fixture(version);
  const error = refusal();
  input.remote.execute.mockImplementation(async command => {
    if (command.timeoutMs === 120_000) throw error;
    return result();
  });
  await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toMatchObject({
    message: "runner_remote_provider_pack_sandbox_stopped", cause: error,
  });
});

it.each(["v1", "v2"] as const)("names only exact allocation %s sync refusals and retains their cause", async version => {
  const input = await fixture(version);
  const error = refusal("bx_1", "files/upload-url");
  input.remote.syncIn.mockRejectedValue(error);
  await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toMatchObject({
    message: "runner_remote_provider_pack_sandbox_stopped", cause: error,
  });
  expect(input.remote.syncIn).toHaveBeenCalledOnce();
});

it.each(["v1", "v2"] as const)("does not infer %s stopped state from untyped or wrong-allocation errors", async version => {
  for (const error of [
    refusal("bx_other"),
    new Error(refusal().message),
    Object.assign(new Error("Boat 409 Sandbox is stopped"), { status: 409 }),
    rpc("command output: " + refusal().message),
    rpc(refusal().message.replace("(409)", "(404)")),
  ]) {
    const input = await fixture(version);
    input.remote.syncIn.mockRejectedValue(error);
    await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toBe(error);
  }
});

it.each(["v1", "v2"] as const)("preserves wrapped typed %s stopped refusals unchanged at transfer and extraction", async version => {
  for (const stage of ["transfer", "extract"]) {
    const input = await fixture(version);
    const error = new Error("transport wrapper", { cause: new SandboxStoppedError("sync_rejected", refusal()) });
    if (stage === "transfer") input.remote.syncIn.mockRejectedValue(error);
    else input.remote.execute.mockImplementation(async command => {
      if (command.timeoutMs === 120_000) throw error;
      return result();
    });
    await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toBe(error);
  }
});

it.each(["v1", "v2"] as const)("carries the acquired allocation into the full %s archive upload path", async version => {
  const input = await fixture(version);
  const pack = path.join(input.root, "pack");
  const digest = `sha256:${"a".repeat(64)}`;
  const metadata = { bytes: input.bytes.length, sha256: createHash("sha256").update(input.bytes).digest("hex") };
  if (version === "v2") {
    await fs.mkdir(`${pack}.archives`);
    await fs.copyFile(input.sourcePath, `${pack}.archives/overlay.tar.zst`);
  } else await fs.copyFile(input.sourcePath, `${pack}.tar.zst`);
  await fs.writeFile(`${pack}.archive.json`, JSON.stringify({
    schema: `paperclip-runner/provider-pack-archive/${version}`, encoding: "tar+zstd", providerPackDigest: digest,
    ...(version === "v2" ? { overlay: metadata, files: [] } : metadata),
  }));
  const error = refusal();
  input.remote.execute.mockImplementation(async command => {
    if (command.timeoutMs === 120_000) throw error;
    return result();
  });
  const verifyUploaded = vi.fn();
  await expect(uploadVerifiedProviderPack({
    root: pack, sourceDigest: digest, expectedDigest: digest, runner: input.remote,
    providerLeaseId: input.providerLeaseId, cwd: input.root, targetPath: input.targetPath, reuseRoots: [],
    verifyDirectory: () => { throw Error("unexpected directory fallback"); },
    stageDirectory: async () => { throw Error("unexpected directory fallback"); }, verifyUploaded,
  })).rejects.toMatchObject({ message: "runner_remote_provider_pack_sandbox_stopped", cause: error });
  expect(verifyUploaded).not.toHaveBeenCalled();
});

it.each(["v1", "v2"] as const)("keeps %s failed extraction stderr as an extraction failure, not a provider refusal", async version => {
  const input = await fixture(version);
  input.remote.execute.mockImplementation(async command => result("helper is stopped", command.timeoutMs === 120_000 ? 1 : 0));
  await expect(stageProviderPackArchive({ ...input, runner: input.remote })).rejects.toThrow("runner_remote_provider_archive_extract_failed");
});
