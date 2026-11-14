import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSyncFileMapping, PluginSyncOperation } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
// Keep: data safety and the untrusted sandbox/host boundary. The mock implements
// documented JSON/signed-byte endpoints, but executes actual tar/mv/chmod and
// streams real files. No Boat network, credential or sandbox is used.
const exec = promisify(execFile);
let root: string, remote: string, host: string;
let commands: string[], transfers: string[], remoteTemps: Set<string>;
let fault: "upload" | "download" | "corrupt" | "command" | "cleanup" | undefined;
let partialUploadBytes: number, downloadOverride: Buffer | undefined;
let cleanupStatus: number;
const cfg = { apiKey: "boat_mock_only" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const localRemote = (value: string) => value.replace(/\/tmp\/paperclip-boat-sync-/g, `${remote}/paperclip-boat-sync-`);
function params(operations: PluginSyncOperation[]) {
  return { driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, lease: { providerLeaseId: "bx_test", metadata: { remoteCwd: remote } }, operations };
}
function operation(file: PluginSyncFileMapping, operationId = "opaque/not/a/path") { return { operationId, files: [file] }; }
async function sync(file: PluginSyncFileMapping, outbound = false) {
  return (outbound ? plugin.definition.onEnvironmentSyncOut! : plugin.definition.onEnvironmentSyncIn!)(params([operation(file)]));
}
async function mockFetch(input: string | URL | Request, init: RequestInit = {}) {
  const url = new URL(String(input));
  if (url.hostname === "signed.invalid") {
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(init.redirect).toBe("error");
    const file = localRemote(url.searchParams.get("path")!);
    transfers.push(init.method!);
    if (init.method === "PUT") {
      const staging = `${file}.uploading`;
      try {
        let chunks = 0;
        const fail = new Transform({ transform(chunk, _encoding, callback) {
          if (fault === "upload" && chunks++ > 0) callback(new Error("injected mid-upload"));
          else { partialUploadBytes += chunk.length; callback(null, chunk); }
        } });
        await pipeline(init.body as unknown as Readable, fail, createWriteStream(staging, { mode: 0o600 }));
        await fs.rename(staging, file);
        if (fault === "corrupt") await fs.writeFile(file, "not a tar");
      } finally { await fs.rm(staging, { force: true }); }
      return new Response(null, { status: 200 });
    }
    if (downloadOverride) return new Response(new Uint8Array(downloadOverride));
    if (fault === "download") {
      let count = 0;
      return new Response(new ReadableStream({ pull(controller) { if (count++ === 0) controller.enqueue(new Uint8Array(1024)); else controller.error(new Error("injected mid-download")); } }));
    }
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream);
  }
  expect(url.origin).toBe("https://boat.dev");
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer boat_mock_only");
  if (url.pathname.endsWith("/upload-url") || url.pathname.endsWith("/download-url")) {
    const request = JSON.parse(String(init.body));
    expect(request.path).toMatch(/^\/tmp\/paperclip-boat-sync-[\w-]+\.tar$/);
    expect(request.path).not.toContain("opaque");
    remoteTemps.add(localRemote(request.path));
    return json({ url: `https://signed.invalid/file?path=${encodeURIComponent(request.path)}`, method: url.pathname.endsWith("/upload-url") ? "PUT" : "GET", path: request.path });
  }
  if (url.pathname.endsWith("/commands")) {
    const body = JSON.parse(String(init.body)); commands.push(body.command);
    if (fault === "command") return json({ exitCode: 9, timedOut: false, stdout: "", stderr: "injected" });
    try {
      const result = await exec("sh", ["-c", localRemote(body.command)], { cwd: body.cwd ?? remote, timeout: 10_000, maxBuffer: 1024 * 1024 });
      return json({ exitCode: 0, timedOut: false, ...result });
    } catch (error: any) { return json({ exitCode: error.code ?? 1, timedOut: false, stdout: error.stdout, stderr: error.stderr }); }
  }
  if (url.pathname.endsWith("/files") && init.method === "DELETE") {
    const file = localRemote(url.searchParams.get("path")!);
    const missing = { message: `No such file or directory: ${url.searchParams.get("path")}` };
    if (fault === "cleanup") return json(cleanupStatus === 503 ? { message: "injected cleanup failure" } : missing, cleanupStatus);
    try { await fs.unlink(file); return json({ message: "Deleted" }); }
    catch (error: any) { if (error.code === "ENOENT") return json(missing, 400); throw error; }
  }
  throw new Error(`Unexpected mock route ${url.pathname}`);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "boat-sync-test-"));
  remote = path.join(root, "sandbox"); host = path.join(root, "host");
  await fs.mkdir(remote); await fs.mkdir(host);
  commands = []; transfers = []; remoteTemps = new Set(); fault = undefined; partialUploadBytes = 0; downloadOverride = undefined; cleanupStatus = 503;
  vi.stubGlobal("fetch", vi.fn(mockFetch));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const source = path.join(host, "source ' ; $(not-a-command)");
  await fs.mkdir(source, { mode: 0o700 }); await fs.mkdir(path.join(source, "empty"), { mode: 0o750 });
  await fs.writeFile(path.join(source, "small"), "secret bytes", { mode: 0o640 });
  await fs.writeFile(path.join(source, "large"), Buffer.alloc(6 * 1024 * 1024 + 17, 73), { mode: 0o600 });
  await fs.writeFile(path.join(source, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o751 });
  await fs.symlink("small", path.join(source, "link"));
  return source;
}
async function assertFixture(target: string) {
  expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  expect(await fs.readFile(path.join(target, "small"), "utf8")).toBe("secret bytes");
  expect((await fs.stat(path.join(target, "large"))).size).toBe(6 * 1024 * 1024 + 17);
  expect(createHash("sha256").update(await fs.readFile(path.join(target, "large"))).digest("hex")).toBe(createHash("sha256").update(Buffer.alloc(6 * 1024 * 1024 + 17, 73)).digest("hex"));
  expect((await fs.lstat(path.join(target, "link"))).isSymbolicLink()).toBe(true);
  expect(await fs.readlink(path.join(target, "link"))).toBe("small");
  expect(await fs.readdir(path.join(target, "empty"))).toEqual([]);
  for (const [name, mode] of [["small", 0o640], ["large", 0o600], ["run.sh", 0o751], ["empty", 0o750]] as const) expect((await fs.stat(path.join(target, name))).mode & 0o777).toBe(mode);
}
async function clean() {
  for (const temp of remoteTemps) await expect(fs.lstat(temp)).rejects.toMatchObject({ code: "ENOENT" });
  for (const directory of [host, remote]) expect((await fs.readdir(directory)).filter(name => name.startsWith(".paperclip-upload") || name.startsWith("paperclip-boat-sync"))).toEqual([]);
}
describe("Boat native hybrid file sync", () => {
  describe("size-aware signed transfer bounds", () => {
    // Keep: the recorded 39.7 MB runnerd upload exceeds 180 s at production's
    // measured 0.17 MB/s. Exercise real archives/streams without waiting minutes.
    it.each([
      { name: "40 MB upload", bytes: 40_000_000, expected: 306_000 },
      { name: "tiny upload", bytes: 3, expected: 180_000 },
      { name: "200 MB upload", bytes: 200_000_000, expected: 840_000 },
      { name: "larger caller minimum", bytes: 40_000_000, minimum: 600_000, expected: 600_000 },
      { name: "caller minimum above URL-safe cap", bytes: 3, minimum: 900_000, expected: 840_000 },
      { name: "40 MB download with unknown archive size", bytes: 40_000_000, outbound: true, expected: 180_000 },
      { name: "download caller minimum", bytes: 3, outbound: true, minimum: 300_000, expected: 300_000 },
      { name: "40 MB upload retry", bytes: 40_000_000, retry: true, expected: 306_000 },
    ])("$name", async ({ bytes, minimum, outbound = false, retry = false, expected }) => {
      const source = path.join(outbound ? remote : host, "sized-source"), target = path.join(outbound ? host : remote, "sized-target");
      const sourceFile = await fs.open(source, "w");
      try { await sourceFile.truncate(bytes); } finally { await sourceFile.close(); }
      const realTimeout = AbortSignal.timeout.bind(AbortSignal), bounds = new Map<AbortSignal, number>();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const signal = realTimeout(ms); bounds.set(signal, ms); return signal;
      });
      const attempts: number[] = [], requests: { bound: number; body: { ttlSeconds: number } }[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        const url = new URL(String(input));
        expect(init.method).not.toBe("HEAD");
        if (url.pathname.endsWith(outbound ? "/download-url" : "/upload-url")) {
          requests.push({ bound: bounds.get(init.signal)!, body: JSON.parse(String(init.body)) });
        }
        if (url.hostname === "signed.invalid") {
          attempts.push(bounds.get(init.signal)!);
          if (retry && attempts.length === 1) return new Response(null, { status: 503 });
        }
        return mockFetch(input, init);
      }));
      const result = await (outbound ? plugin.definition.onEnvironmentSyncOut! : plugin.definition.onEnvironmentSyncIn!)({
        ...params([operation({ sourcePath: source, targetPath: target, kind: "file" })]), minimumTimeoutMs: minimum,
      });
      expect((await fs.stat(target)).size).toBe(bytes);
      expect(result.operations[0].bytesTransferred).toBeGreaterThan(bytes);
      expect(attempts).toEqual(retry ? [expected, expected] : [expected]);
      expect(requests).toHaveLength(attempts.length);
      for (const request of requests) {
        expect(request.bound).toBe(Math.max(180_000, minimum ?? 0)); // URL request is not the signed byte transfer.
        expect(request.body.ttlSeconds * 1000).toBeGreaterThanOrEqual(expected + 60_000);
      }
      expect(bounds.get(vi.mocked(fetch).mock.calls.at(-1)![1].signal)).toBe(Math.max(60_000, minimum ?? 0));
      expect(commands).toHaveLength(1); // No extra command to discover download size.
      await clean();
    });
  });
  describe.each([false, true])("freeze-tolerant signed transfers (outbound=%s)", outbound => {
    const direction = outbound ? "download" : "upload";
    async function transfer(minimumTimeoutMs?: number) {
      const source = path.join(outbound ? remote : host, "source"), target = path.join(outbound ? host : remote, "target");
      await fs.writeFile(source, "NEW"); await fs.writeFile(target, "OLD");
      const result = await (outbound ? plugin.definition.onEnvironmentSyncOut! : plugin.definition.onEnvironmentSyncIn!)({
        ...params([operation({ sourcePath: source, targetPath: target, kind: "file" })]), minimumTimeoutMs,
      });
      expect(await fs.readFile(target, "utf8")).toBe("NEW");
      expect(result.operations[0].filesTransferred).toBe(1);
      await clean();
    }
    function urlCalls() {
      return vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith(`/${direction}-url`));
    }
    it.each([undefined, 240_000])("survives a 70 s sending-host stall on the first attempt (minimum=%s)", async minimum => {
      // Keep: the recorded ~78 s snapshot freeze cannot be reached cheaply in a live flow.
      // Inject only the timeout clock: real tar, streams, install and bytes still run.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("synthetic", "TimeoutError")), ms);
        return controller.signal;
      });
      let attempts = 0;
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (new URL(String(input)).hostname === "signed.invalid") {
          attempts++;
          await vi.advanceTimersByTimeAsync(70_000);
          if (init.signal.aborted) throw init.signal.reason;
        }
        return mockFetch(input, init);
      }));
      try {
        await transfer(minimum);
        expect(attempts).toBe(1); expect(urlCalls()).toHaveLength(1);
        const bounds = vi.mocked(AbortSignal.timeout).mock.calls.map(([ms]) => ms);
        expect(bounds.filter(ms => ms === (minimum ?? 180_000))).toHaveLength(minimum ? 3 : 2);
        if (!minimum) expect(bounds.at(-1)).toBe(60_000); // Cleanup keeps its old bound.
      } finally { vi.useRealTimers(); }
    });
    it.each([503, 429, "network"] as const)("retries a first signed %s with a fresh URL", async failure => {
      let attempts = 0;
      const urls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/${direction}-url`)) {
          const response = await mockFetch(input, init), signed = await response.json();
          signed.url += `&attempt=${urls.length}`; urls.push(signed.url);
          return json(signed);
        }
        if (url.hostname === "signed.invalid" && attempts++ === 0) {
          if (failure === "network") throw new TypeError("synthetic", { cause: { code: "ECONNRESET" } });
          return new Response(null, { status: failure });
        }
        return mockFetch(input, init);
      }));
      await transfer();
      expect(attempts).toBe(2); expect(urlCalls()).toHaveLength(2);
      expect(new Set(urls).size).toBe(2);
    });
    it.each([503, 429, "network"] as const)("retries a first URL-request %s", async failure => {
      let attempts = 0;
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (new URL(String(input)).pathname.endsWith(`/${direction}-url`) && attempts++ === 0) {
          if (failure === "network") throw new TypeError("synthetic");
          return new Response(null, { status: failure });
        }
        return mockFetch(input, init);
      }));
      await transfer(); expect(urlCalls()).toHaveLength(2);
    });
    it("reports the last cause when the one retry also fails", async () => {
      let attempts = 0;
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (new URL(String(input)).hostname === "signed.invalid") {
          if (attempts++ === 0) return new Response(null, { status: 503 });
          throw new TypeError("synthetic", { cause: { code: "ECONNRESET" } });
        }
        return mockFetch(input, init);
      }));
      await expect(transfer()).rejects.toThrow(`Boat signed ${direction} failed: TypeError (ECONNRESET) (after 1 retry)`);
      expect(attempts).toBe(2); expect(urlCalls()).toHaveLength(2); await clean();
    });
    it.each(["invalid", "http", "userinfo"])("does not retry %s signed URLs", async invalid => {
      vi.stubGlobal("fetch", vi.fn(async (input, init) => new URL(String(input)).pathname.endsWith(`/${direction}-url`)
        ? json({ url: invalid === "invalid" ? "not a URL" : invalid === "http" ? "http://signed.invalid/file" : "https://user:secret@signed.invalid/file" })
        : mockFetch(input, init)));
      await expect(transfer()).rejects.toThrow(/Boat file URL/);
      expect(urlCalls()).toHaveLength(1); expect(transfers).toEqual([]); await clean();
    });
    if (outbound) it("removes a partial download before retrying the wx stream", async () => {
      let attempts = 0;
      let partial: string | undefined;
      const before = new Set(await fs.readdir(os.tmpdir()));
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/download-url") && attempts === 1) {
          expect(partial).toBeDefined();
          await expect(fs.lstat(partial!)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (url.hostname === "signed.invalid" && attempts++ === 0) {
          let sent = false;
          return new Response(new ReadableStream({ async pull(controller) {
            if (!sent) { sent = true; controller.enqueue(new Uint8Array(1024)); return; }
            // Yield through real fs I/O until the first chunk reaches the private archive.
            for (let check = 0; check < 100; check++) {
              const directory = (await fs.readdir(os.tmpdir())).find(name => name.startsWith("paperclip-boat-sync-") && !before.has(name));
              if (directory) {
                partial = path.join(os.tmpdir(), directory, "transfer.tar");
                if ((await fs.stat(partial).catch(() => undefined))?.size === 1024) break;
              }
            }
            expect(partial).toBeDefined();
            expect((await fs.stat(partial!)).size).toBe(1024);
            controller.error(new TypeError("synthetic", { cause: { code: "ECONNRESET" } }));
          } }));
        }
        return mockFetch(input, init);
      }));
      await transfer(); expect(urlCalls()).toHaveLength(2); await clean();
    });
  });
  describe.each([false, true])("safe transfer failures (outbound=%s)", outbound => {
    const direction = outbound ? "download" : "upload";
    async function failedSync() {
      const source = path.join(outbound ? remote : host, "source"), target = path.join(outbound ? host : remote, "target");
      await fs.writeFile(source, "NEW"); await fs.writeFile(target, "OLD");
      const error = await sync({ sourcePath: source, targetPath: target, kind: "file" }, outbound).then(
        () => { throw new Error("Expected sync failure"); },
        error => error as Error,
      );
      expect(error).toBeInstanceOf(Error);
      for (const text of [String(error), error.message, error.stack, JSON.stringify(Object.getOwnPropertyDescriptors(error))]) {
        expect(text).not.toMatch(/X-Amz|https:\/\/|\?/);
      }
      expect(Object.hasOwn(error, "cause")).toBe(false);
      expect(await fs.readFile(target, "utf8")).toBe("OLD");
      await clean();
      return error.message;
    }
    it.each(["TimeoutError", "AbortError", "TypeError", "unsafe fields"])("retains a URL-free signed %s cause", async name => {
      const secret = "https://signed.invalid/file?X-Amz-Signature=synthetic";
      const error = name === "TypeError" ? new TypeError(secret, { cause: { code: "ECONNRESET", message: secret } })
        : name === "unsafe fields" ? Object.assign(new Error(secret), { name: secret, cause: { code: secret } })
        : new DOMException(secret, name);
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (new URL(String(input)).hostname === "signed.invalid") throw error;
        return mockFetch(input, init);
      }));
      const detail = name === "TypeError" ? "TypeError (ECONNRESET)" : name === "unsafe fields" ? "Error" : "timeout after 180000 ms";
      const retry = name !== "unsafe fields";
      expect(await failedSync()).toBe(`Boat signed ${direction} failed: ${detail}${retry ? " (after 1 retry)" : ""}`);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).hostname === "signed.invalid")).toHaveLength(retry ? 2 : 1);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith(`/${direction}-url`))).toHaveLength(retry ? 2 : 1);
    });
    it("retains signed HTTP status without the URL, response body or statusText", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input, init) => new URL(String(input)).hostname === "signed.invalid"
        ? new Response("https://signed.invalid/?X-Amz-Signature=synthetic", { status: 403, statusText: "X-Amz-secret" })
        : mockFetch(input, init)));
      expect(await failedSync()).toBe(`Boat signed ${direction} failed: HTTP 403`);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).hostname === "signed.invalid")).toHaveLength(1);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith(`/${direction}-url`))).toHaveLength(1);
    });
    it.each(["timeout", "HTTP 403"])("retains %s from the URL request step", async failure => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      if (failure === "timeout") vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(1));
      vi.stubGlobal("fetch", vi.fn(async (input, init) => {
        if (new URL(String(input)).pathname.endsWith(`/${direction}-url`)) {
          if (failure === "timeout") {
            await new Promise<void>(resolve => {
              if (init.signal.aborted) resolve();
              else init.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            throw init.signal.reason;
          }
          return new Response("https://signed.invalid/?X-Amz-Signature=synthetic", { status: 403 });
        }
        return mockFetch(input, init);
      }));
      expect(await failedSync()).toBe(`Boat ${direction}-url request failed: ${failure === "timeout" ? "timeout after 180000 ms (after 1 retry)" : failure}`);
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith(`/${direction}-url`))).toHaveLength(failure === "timeout" ? 2 : 1);
    });
  });
  it("round-trips links, entry modes, empty directory and >5 MiB via one command per mapping", async () => {
    const source = await fixture(), target = path.join(remote, "workspace ' quoted");
    const incoming = await sync({ sourcePath: source, targetPath: target, kind: "directory" });
    await assertFixture(target);
    const output = path.join(host, "restored"), outgoing = await sync({ sourcePath: target, targetPath: output, kind: "directory" }, true);
    await assertFixture(output);
    expect(incoming.operations[0]).toMatchObject({ operationId: "opaque/not/a/path", filesTransferred: 1 });
    expect(outgoing.operations[0].bytesTransferred).toBeGreaterThan(5 * 1024 * 1024);
    expect(commands).toHaveLength(2); expect(transfers).toEqual(["PUT", "GET"]); await clean();
  });
  it("dereferences only when requested on either archive creation side", async () => {
    const source = await fixture(), target = path.join(remote, "tree"), output = path.join(host, "restored");
    await sync({ sourcePath: source, targetPath: target, kind: "directory", followSymlinks: true });
    expect((await fs.lstat(path.join(target, "link"))).isFile()).toBe(true);
    await fs.unlink(path.join(target, "link")); await fs.symlink("small", path.join(target, "link"));
    await sync({ sourcePath: target, targetPath: output, kind: "directory", followSymlinks: true }, true);
    expect((await fs.lstat(path.join(output, "link"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(output, "link"), "utf8")).toBe("secret bytes"); await clean();
  });
  it("replaces single files and honors requested 0600 mode in both directions", async () => {
    const source = path.join(host, "source"), target = path.join(remote, "renamed"), output = path.join(host, "restored");
    await fs.writeFile(source, "new secret", { mode: 0o644 }); await fs.writeFile(target, "old"); await fs.writeFile(output, "old");
    await sync({ sourcePath: source, targetPath: target, kind: "file", mode: 0o600 });
    await sync({ sourcePath: target, targetPath: output, kind: "file", mode: 0o600 }, true);
    for (const file of [target, output]) { expect(await fs.readFile(file, "utf8")).toBe("new secret"); expect((await fs.stat(file)).mode & 0o777).toBe(0o600); }
    await clean();
  });
  it("applies requested modes to directory files without chmod following symlinks", async () => {
    const source = await fixture(), target = path.join(remote, "tree"), output = path.join(host, "restored");
    await sync({ sourcePath: source, targetPath: target, kind: "directory", mode: 0o700 });
    await sync({ sourcePath: target, targetPath: output, kind: "directory", mode: 0o700 }, true);
    for (const dir of [target, output]) { expect((await fs.stat(path.join(dir, "small"))).mode & 0o777).toBe(0o700); expect((await fs.lstat(path.join(dir, "link"))).isSymbolicLink()).toBe(true); }
    await clean();
  });
  it("transfers entirely empty directories and removes stale entries", async () => {
    const source = path.join(host, "empty"), target = path.join(remote, "tree"), output = path.join(host, "out");
    await fs.mkdir(source); await fs.mkdir(target); await fs.writeFile(path.join(target, "stale"), "old");
    await sync({ sourcePath: source, targetPath: target, kind: "directory" });
    await sync({ sourcePath: target, targetPath: output, kind: "directory" }, true);
    expect(await fs.readdir(target)).toEqual([]); expect(await fs.readdir(output)).toEqual([]); await clean();
  });
  it.each(["upload", "corrupt", "command"] as const)("%s failure leaves old sandbox file untouched and no staging debris", async failure => {
    const source = path.join(host, "source"), target = path.join(remote, "target");
    await fs.writeFile(source, Buffer.alloc(6 * 1024 * 1024, 72)); await fs.writeFile(target, "OLD"); fault = failure;
    await expect(sync({ sourcePath: source, targetPath: target, kind: "file" })).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("OLD");
    if (failure === "upload") expect(partialUploadBytes).toBeGreaterThan(0);
    await clean();
  });
  it.each(["file", "directory"] as const)("interrupted download preserves old host %s and cleans remote tar", async kind => {
    const source = path.join(remote, "source"), target = path.join(host, "target");
    if (kind === "file") { await fs.writeFile(source, "new"); await fs.writeFile(target, "OLD"); }
    else { await fs.mkdir(source); await fs.writeFile(path.join(source, "new"), "new"); await fs.mkdir(target); await fs.writeFile(path.join(target, "old"), "OLD"); }
    fault = "download"; await expect(sync({ sourcePath: source, targetPath: target, kind }, true)).rejects.toThrow("download failed");
    expect(await fs.readFile(kind === "file" ? target : path.join(target, "old"), "utf8")).toBe("OLD"); await clean();
  });
  it("directory transfer failure preserves old sandbox directory", async () => {
    const source = await fixture(), target = path.join(remote, "target"); await fs.mkdir(target); await fs.writeFile(path.join(target, "old"), "OLD");
    fault = "upload"; await expect(sync({ sourcePath: source, targetPath: target, kind: "directory" })).rejects.toThrow();
    expect(await fs.readdir(target)).toEqual(["old"]); await clean();
  });
  it("uses glob excludes, with literal outbound excludes in preserveSourceEntries mode", async () => {
    const source = path.join(host, "src"), target = path.join(remote, "target"), output = path.join(host, "out"); await fs.mkdir(source);
    for (const name of ["keep", "a.tmp", "._metadata", "literal*", "literal-other"]) await fs.writeFile(path.join(source, name), name);
    await sync({ sourcePath: source, targetPath: target, kind: "directory", exclude: ["*.tmp"] });
    expect((await fs.readdir(target)).sort()).toEqual(["keep", "literal*", "literal-other"].sort());
    await fs.writeFile(path.join(target, "._metadata"), "metadata");
    await fs.mkdir(path.join(target, "nested")); await fs.writeFile(path.join(target, "nested/literal*"), "keep nested literal");
    await sync({ sourcePath: target, targetPath: output, kind: "directory", preserveSourceEntries: true, exclude: ["literal*"] }, true);
    expect((await fs.readdir(output)).sort()).toEqual(["._metadata", "keep", "literal-other", "nested"].sort());
    expect(await fs.readFile(path.join(output, "nested/literal*"), "utf8")).toBe("keep nested literal"); await clean();
  });
  it("rejects outbound escaping symlinks before publishing or touching their referent", async () => {
    const source = path.join(remote, "tree"), target = path.join(host, "out"), outside = path.join(host, "outside");
    await fs.mkdir(source); await fs.mkdir(target); await fs.writeFile(outside, "SAFE"); await fs.writeFile(path.join(target, "old"), "OLD"); await fs.symlink(outside, path.join(source, "evil"));
    await expect(sync({ sourcePath: source, targetPath: target, kind: "directory" }, true)).rejects.toThrow("Unsafe Boat archive symlink");
    expect(await fs.readFile(outside, "utf8")).toBe("SAFE"); expect(await fs.readdir(target)).toEqual(["old"]); await clean();
  });
  it("replaces a target symlink instead of following it", async () => {
    const source = path.join(remote, "source"), target = path.join(host, "target"), outside = path.join(host, "outside");
    await fs.writeFile(source, "NEW"); await fs.writeFile(outside, "SAFE"); await fs.symlink(outside, target);
    await sync({ sourcePath: source, targetPath: target, kind: "file" }, true);
    expect(await fs.readFile(outside, "utf8")).toBe("SAFE"); expect((await fs.lstat(target)).isFile()).toBe(true); await clean();
  });
  it("rejects symlink parents before mkdir can create anything outside the target root", async () => {
    const source = path.join(remote, "source"), outside = path.join(root, "outside"), link = path.join(host, "link");
    await fs.writeFile(source, "NEW"); await fs.mkdir(outside); await fs.symlink(outside, link);
    await expect(sync({ sourcePath: source, targetPath: path.join(link, "new/file"), kind: "file" }, true)).rejects.toThrow("not canonical");
    expect(await fs.readdir(outside)).toEqual([]); await clean();
  });
  it("applies operations in order and runs opaque post-upload commands verbatim with cwd", async () => {
    const one = path.join(host, "one"), two = path.join(host, "two"), target = path.join(remote, "target"), workspace = path.join(remote, "workspace");
    await fs.writeFile(one, "1"); await fs.writeFile(two, "2"); await fs.mkdir(workspace);
    const command = "printf done > marker";
    const result = await plugin.definition.onEnvironmentSyncIn!(params([
      operation({ sourcePath: one, targetPath: target, kind: "file" }, "first"),
      operation({ sourcePath: two, targetPath: target, kind: "file" }, "second"),
      { operationId: "post", files: [{ sourcePath: one, targetPath: path.join(workspace, "file"), kind: "file" }], postUploadCommands: [{ command }] },
    ]));
    expect(await fs.readFile(target, "utf8")).toBe("2"); expect(await fs.readFile(path.join(remote, "marker"), "utf8")).toBe("done");
    expect(commands.at(-1)).toBe(command); expect(result.operations.map(op => op.operationId)).toEqual(["first", "second", "post"]); await clean();
  });
  it("rejects traversal and escaped post-upload cwd before any Boat call", async () => {
    await expect(sync({ sourcePath: "/host/../escape", targetPath: "/tmp/target", kind: "file" })).rejects.toThrow("confined");
    await expect(plugin.definition.onEnvironmentSyncIn!(params([{ operationId: "op", files: [{ sourcePath: "/host/file", targetPath: "/tmp/target", kind: "file" }], postUploadCommands: [{ command: "true", cwd: "/outside" }] }]))).rejects.toThrow("escapes");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a truncated downloaded tar without publishing the host file", async () => {
    const source = path.join(remote, "source"), target = path.join(host, "out"); await fs.writeFile(source, "new"); await fs.writeFile(target, "OLD");
    downloadOverride = Buffer.from("truncated tar");
    await expect(sync({ sourcePath: source, targetPath: target, kind: "file" }, true)).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("OLD"); await clean();
  });
  it.each(["symlink-pivot", "hardlink-escape", "parent-traversal"])("rejects hostile archive %s without escaping host staging", async attack => {
    const source = path.join(remote, "source"), target = path.join(host, "out"), outside = path.join(host, "outside");
    await fs.mkdir(source); await fs.mkdir(target); await fs.writeFile(path.join(target, "old"), "OLD"); await fs.writeFile(outside, "SAFE");
    // Minimal ustar records, authored independently of the provider's tar helpers.
    const entry = (name: string, type: string, link = "", content = "") => {
      const header = Buffer.alloc(512); header.write(name, 0); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
      header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156);
      header.write(type, 156); header.write(link, 157); header.write("ustar\0", 257); header.write("00", 263);
      header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
      return Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - Buffer.byteLength(content) % 512) % 512)]);
    };
    downloadOverride = Buffer.concat(attack === "symlink-pivot"
      ? [entry("pivot", "2", host), entry("pivot/outside", "0", "", "BAD"), Buffer.alloc(1024)]
      : attack === "hardlink-escape" ? [entry("evil", "1", outside), Buffer.alloc(1024)]
      : [entry("../../outside", "0", "", "BAD"), Buffer.alloc(1024)]);
    await expect(sync({ sourcePath: source, targetPath: target, kind: "directory" }, true)).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("SAFE"); expect(await fs.readdir(target)).toEqual(["old"]); await clean();
  });
  // Keep: regression for the live 0.1.9 round-trip, where DELETE returned 400 after publication.
  it.each([400, 404, 503].flatMap(status => [false, true].map(outbound => ({ status, outbound }))))(
    "completes sync with cleanup HTTP $status (outbound=$outbound)", async ({ status, outbound }) => {
      const source = path.join(outbound ? remote : host, "source"), target = path.join(outbound ? host : remote, "out");
      await fs.writeFile(source, "new"); fault = "cleanup"; cleanupStatus = status;
      const result = await sync({ sourcePath: source, targetPath: target, kind: "file" }, outbound);
      expect(result.operations[0]).toMatchObject({ operationId: "opaque/not/a/path", filesTransferred: 1 });
      expect(result.operations[0].bytesTransferred).toBeGreaterThan(0);
      expect(await fs.readFile(target, "utf8")).toBe("new");
    },
  );
});
