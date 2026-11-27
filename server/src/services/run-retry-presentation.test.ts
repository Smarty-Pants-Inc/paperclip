import { describe, expect, it } from "vitest";
import { classifyRetryConsequence, type RetrySelectorFacts } from "./run-retry-presentation.js";
import { managedAiSessionIdentity } from "./ai-connection-session.js";

const facts = (extra: Partial<RetrySelectorFacts> = {}): RetrySelectorFacts => ({
  adapterType: "paperclip_runner", config: { provider: "pi_rpc", sessionContinuity: "continuous" },
  chat: false, run: { errorCode: "adapter_failed" }, ...extra,
});
describe("read-only per-run Retry consequence", () => {
  it("explicitly reports same-session Retry without a fresh-session disclosure", () => {
    expect(classifyRetryConsequence(facts())).toEqual({ retryStartsNewSession: false });
  });
  it.each([
    { run: { errorCode: "saved_session_unavailable" }, code: "saved_session_unavailable" },
    { run: { errorCode: "native_provider_state_incompatible" }, code: "session_cannot_continue" },
    { run: { error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" }, code: "session_cannot_continue" },
    { credentialCompatible: false, code: "credential_changed" },
    { savedSessionExpected: true, checkpointAvailable: false, code: "saved_session_unavailable" },
    { hardResetCategories: ["adapter", "workspaceConfig", "secrets"], code: "configuration_reset" },
  ])("names the actual refusal: $code", ({ code, ...extra }) => {
    const result = classifyRetryConsequence(facts(extra));
    expect(result).toMatchObject({ retryStartsNewSession: true, retryReasonCode: code,
      retryReason: expect.any(String), retryDisclosure: expect.stringContaining("this task") });
    if (extra.hardResetCategories) for (const category of extra.hardResetCategories) expect(result.retryReason).toContain(category);
  });
  it.each(["process", "http", "webhook"])("describes %s as action replay, not provider-session resumption", adapterType => {
    const result = classifyRetryConsequence(facts({ adapterType }));
    expect(result).toMatchObject({ retryStartsNewSession: false, retryDisclosure: expect.stringContaining("action again") });
    expect(result.retryDisclosure).not.toContain("old session");
  });
  it.each([true, false])("uses the chat/task noun for isolated and ordinary new sessions: chat=%s", chat => {
    for (const requiresIsolatedWorkspace of [false, true]) {
      const result = classifyRetryConsequence(facts({ chat, requiresIsolatedWorkspace,
        config: { provider: "pi_rpc", sessionContinuity: "paperclip" } }));
      expect(result.retryDisclosure).toContain(chat ? "this chat" : "this task");
      expect(result.retryDisclosure).not.toContain(chat ? "this task" : "this chat");
      if (requiresIsolatedWorkspace) {
        expect(result.retryDisclosure).toContain("at your press");
        expect(result.retryDisclosure).toContain("the earlier run may still be running and could change files");
      }
    }
  });
  it("prioritizes the exact unknown-side-effect warning over other reset facts", () => {
    expect(classifyRetryConsequence(facts({ run: { errorCode: "native_provider_side_effect_pending" },
      credentialCompatible: false, hardResetCategories: ["adapter"], requiresIsolatedWorkspace: true }))).toEqual({
      retryStartsNewSession: true, retryReasonCode: "side_effect_pending",
      retryReason: "The last action may or may not have run. Check it before you continue.",
      retryDisclosure: "Start a new session anyway: it will be told the last action's outcome is unknown.",
    });
  });
  it("uses the same metadata-only account epoch identity as runtime preparation", () => {
    expect(managedAiSessionIdentity("grant", "person", { secretId: "secret", epoch: 7 })).toBe("grant:person:secret:7");
    expect(managedAiSessionIdentity("grant", null, null)).toBe("grant:shared:no-auth");
  });
});
