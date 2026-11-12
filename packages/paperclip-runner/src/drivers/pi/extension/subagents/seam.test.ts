import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { announce, installSubagentSeam, registerParkReadyContributor, registerStopChildren, socketAnnounce } from "./seam.js";

const origin = { epoch: 7, runId: "parent-run", turnId: "parent-turn" };
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function socket(reply: (request: Record<string, unknown>, send: (line: string) => void) => void) {
  const dir = await mkdtemp(join(tmpdir(), "s1-socket-"));
  const path = join(dir, "bind.sock");
  const server = createServer(client => {
    let pending = "";
    client.on("error", () => {});
    client.on("data", chunk => {
      pending += chunk.toString();
      if (pending.includes("\n")) reply(JSON.parse(pending.split("\n")[0]!), line => client.end(line + "\n"));
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(dir, { recursive: true, force: true }); });
  return path;
}
describe("S-1 exact authority seam (trust boundary)", () => {
  it("fails closed without composition and delegates the exact in-process signatures", () => {
    expect(announce("child-call", origin)).toBe(false);
    expect(() => registerParkReadyContributor(() => ({ ready: false, reasons: [] }))).toThrow(/seam/i);
    const seen: unknown[] = [];
    cleanups.push(installSubagentSeam({
      announce: (id, captured) => { seen.push([id, captured]); return true; },
      registerParkReadyContributor: fn => { seen.push(fn); return () => { seen.push("park disposed"); }; },
      registerStopChildren: fn => { seen.push(fn); return () => { seen.push("stop disposed"); }; },
    }));
    expect(announce("native-child-call", origin)).toBe(true);
    expect(seen[0]).toEqual(["native-child-call", origin]);
    registerParkReadyContributor(() => ({ ready: true, reasons: [] }))();
    registerStopChildren(() => ({ settled: [], uncertain: [] }))();
    expect(seen).toContain("park disposed"); expect(seen).toContain("stop disposed");
  });
  it("sends the captured origin over a real UNIX socket and waits for ack", async () => {
    let release!: () => void;
    let received!: () => void;
    const arrived = new Promise<void>(resolve => { received = resolve; });
    const path = await socket((request, send) => {
      expect(request).toMatchObject({ kind: "announce", schema: 1, sessionId: "parent-session", toolCallId: "native-call", origin });
      expect(request.nonce).toEqual(expect.any(String));
      release = () => send(JSON.stringify({ ack: true, nonce: request.nonce, sessionId: request.sessionId })); received();
    });
    let dispatched = false;
    const pending = socketAnnounce({ socketPath: path, sessionId: "parent-session", toolCallId: "native-call", origin }).then(ack => { dispatched = ack; return ack; });
    await arrived; expect(dispatched).toBe(false); release(); expect(await pending).toBe(true);
  });
  it("blocks missing sockets, malformed/refused/miscorrelated ack and bounded timeout", async () => {
    for (const reply of ['{"ack":false}', '{"ack":true,"nonce":"wrong"}', '{"ack":true,"sessionId":"wrong"}', "not JSON"]) {
      const path = await socket((_request, send) => send(reply));
      expect(await socketAnnounce({ socketPath: path, sessionId: "s", toolCallId: "c", origin })).toBe(false);
    }
    const path = await socket(() => {});
    expect(await socketAnnounce({ socketPath: path, sessionId: "s", toolCallId: "c", origin, timeoutMs: 20 })).toBe(false);
    expect(await socketAnnounce({ socketPath: "/missing/s1.sock", sessionId: "s", toolCallId: "c", origin })).toBe(false);
    expect(await socketAnnounce({ socketPath: "", sessionId: "s", toolCallId: "c", origin })).toBe(false);
  });
  it("does not admit an ack after cancellation", async () => {
    const controller = new AbortController();
    const path = await socket((_request, send) => { controller.abort(); send('{"ack":true}'); });
    expect(await socketAnnounce({ socketPath: path, sessionId: "s", toolCallId: "c", origin, signal: controller.signal })).toBe(false);
  });
});
