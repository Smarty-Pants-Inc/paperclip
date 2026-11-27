import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { captureRemoteWorkspaceArchive, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";

const roots: string[] = [];
const captured: Array<Awaited<ReturnType<typeof captureRemoteWorkspaceArchive>>> = [];

afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(captured.splice(0).map(archive => archive.cleanup()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it.each([
  { byteSize: 1024, timeoutMs: 61_000 },
  { byteSize: 64 * 1024 ** 3, timeoutMs: 30 * 60_000 },
])("bounds plugin archive transfers without a configured timeout for $byteSize bytes", async ({ byteSize, timeoutMs }) => {
  const transfer = vi.fn<NonNullable<CommandManagedRuntimeRunner["syncOut"]>>(async () => {
    throw new Error("Transfer stopped at the budget probe");
  });
  const remote: RemoteWorkspaceTarget = { kind: "remote", transport: "sandbox", providerKey: "plugin:fixture", remoteCwd: "/work",
    runner: {
      execute: async () => ({ stdout: JSON.stringify({ layout: "captured", manifestDigest: "a".repeat(64),
        sha256: "b".repeat(64), byteSize, entries: 1 }), stderr: "", exitCode: 0, timedOut: false,
        signal: null, pid: process.pid, startedAt: new Date().toISOString() }),
      syncIn: transfer, syncOut: transfer,
    } };
  await expect(captureRemoteWorkspaceArchive({ target: remote, remoteCwd: "/work", operationId: randomUUID() })).rejects.toThrow();
  expect(transfer).toHaveBeenCalledOnce();
  expect(transfer.mock.calls[0]?.[1]?.minimumTimeoutMs).toBe(timeoutMs);
});
