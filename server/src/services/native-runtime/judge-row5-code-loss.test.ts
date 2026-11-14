import { expect, it } from "vitest";
import { freshThreadRefusalCode, isFreshThreadRefusal } from "./runner-reconciliation-refusal.js";
import { nativeSessionFailureSourceCode } from "./native-session-executor.js";

// JUDGE probe (rfl-d10c3). Mirrors three production lines; it is NOT an end-to-end run:
//  1. native-session-executor.ts:15824-15826  inner error carries { code: "runner_remote_state_unavailable" }
//  2. drivers/codex/codex-app-server-driver-impl.ts:~851  recoverSession catch -> { recovered:false, reason: String(error) }
//  3. packages/paperclip-runner/src/native-session-runtime.ts:2659-2664  new Error(`native_session_recovery_failed: ${reason}`) (no code, no cause)
it("row 5: the code set on runner_remote_state_unavailable does not survive the Runner recovery wrap", () => {
  const inner = Object.assign(new Error("runner_remote_state_unavailable: exit=1 timedOut=false"), { code: "runner_remote_state_unavailable" });
  expect(freshThreadRefusalCode(inner)).toBe("runner_remote_state_unavailable");
  const reason = String(inner);                                   // driver boundary
  const wrapped = new Error(`native_session_recovery_failed: ${reason}`); // runtime boundary (the real specimens' stored text)
  const code = freshThreadRefusalCode(wrapped);
  const source = nativeSessionFailureSourceCode(wrapped as never);
  console.log("ROW5 probe:", JSON.stringify({ wrappedMessage: wrapped.message, freshThreadRefusalCode: code, nativeSessionFailureSourceCode: source,
    isFreshThreadRefusalForStoredRow: isFreshThreadRefusal({ errorCode: "native_session_interrupted", resultJson: {} }) }));
  expect(code).toBeNull();
});
