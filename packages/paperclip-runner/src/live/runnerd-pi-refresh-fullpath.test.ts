import { expect, it } from "vitest";
import { runnerdRecoveryInternals } from "./runnerd-codex-transport.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";

// R1 regression: the controller packet, not Rust or the native renderer, kept
// FIRST on a no-prepareLaunch warm attach. The actual runnerd IPC journey is
// covered in runnerd-pi-resident-attach.test.ts; retain these counterexamples so
// fixing Pi does not silently broaden other providers' refresh contracts.
const identity: DurableRecoveryIdentity = {
  runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session",
  runId: "second", turnId: "turn-second", itemId: "item-second",
};

it("refreshes only the explicitly granted Pi packet and preserves no-grant and non-Pi descriptors", () => {
  for (const kind of ["pi_rpc", "codex", "opencode"]) {
    const provider = { kind, provider: kind, instructions: "FIRST", runtimeContext: { retained: true } };
    const seed = { runAttachTemplate: { provider } };
    expect(runnerdRecoveryInternals.rotatedRunAttachPayload(seed, identity, null, undefined).provider).toEqual(provider);
    const next = runnerdRecoveryInternals.rotatedRunAttachPayload(seed, identity, null, undefined,
      null, { text: "SECOND", context: null });
    expect(next.provider).toEqual(kind === "pi_rpc"
      ? { ...provider, instructions: "SECOND", runtimeContext: null } : provider);
    expect(seed.runAttachTemplate.provider.instructions).toBe("FIRST");
  }
});
