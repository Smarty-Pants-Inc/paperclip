import { timingSafeEqual } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
let fixtureRoot: string;
let fixture: string;
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "paperclip-opencode-proxy-fixture-"));
  fixture = join(fixtureRoot, "fake-opencode-server.mjs");
  await copyFile(resolve("test/fixtures/fake-opencode-server.mjs"), fixture);
  await chmod(fixture, 0o755);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

async function openProxy(upstream: Server, environment: NodeJS.ProcessEnv = {}) {
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => {
    upstream.close(() => resolve()); upstream.closeAllConnections();
  }));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-proxy-regression-"));
  roots.push(root);
  const driver = new OpenCodeServerDriver({
    model: "paperclip/team/model-alias", runtimeDirectory: root, command: fixture,
    environment: { PATH: process.env.PATH,
      PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/custom/v1`,
      PAPERCLIP_AI_PROVIDER_KEY: "synthetic-upstream-key", ...environment },
  });
  const session = await driver.openSession({ runId: "proxy", normalizedSessionId: "proxy", workingDirectory: root });
  cleanups.push(() => session.close({ reason: "test" }));
  const config = JSON.parse(await readFile(join(root, "proxy", "config", "opencode", "opencode.json"), "utf8"));
  const { baseURL, apiKey } = config.provider.paperclip.options as { baseURL: string; apiKey: string };
  const send = (path = "/chat/completions", token = apiKey) => fetch(`${baseURL}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "team/model-alias", messages: [{ role: "user", content: "synthetic" }] }),
  });
  return { send, apiKey };
}

describe("OpenCode provider proxy fork regressions", () => {
  // Keep reason: RFL merge-C F1, on the actual driver/config/loopback HTTP path.
  it.each(["", "?beta=true&encoded=%2f+%20&repeat=1&repeat=2", "?"])(
    "forwards exact query bytes without exposing the capability (%s)", async query => {
      const received: Array<{ path?: string; authorization?: string }> = [];
      const { send, apiKey } = await openProxy(createServer((request, response) => {
        request.resume();
        received.push({ path: request.url, authorization: request.headers.authorization });
        response.end("upstream reached");
      }));
      const response = await send(`/chat/completions${query}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("upstream reached");
      expect(received).toEqual([{ path: `/custom/v1/chat/completions${query}`, authorization: "Bearer synthetic-upstream-key" }]);
      expect(JSON.stringify(received)).not.toContain(apiKey);
      for (const path of ["/other?beta=true", "/chat/completions/?beta=true", "/chat/%63ompletions?beta=true"]) {
        expect((await send(path)).status).toBe(404);
      }
      expect(received).toHaveLength(1);
    },
  );

  // Keep reason: capability authentication is a trust boundary. Exercise the
  // real crypto primitive rather than trying to infer timing from wall time.
  it("compares both accepted and same-length rejected tokens with timingSafeEqual", async () => {
    let received = 0;
    const { send, apiKey } = await openProxy(createServer((request, response) => {
      request.resume(); received++; response.end("ok");
    }));
    const wrong = `${apiKey[0] === "A" ? "B" : "A"}${apiKey.slice(1)}`;
    vi.mocked(timingSafeEqual).mockClear();
    expect((await send("/chat/completions", wrong)).status).toBe(401);
    expect(timingSafeEqual).toHaveBeenCalledWith(Buffer.from(`Bearer ${wrong}`), Buffer.from(`Bearer ${apiKey}`));
    expect(received).toBe(0);
    expect((await send()).status).toBe(200);
    expect(timingSafeEqual).toHaveBeenLastCalledWith(Buffer.from(`Bearer ${apiKey}`), Buffer.from(`Bearer ${apiKey}`));
    expect((await send("/chat/completions", "short")).status).toBe(401);
    expect(received).toBe(1);
  });

  // As in C8's broker tests, virtualize only deadline timers, not HTTP I/O.
  it("keeps active streams alive past ten minutes with the default 120-second byte-idle deadline", async () => {
    let write!: (text: string) => void;
    let finish!: () => void;
    const { send } = await openProxy(createServer((request, response) => {
      request.resume(); response.writeHead(200, { "content-type": "text/event-stream" }); response.write("start\n");
      write = text => { response.write(text); };
      finish = () => { response.end("done\n"); };
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms).unref(); return controller.signal;
    });
    const response = await send();
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("start\n");
    for (let i = 0; i < 6; i++) {
      // Attach rejection handling before advancing the old total deadline.
      const next = reader.read().then(chunk => ({ chunk }), error => ({ error }));
      await vi.advanceTimersByTimeAsync(119_000);
      write(`chunk-${i}\n`);
      const result = await next;
      expect(result).not.toHaveProperty("error");
      if (!("chunk" in result)) throw new Error("Provider stream ended at a total-duration cutoff");
      expect(Buffer.from(result.chunk.value!).toString()).toBe(`chunk-${i}\n`);
    }
    finish();
    let output = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += Buffer.from(chunk.value).toString(); }
    expect(output).toBe("done\n");
  });

  it("aborts a byte-idle stream at its configured deadline and remains reusable", async () => {
    let count = 0;
    const { send } = await openProxy(createServer((request, response) => {
      request.resume();
      if (++count === 1) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("start\n"); }
      else response.end("next succeeds");
    }), { PAPERCLIP_PROVIDER_IDLE_TIMEOUT_MS: "2000" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = await send();
    const reader = response.body!.getReader();
    await reader.read();
    const next = reader.read().then(() => "unexpected data", () => "aborted");
    await vi.advanceTimersByTimeAsync(2001);
    // A bounded real-I/O turn prevents a missing idle deadline from hanging RED.
    const outcome = await Promise.race([next, new Promise<string>(resolve => setImmediate(() => setImmediate(() => resolve("still open"))))]);
    expect(outcome).toBe("aborted");
    expect(await (await send()).text()).toBe("next succeeds");
  });

  it("uses the default byte-idle deadline when no override is configured", async () => {
    const { send } = await openProxy(createServer((request, response) => {
      request.resume(); response.writeHead(200, { "content-type": "text/event-stream" }); response.write("start\n");
    }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reader = (await send()).body!.getReader();
    await reader.read();
    const next = reader.read().then(() => "unexpected data", () => "aborted");
    await vi.advanceTimersByTimeAsync(120_001);
    const outcome = await Promise.race([next, new Promise<string>(resolve => setImmediate(() => setImmediate(() => resolve("still open"))))]);
    expect(outcome).toBe("aborted");
  });
});
