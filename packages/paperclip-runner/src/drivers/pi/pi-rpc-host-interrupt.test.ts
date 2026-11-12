import { describe, it, expect, FakeCodexTransport, makeDriver, WORKSPACE } from "../codex/codex-app-server-driver.test-support.js";

// Recorded integration catch: Pi's abort ladder consumes native settlement and
// publishes turn.cancelled before its interrupt RPC returns. The facade must
// not quarantine this healthy resident as a failed cleanup operation.
describe("Pi host interrupt settlement ordering", () => {
  it("accepts the captured Pi turn terminal before the interrupt response", async () => {
    class SettlingTransport extends FakeCodexTransport {
      override async request(method: string, params: Record<string, unknown>) {
        if (method === "turn/interrupt") {
          this.push("turn/completed", { threadId: this.threadId, turn: { id: params.turnId, status: "cancelled", items: [] } });
          // Let the ordinary notification pump consume the terminal first.
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        return super.request(method, params);
      }
    }
    const transport = new SettlingTransport();
    const session = await makeDriver([transport], { driverIdentity: { kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" } }).openSession({
      runId: "run-pi-interrupt-order", normalizedSessionId: "pi-interrupt-order", workingDirectory: WORKSPACE,
    });
    try {
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Ask a human." } });
      await expect(session.interrupt?.({ turnId, reason: "durable governed wait" })).resolves.toBeUndefined();
    } finally { await session.close({ reason: "test complete" }); }
  });
});
