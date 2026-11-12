import { describe, expect, it, vi } from "vitest";
import { createPiConversationRecoveryPolicy, piSessionFileFailureCode } from "./pi-conversation-recovery.js";

function fixture() {
  const addComment = vi.fn(async () => ({}) as never);
  const onEvent = vi.fn(async () => {});
  const policy = createPiConversationRecoveryPolicy({ companyId: "company", agentId: "agent", issueId: "issue",
    runId: "run", sessionId: "conversation", issuesSvc: { addComment }, onEvent });
  return { policy, addComment, onEvent };
}
describe("Pi conversation file recovery policy (data safety)", () => {
  it("allows a missing-file fresh start only after the visible thread line and owner alarm", async () => {
    const { policy, addComment, onEvent } = fixture();
    const recovered = await policy.recover(async () => { throw Object.assign(new Error("private /home/token/path"), { code: "pi_session_file_missing" }); });
    expect(recovered).toMatchObject({ recovered: false, reason: expect.stringContaining("pi_session_file_missing") });
    const opened: string[] = [];
    await policy.beforeReplacement(); // the executor calls this before archiving/opening
    opened.push("fresh");
    expect(opened).toEqual(["fresh"]);
    expect(addComment).toHaveBeenCalledWith("issue", "My earlier conversation could not be restored: the saved Pi conversation file is missing. Starting a new one.",
      { runId: "run" }, expect.objectContaining({ authorType: "system" }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "native.pi_conversation_recovery_failed", level: "error",
      payload: expect.objectContaining({ code: "pi_session_file_missing", ownerAlarm: true, action: "start_fresh_with_notice", nativeSessionId: "conversation" }) }));
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("/home/token");
    await expect(policy.beforeReplacement()).rejects.toThrow("pi_conversation_replacement_refused");
    expect(addComment).toHaveBeenCalledTimes(1);
  });
  it.each(["corrupt", "wrong header id", "foreign owner"])("refuses %s without archiving/replacement, raises an alarm, and never announces a fresh start", async reason => {
    const { policy, addComment, onEvent } = fixture();
    await expect(policy.recover(async () => { throw Object.assign(new Error(reason), { code: "pi_session_file_invalid" }); })).rejects.toMatchObject({ code: "pi_session_file_invalid" });
    await expect(policy.beforeReplacement()).rejects.toThrow("pi_conversation_replacement_refused");
    expect(addComment).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", payload: expect.objectContaining({ code: "pi_session_file_invalid", action: "refused_preserve_saved_state" }) }));
  });
  it("accepts the named missing-file verdict through the serialized Runner refusal", async () => {
    const { policy, onEvent } = fixture();
    expect(await policy.recover(async () => ({ recovered: false, reason: "PRP session.resume: pi_session_file_missing: sensitive-path", failureClass: "provider_state_incompatible" })))
      .toEqual({ recovered: false, reason: "pi_session_file_missing: the saved Pi conversation file is missing" });
    await policy.beforeReplacement();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
  it("refuses a serialized invalid-file verdict even when a generic recovery class permits replacement", async () => {
    const { policy } = fixture();
    await expect(policy.recover(async () => ({ recovered: false, reason: "pi_session_file_invalid: malformed JSONL" }))).rejects.toMatchObject({ code: "pi_session_file_invalid" });
  });
  it("cannot treat a transport failure or an untyped refusal as permission to erase history", async () => {
    const { policy } = fixture();
    await expect(policy.recover(async () => { throw new Error("transport offline"); })).rejects.toThrow("transport offline");
    await expect(policy.beforeReplacement()).rejects.toThrow("pi_conversation_replacement_refused");
  });
  it("fails closed if the visible missing-file notice cannot be persisted", async () => {
    const { policy, addComment } = fixture();
    await policy.recover(async () => ({ recovered: false, reason: "pi_session_file_missing" }));
    addComment.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(policy.beforeReplacement()).rejects.toThrow("database unavailable");
  });
  it("maps a nested typed driver error and a startup invalid-file error", async () => {
    const { policy, onEvent } = fixture();
    expect(piSessionFileFailureCode(new Error("RPC failed", { cause: { code: "pi_session_file_invalid" } }))).toBe("pi_session_file_invalid");
    await expect(policy.open(async () => { throw { code: "pi_session_file_invalid" }; })).rejects.toMatchObject({ code: "pi_session_file_invalid" });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
