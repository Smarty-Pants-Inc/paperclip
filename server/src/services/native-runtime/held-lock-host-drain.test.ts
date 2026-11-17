import { describe, expect, it, vi } from "vitest";
import { hostMutation } from "@paperclipai/adapter-utils/host-mutation-drain";
import { logger } from "../../middleware/logger.js";
import { withHeldLockHostDrain } from "./held-lock-host-drain.js";

class TestLockLostError extends Error { override name = "TestLockLostError"; }

describe("withHeldLockHostDrain: bound past the cap", () => {
  it("a lost lock with a host call still in flight past the cap logs a true line and keeps the lock until the call returns", async () => {
    let alive = true;
    const lock = { execute: vi.fn(async () => { if (!alive) throw new Error("connection terminated"); return []; }) };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    let finish!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const inCall = new Promise<void>(resolve => { started = resolve; });
    let settled = false;
    const op = withHeldLockHostDrain({ lock: lock as never, idleTimeoutMs: 30, label: "test lock", capMs: 50,
      lostError: cause => new TestLockLostError(String(cause)) }, async (signal) => {
      void hostMutation(async () => { started(); await held; }).catch(() => undefined);
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return "unreachable";
    }).then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
    await inCall;
    alive = false; // the next ping fails: onLost
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(settled).toBe(false); // past the 50 ms cap: still held (the lock transaction has not ended)
    expect(warn.mock.calls.some(([, line]) => typeof line === "string"
      && line.includes("test lock: the lock was lost and a host write has not finished"))).toBe(true);
    finish();
    const result = await op;
    expect("error" in result && (result.error as Error).name).toBe("TestLockLostError");
    warn.mockRestore();
  });

  it("timeout 0: no keepalive, nothing closes, the work's result is returned unchanged", async () => {
    const lock = { execute: vi.fn(async () => []) };
    const value = await withHeldLockHostDrain({ lock: lock as never, idleTimeoutMs: 0, label: "t", lostError: () => new Error("x") },
      async (signal) => { await hostMutation(async () => undefined); return signal.aborted ? "aborted" : "ok"; });
    expect(value).toBe("ok");
    expect(lock.execute).not.toHaveBeenCalled();
  });
});
