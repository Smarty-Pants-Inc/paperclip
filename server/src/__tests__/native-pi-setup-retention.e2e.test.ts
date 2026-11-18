import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { testNativeRunnerAuthentication } from "../services/native-runtime/setup-readiness.js";
import { respondToNativePiHello } from "./helpers/native-pi-hello-model.js";

const capture = vi.hoisted(() => ({ files: [] as Array<{ relative: string; bytes: Buffer }>, roots: [] as string[] }));
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
vi.mock("../vendor/paperclip-runner/index.js", async original => {
  const actual = await original<typeof import("../vendor/paperclip-runner/index.js")>();
  return { ...actual, probeNativeRunnerEnvironment: (options: Parameters<typeof actual.probeNativeRunnerEnvironment>[0]) => actual.probeNativeRunnerEnvironment({
    ...options, onCleanupConfirmed: async () => {
      capture.roots.push(options.runtimeDirectory);
      for (const filename of await filesUnder(options.runtimeDirectory)) {
        if (/\.(?:jsonl|ndjson)$/.test(filename)) capture.files.push({ relative: filename.slice(options.runtimeDirectory.length + 1), bytes: await readFile(filename) });
      }
      await options.onCleanupConfirmed?.();
    },
  }) };
});

// Keep: sole-copy data safety (#20417). Actual native Pi hello -> raw JSONL ->
// production setup cleanup. Only the model is deterministic loopback; no account.
it.skipIf(process.env.PAPERCLIP_PI_SETUP_E2E !== "1")("retains byte-identical actual Pi setup history after cleanup", async () => {
  if (!process.env.PAPERCLIP_RUNNER_BINARY || !process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH) throw new Error("Qualified runner and Pi pack required");
  const root = await mkdtemp(join(tmpdir(), "pi-setup-retention-"));
  const state = join(root, "state"), agent = join(root, "agent");
  await mkdir(agent);
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", state);
  capture.files.length = 0; capture.roots.length = 0;
  let requests = 0;
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => { requests++; if (!respondToNativePiHello(JSON.parse(body), res, "chat")) res.writeHead(500).end("Expected hello"); });
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
  try {
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("No model listener");
    const result = await testNativeRunnerAuthentication({ companyId: "trace-retention-proof", adapterType: "paperclip_runner", config: {
      provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off", env: {
        PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TMPDIR: process.env.TMPDIR!,
        PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none",
      },
    } }, "pi_rpc", "paperclip/faux");
    expect(result.status, JSON.stringify(result)).toBe("pass");
    expect(requests).toBeGreaterThan(0);
    const before = join(root, "before"); await mkdir(before, { mode: 0o700 });
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const retained = await Promise.all((await filesUnder(state)).filter(file => file.includes("/conversation-evidence/")).map(async path => ({ path, sha256: hash(await readFile(path)) })));
    const originals = await Promise.all(capture.files.map(async (file, index) => {
      const path = join(before, `${index}.jsonl`); await writeFile(path, file.bytes, { mode: 0o600 });
      return { path, relative: file.relative, bytes: file.bytes.length, sha256: hash(file.bytes) };
    }));
    const receipt = { result, requests, roots: capture.roots, originals, retained };
    await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log("Pi setup raw byte retention", JSON.stringify(receipt));
    expect(originals.some(file => file.relative.startsWith("pi/") && file.bytes > 0)).toBe(true);
    for (const original of originals) expect(retained.some(file => file.sha256 === original.sha256), original.relative).toBe(true);
    for (const source of capture.roots) expect(await filesUnder(source)).toEqual([]);
  } finally {
    peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()));
    vi.unstubAllEnvs();
    // Deliberately retain the complete proof root, including RED input bytes.
  }
}, 120_000);
