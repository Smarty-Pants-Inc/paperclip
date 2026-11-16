import { describe, expect, it, vi } from "vitest";
import type { NativeExecutionInput } from "../contracts/native-execution.js";

const selected = vi.hoisted(() => ({ options: {} as Record<string, unknown> }));
vi.mock("../drivers/pi/pi-rpc-driver.js", () => ({
  PiRpcDriver: class {
    constructor(options: Record<string, unknown>) { selected.options = options; }
  },
}));
import { createPiNativeSessionBackend } from "./pi-native-backend.js";

// Keep reason: persisted input -> driver configuration boundary; no provider process is needed.
describe("Pi native backend default selection", () => {
  it.each([[undefined, "max"], ["low", "low"]] as const)("uses the shared catalog only when effort is unset (%s)", (configured, expected) => {
    const input = {
      schema: "paperclip.native-execution-input.v1",
      provider: { kind: "pi_rpc", model: "paperclip/claude-opus-5-5", ...(configured === undefined ? {} : { piRpcThinkingLevel: configured }) },
      task: { prompt: "Complete the task.", workMode: "standard" },
      completionContract: { contract: { objective: "Complete the task.", revision: "r1", criteria: [] } },
    } as unknown as NativeExecutionInput;
    createPiNativeSessionBackend(input, { runtimeDirectory: "/unused/no-process" });
    expect(selected.options).toMatchObject({ model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: expected, startupTimeoutMs: 10_000 });
  });

  it.each(["0", "1.5", "NaN", "30000", "30001", "60000"])("rejects invalid admission deadline %s before driver creation", deadline => {
    const input = {
      schema: "paperclip.native-execution-input.v1",
      provider: { kind: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off" },
      task: { prompt: "Complete the task.", workMode: "standard" },
      completionContract: { contract: { objective: "Complete the task.", revision: "r1", criteria: [] } },
    } as unknown as NativeExecutionInput;
    expect(() => createPiNativeSessionBackend(input, {
      runtimeDirectory: "/unused/no-process", environment: { PAPERCLIP_PI_ADMISSION_TIMEOUT_MS: deadline },
    })).toThrow("pi_admission_deadline_invalid");
  });

  it("uses the explicit environment deadline ahead of the programmatic fallback, without ambient inheritance", () => {
    const input = {
      schema: "paperclip.native-execution-input.v1",
      provider: { kind: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off" },
      task: { prompt: "Complete the task.", workMode: "standard" },
      completionContract: { contract: { objective: "Complete the task.", revision: "r1", criteria: [] } },
    } as unknown as NativeExecutionInput;
    vi.stubEnv("PAPERCLIP_PI_ADMISSION_TIMEOUT_MS", "30000");
    try {
      createPiNativeSessionBackend(input, { runtimeDirectory: "/unused/no-process", startupTimeoutMs: 7000 });
      expect(selected.options.startupTimeoutMs).toBe(7000);
      createPiNativeSessionBackend(input, {
        runtimeDirectory: "/unused/no-process", startupTimeoutMs: 7000,
        environment: { PAPERCLIP_PI_ADMISSION_TIMEOUT_MS: "8000" },
      });
      expect(selected.options.startupTimeoutMs).toBe(8000);
    } finally { vi.unstubAllEnvs(); }
  });
});
