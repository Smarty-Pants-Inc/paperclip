import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEnvironmentExecuteResult } from "@paperclipai/plugin-sdk";

// Keep: cross-boundary probe for the server's native state staging fence
// (smarty-dev#20762). On a failed or abandoned state syncOut the server removes
// its staging directory and puts an empty 0600 file at that path, so a plugin
// worker that is still running cannot land state bytes there. This drives
// Boat's REAL syncFiles(outbound) with a fake sandbox transport whose archive
// holds a state file with a sentinel, and fences the staging path before the
// call and between Boat's own steps. Host-side fs calls pass through unchanged;
// the wrapper only lets a test run the fence at a chosen step.

type Hook = () => void | Promise<void>;
const hooks = new Map<string, Hook>();
const hits = new Map<string, number>();
const boatTemps: string[] = [];
async function fire(step: string): Promise<void> {
  hits.set(step, (hits.get(step) ?? 0) + 1);
  const hook = hooks.get(step);
  if (hook) { hooks.delete(step); await hook(); }
}
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const mkdtemp = (async (prefix: string, options?: unknown) => {
    const made = await (real.mkdtemp as any)(prefix, options) as string;
    if (path.basename(prefix) === "paperclip-boat-sync-") { boatTemps.push(made); await fire("boat-temp"); }
    if (path.basename(prefix) === ".paperclip-upload-boat-") await fire("after-stage-mkdtemp");
    return made;
  }) as typeof real.mkdtemp;
  const realpath = (async (target: any, options?: any) => { await fire("before-realpath"); return real.realpath(target, options); }) as typeof real.realpath;
  const rename = (async (from: any, to: any) => { await fire("before-rename"); await real.rename(from, to); await fire("after-rename"); }) as typeof real.rename;
  const wrapped = { ...real, mkdtemp, realpath, rename };
  return { ...wrapped, default: wrapped };
});
const { syncFiles } = await import("./file-sync.js");
type SyncParams = Parameters<typeof syncFiles>[0];

const SENTINEL = "BOAT-FENCE-PROBE-SENTINEL-6f1c2d";
const SOURCE = "/home/user/.paperclip/native/session-state.json";
let root: string, tmp: string, archive: Buffer, savedTmpdir: string | undefined;
let staging: string, targetPath: string;

// Same steps as the server's createNativeStateStaging / fenceNativeStateStaging
// at fork commit 185cffec (server/src/services/native-runtime/native-state-staging.ts).
function createStaging(): { staging: string; targetPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-native-state-"));
  const transfer = path.join(dir, "transfer");
  mkdirSync(transfer, { mode: 0o700 });
  return { staging: dir, targetPath: path.join(transfer, "state.json") };
}
function fence(dir: string): void {
  let last: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, "", { flag: "wx", mode: 0o600 }); return; }
    catch (error) { last = error; }
  }
  throw last;
}
function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  const visit = (entry: string) => {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) for (const name of readdirSync(entry)) visit(path.join(entry, name));
    else if (stat.isFile() && readFileSync(entry).includes(needle)) found.push(entry);
  };
  visit(dir);
  return found;
}
function boatTempEntries(): string[] { return readdirSync(tmp).filter(name => name.startsWith("paperclip-boat-sync-")); }

let fetchHook: Hook | undefined;
const runs: string[] = [];
const io = {
  async run(command: string): Promise<PluginEnvironmentExecuteResult> {
    runs.push(command);
    await fire("io-run-archive");
    return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
  },
  async request(route: string, init?: RequestInit): Promise<any> {
    if (route.endsWith("/files/download-url")) {
      await fire("io-request-download-url");
      return { url: `https://signed.invalid/file?path=${encodeURIComponent(JSON.parse(String(init?.body)).path)}` };
    }
    if (init?.method === "DELETE") return { message: "Deleted" };
    throw new Error(`unexpected fake Boat route ${route}`);
  },
};
async function fakeFetch(input: string | URL | Request): Promise<Response> {
  expect(new URL(String(input)).hostname).toBe("signed.invalid");
  const half = Math.floor(archive.length / 2);
  let step = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (step === 0) { step = 1; controller.enqueue(new Uint8Array(archive.subarray(0, half))); return; }
      if (step === 1) {
        step = 2;
        hits.set("mid-download", (hits.get("mid-download") ?? 0) + 1);
        if (fetchHook) { const hook = fetchHook; fetchHook = undefined; await hook(); }
        controller.enqueue(new Uint8Array(archive.subarray(half))); return;
      }
      controller.close();
    },
  }));
}
function params(): SyncParams {
  return {
    driverKey: "boat", companyId: "c", environmentId: "e", config: { apiKey: "boat_fake_only" },
    lease: { providerLeaseId: "bx_fence_probe", metadata: {} },
    operations: [{ operationId: "native-state-read", files: [{ sourcePath: SOURCE, targetPath, kind: "file" }] }],
  } as unknown as SyncParams;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "boat-fence-probe-"));
  tmp = path.join(root, "tmp"); mkdirSync(tmp);
  const sandbox = path.join(root, "sandbox-fixture"); mkdirSync(sandbox);
  writeFileSync(path.join(sandbox, path.basename(SOURCE)), JSON.stringify({ sessionId: "s-1", transcript: [SENTINEL, "x".repeat(256 * 1024)] }));
  execFileSync("tar", ["-c", "-f", path.join(root, "state.tar"), "-C", sandbox, path.basename(SOURCE)]);
  archive = readFileSync(path.join(root, "state.tar"));
  expect(archive.includes(SENTINEL)).toBe(true);
  rmSync(sandbox, { recursive: true, force: true });
  // Boat and the server share one temp directory; give both a private one.
  savedTmpdir = process.env.TMPDIR; process.env.TMPDIR = tmp;
  expect(os.tmpdir()).toBe(tmp);
  ({ staging, targetPath } = createStaging());
  hooks.clear(); hits.clear(); boatTemps.length = 0; runs.length = 0; fetchHook = undefined;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  rmSync(root, { recursive: true, force: true });
});

function expectFencedAndClean(): void {
  const stat = lstatSync(staging);
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBe(0);
  expect(stat.mode & 0o777).toBe(0o600);
  // No state bytes anywhere under the temp dir: the staging path, Boat's stage, Boat's own temp.
  expect(filesContaining(tmp, SENTINEL)).toEqual([]);
  expect(boatTemps).toHaveLength(1);
  expect(() => lstatSync(boatTemps[0])).toThrow(/ENOENT/);
  expect(boatTempEntries()).toEqual([]);
}

describe("Boat outbound sync onto the server's native state fence", () => {
  it("control: without a fence the state bytes land at the target (the sentinel search bites)", async () => {
    const result = await syncFiles(params(), true, io);
    expect(result.operations[0]).toMatchObject({ filesTransferred: 1 });
    expect(readFileSync(targetPath, "utf8")).toContain(SENTINEL);
    expect(filesContaining(tmp, SENTINEL)).toEqual([targetPath]);
    expect(runs).toHaveLength(1);
    for (const step of ["boat-temp", "io-run-archive", "io-request-download-url", "mid-download", "before-realpath", "after-stage-mkdtemp", "before-rename", "after-rename"]) expect(hits.get(step), step).toBe(1);
    expect(boatTempEntries()).toEqual([]);
  });

  it("(a) fenced before the call: rejects at Boat's parent walk, no bytes, Boat temp removed", async () => {
    fence(staging);
    await expect(syncFiles(params(), true, io)).rejects.toThrow("Boat target parent is not canonical");
    expect(hits.get("io-run-archive")).toBe(1);
    expect(hits.get("mid-download")).toBe(1);
    expect(hits.get("after-stage-mkdtemp")).toBeUndefined();
    expectFencedAndClean();
  });

  const midInstall = ["io-run-archive", "io-request-download-url", "before-realpath", "after-stage-mkdtemp", "before-rename"] as const;
  for (const step of midInstall) {
    it(`(b) rm'd and fenced mid-install at ${step}: rejects, no bytes, Boat temp removed`, async () => {
      hooks.set(step, () => fence(staging));
      await expect(syncFiles(params(), true, io)).rejects.toThrow();
      expect(hits.get(step)).toBe(1);
      expect(hits.get("after-rename")).toBeUndefined();
      expectFencedAndClean();
    });
  }

  it("(b) rm'd and fenced mid-download: rejects, no bytes, Boat temp removed", async () => {
    fetchHook = () => fence(staging);
    await expect(syncFiles(params(), true, io)).rejects.toThrow("Boat target parent is not canonical");
    expect(hits.get("mid-download")).toBe(1);
    expectFencedAndClean();
  });

  it("(b) before-rename puts the state bytes inside the staging path first; the fence's rm removes them", async () => {
    let seenBeforeFence: string[] = [];
    hooks.set("before-rename", () => { seenBeforeFence = filesContaining(staging, SENTINEL); fence(staging); });
    await expect(syncFiles(params(), true, io)).rejects.toThrow(/ENOENT|ENOTDIR/);
    expect(seenBeforeFence).toHaveLength(1);
    expect(seenBeforeFence[0]).toMatch(/\/transfer\/\.paperclip-upload-boat-[^/]+\/data\/session-state\.json$/);
    expectFencedAndClean();
  });

  it("(c) worker dies mid-transfer: Boat's own temp keeps transfer.tar with the state bytes; the fence does not reach it", async () => {
    // A dead worker never runs its finally. Model death as the call abandoned at a
    // step after the download, then read what is left, then let it finish.
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const atStep = new Promise<void>(resolve => { reached = resolve; });
    hooks.set("before-realpath", async () => { reached(); await parked; });
    const call = syncFiles(params(), true, io);
    await atStep;
    fence(staging); // the server's own timeout path runs while the worker is stuck or dead
    const left = boatTempEntries();
    expect(left).toHaveLength(1);
    const tarball = path.join(tmp, left[0], "transfer.tar");
    expect(lstatSync(tarball).mode & 0o777).toBe(0o600);
    expect(filesContaining(tmp, SENTINEL)).toEqual([tarball]);
    // The server sweep only matches paperclip-native-state-*; nothing matches Boat's prefix.
    expect(left[0].startsWith("paperclip-native-state-")).toBe(false);
    release();
    await expect(call).rejects.toThrow(/ENOTDIR|ENOENT/);
    expectFencedAndClean();
  });

  it("(c) real SIGKILL of a worker process mid-transfer leaves transfer.tar with the state bytes in Boat's temp", async () => {
    // A separate Node process runs the real file-sync.ts; its download stream
    // delivers every archive byte but never ends, then the test kills it.
    const child = path.join(root, "worker.mjs");
    writeFileSync(path.join(root, "archive.tar"), archive);
    writeFileSync(child, `
import { registerHooks } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx); } catch (e) { if (spec.endsWith(".js")) return next(spec.slice(0, -3) + ".ts", ctx); throw e; } } });
const [subject, archivePath, targetPath, source] = process.argv.slice(2);
const archive = readFileSync(archivePath);
globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archive)); } }));
const io = { run: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
  request: async (route, init) => route.endsWith("/download-url") ? { url: "https://signed.invalid/f" } : {} };
setInterval(() => {
  for (const name of readdirSync(os.tmpdir())) if (name.startsWith("paperclip-boat-sync-")) {
    try { if (statSync(path.join(os.tmpdir(), name, "transfer.tar")).size === archive.length) process.stdout.write("READY\\n"); } catch {}
  }
}, 20);
const { syncFiles } = await import(subject);
await syncFiles({ lease: { providerLeaseId: "bx_kill" }, operations: [{ operationId: "o", files: [{ sourcePath: source, targetPath, kind: "file" }] }] }, true, io);
`);
    const { spawn } = await import("node:child_process");
    const worker = spawn(process.execPath, [child, path.join(import.meta.dirname, "file-sync.ts"), path.join(root, "archive.tar"), targetPath, SOURCE],
      { env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    worker.stderr.on("data", chunk => { stderr += chunk; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker never reached the transfer: ${stderr}`)), 20_000);
      worker.stdout.on("data", chunk => { if (String(chunk).includes("READY")) { clearTimeout(timer); resolve(); } });
      worker.on("exit", code => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${stderr}`)); });
    });
    const exited = new Promise(resolve => worker.on("exit", (_code, signal) => resolve(signal)));
    worker.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");
    fence(staging); // the server's timeout path
    const left = boatTempEntries();
    expect(left).toHaveLength(1);
    const tarball = path.join(tmp, left[0], "transfer.tar");
    expect(readFileSync(tarball).equals(archive)).toBe(true);
    expect(filesContaining(tmp, SENTINEL)).toEqual([tarball]);
    expect(lstatSync(staging).isFile()).toBe(true);
  }, 30_000);
});
