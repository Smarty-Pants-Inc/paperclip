import { expect, it, vi } from "vitest";
import { createPiRpcAppServerProxy } from "../../../packages/paperclip-runner/src/cli/pi-rpc-app-server-proxy.js";
import type { HarnessDriver } from "../../../packages/paperclip-runner/src/contracts/harness-driver.js";

// Keep reason: trust boundary. The facade must not invent a conversation when
// the server-owned normalized id is absent. This is a protocol boundary test,
// not the full-server/Pi process proof in stop-continue.e2e.test.ts.
const enabled = process.env.PAPERCLIP_PI_FULL_SERVER_E2E === "1";

it.skipIf(!enabled).each(["thread/start", "thread/resume"])("BPLUS1 %s refuses absent normalized identity before opening history", async method => {
  const frames: Array<Record<string, unknown>> = [];
  const openSession = vi.fn(async () => { throw new Error("UNEXPECTED_FRESH_OPEN"); });
  const recoverSession = vi.fn(async () => { throw new Error("UNEXPECTED_RECOVERY"); });
  const proxy = createPiRpcAppServerProxy({
    stdout: { write: chunk => { frames.push(JSON.parse(chunk)); return true; }, once: () => undefined },
    environment: { PAPERCLIP_RUN_ID: "bplus1-owned-run" },
    createDriver: () => ({ openSession, recoverSession } as unknown as HarnessDriver),
  });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method, params: { cwd: process.cwd(), model: "paperclip/faux", threadId: "provider-native-id" } }));
    await vi.waitFor(() => expect(frames.some(frame => frame.id === 1)).toBe(true));
    expect(JSON.stringify(frames.find(frame => frame.id === 1))).toContain("PAPERCLIP_NORMALIZED_SESSION_ID");
    expect(openSession).not.toHaveBeenCalled();
    expect(recoverSession).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});

it.skipIf(!enabled)("BPLUS1 thread/resume observably calls recoverSession with normalized file identity, never provider id as filename", async () => {
  const frames: Array<Record<string, unknown>> = [];
  const openSession = vi.fn(async () => { throw new Error("UNEXPECTED_FRESH_OPEN"); });
  // The typed failure deliberately stops before any fake session can be used.
  const recoverSession = vi.fn(async () => { throw Object.assign(new Error("Saved Pi history is invalid"), { code: "pi_session_file_invalid" }); });
  const proxy = createPiRpcAppServerProxy({
    stdout: { write: chunk => { frames.push(JSON.parse(chunk)); return true; }, once: () => undefined },
    environment: { PAPERCLIP_RUN_ID: "bplus1-owned-run", PAPERCLIP_NORMALIZED_SESSION_ID: "server-conversation-id" },
    createDriver: () => ({ openSession, recoverSession } as unknown as HarnessDriver),
  });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/resume", params: { cwd: process.cwd(), model: "paperclip/faux", threadId: "provider-native-id" } }));
    await vi.waitFor(() => expect(frames.some(frame => frame.id === 1)).toBe(true));
    expect(recoverSession).toHaveBeenCalledWith(expect.objectContaining({ normalizedSessionId: "server-conversation-id",
      driverSessionId: "provider-native-id", providerSessionId: "provider-native-id", workingDirectory: process.cwd() }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(frames.find(frame => frame.id === 1)).toMatchObject({ error: { data: { code: "pi_session_file_invalid" } } });
    expect(openSession).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});
