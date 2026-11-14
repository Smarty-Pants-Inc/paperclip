import { describe, expect, it, vi } from "vitest";
import { NativeSessionDiagnostics, nativeSessionDiagnostics } from "./native-session-diagnostics.js";
import { createNativeRunTrace } from "./native-run-trace.js";

const owner = { companyId: "company", sessionScope: "session", runId: "run-a" };
function fixture() {
  const idle = vi.fn(), failed = vi.fn();
  return { idle, failed, channel: new NativeSessionDiagnostics(owner, owner, idle, failed) };
}

describe("native session diagnostic ownership", () => {
  it("routes active A and B separately and ignores stale A retirement", async () => {
    const f = fixture(), a = vi.fn(async () => undefined), b = vi.fn(async () => undefined);
    const first = f.channel.activate(owner, a);
    f.channel.record("first");
    first.retire();
    const second = f.channel.activate({ ...owner, runId: "run-b" }, b);
    first.retire();
    f.channel.record("second");
    second.retire();
    expect(a.mock.calls).toEqual([["stderr", "first"]]);
    expect(b.mock.calls).toEqual([["stderr", "second"]]);
    expect(f.idle).not.toHaveBeenCalled();
  });

  it.each(["stdout", "stderr"] as const)("preserves %s transport chunks across warm run ownership changes", stream => {
    const f = fixture(), a = vi.fn(async () => undefined), b = vi.fn(async () => undefined);
    const first = f.channel.activate(owner, a);
    f.channel.record("first transport chunk", stream);
    first.retire();
    const second = f.channel.activate({ ...owner, runId: "run-b" }, b);
    f.channel.record("second transport chunk", stream);
    second.retire();
    f.channel.record("private idle transport chunk", stream);
    expect(a).toHaveBeenCalledExactlyOnceWith(stream, "first transport chunk");
    expect(b).toHaveBeenCalledExactlyOnceWith(stream, "second transport chunk");
    expect(f.idle).toHaveBeenCalledExactlyOnceWith({ ...owner, runId: "run-b" }, "session_diagnostic");
  });

  it("rebinds the transport trace with its log epoch and clears it on retirement", async () => {
    const f = fixture(), a = vi.fn(async () => undefined), b = vi.fn(async () => undefined);
    const firstTrace = createNativeRunTrace({ runId: "run-a", onEvent: a });
    const nextTrace = createNativeRunTrace({ runId: "run-b", onEvent: b });
    const sink = vi.fn(async () => undefined);
    const first = f.channel.activate(owner, sink, firstTrace);
    expect(f.channel.trace).toBe(firstTrace);
    first.retire();
    expect(f.channel.trace).toBeUndefined();
    const second = f.channel.activate({ ...owner, runId: "run-b" }, sink, nextTrace);
    first.retire();
    expect(f.channel.trace).toBe(nextTrace);
    await expect(f.channel.trace!.measure("runner.prp.authenticate", async () => { throw new Error("transport failed"); }))
      .rejects.toThrow("transport failed");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ eventType: "run.performance.span", payload: expect.objectContaining({
      span: "runner.prp.authenticate", outcome: "failed" }) }));
    second.retire();
    expect(f.channel.trace).toBeUndefined();
    await firstTrace.finish("ok"); await nextTrace.finish("failed");
  });

  it("refuses a competing trace even when the log sink and run ID match", async () => {
    const f = fixture(), sink = vi.fn(async () => undefined);
    const first = createNativeRunTrace({ runId: owner.runId }), next = createNativeRunTrace({ runId: owner.runId });
    const lease = f.channel.activate(owner, sink, first);
    expect(() => f.channel.activate(owner, sink, next)).toThrow("native_diagnostic_owner_busy");
    expect(f.channel.trace).toBe(first);
    lease.retire();
    await first.finish("ok"); await next.finish("ok");
  });

  it("detaches immediately while the recorder owns accepted write settlement", async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let drained = false;
    const writing = blocked.then(() => { drained = true; });
    const sink = vi.fn(() => writing), next = vi.fn(async () => undefined);
    const first = f.channel.activate(owner, sink);
    f.channel.record("accepted before retirement");
    first.retire();
    f.channel.record("late private text");
    const second = f.channel.activate({ ...owner, runId: "run-b" }, next);
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(f.idle).toHaveBeenCalledWith(owner, "session_diagnostic");
    release();
    await writing;
    f.channel.record("next accepted diagnostic");
    second.retire();
    expect(sink).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith("stderr", "next accepted diagnostic");
  });

  it.each([{ companyId: "foreign-company" }, { sessionScope: "foreign-session" }, { runId: "" }])("rejects foreign or missing ownership %j", patch => {
    const f = fixture(), sink = vi.fn(async () => undefined);
    expect(() => f.channel.activate({ ...owner, ...patch }, sink)).toThrow("native_diagnostic_owner_scope_mismatch");
    f.channel.record("private provider output");
    expect(sink).not.toHaveBeenCalled();
    expect(f.idle).toHaveBeenCalledWith(owner, "session_diagnostic");
  });

  it("refuses a competing live owner and retains the accepted owner", async () => {
    const f = fixture(), sink = vi.fn(async () => undefined), foreign = vi.fn(async () => undefined);
    const lease = f.channel.activate(owner, sink);
    expect(() => f.channel.activate({ ...owner, runId: "run-b" }, foreign)).toThrow("native_diagnostic_owner_busy");
    f.channel.record("accepted");
    lease.retire();
    expect(sink).toHaveBeenCalledWith("stderr", "accepted");
    expect(foreign).not.toHaveBeenCalled();
  });

  it("binds one physical session to one channel", () => {
    const f = fixture(), other = fixture(), session = {};
    f.channel.bind(session);
    f.channel.bind(session);
    expect(nativeSessionDiagnostics(session)).toBe(f.channel);
    expect(() => other.channel.bind(session)).toThrow("native_diagnostic_session_already_bound");
    expect(nativeSessionDiagnostics(session)).toBe(f.channel);
  });

  it.each([
    "Bearer synthetic-secret /private/customer/path alice@example.invalid",
    "[paperclip-runner] runnerd diagnostic: runner transport close requested: Bearer synthetic-secret /private/customer/path",
    "\n{\"diagnosticKind\":\"trusted\",\"token\":\"synthetic-secret\"}",
  ])("retains only a closed category for idle untrusted text %j", async text => {
    const f = fixture(), sink = vi.fn(async () => undefined);
    const lease = f.channel.activate(owner, sink);
    lease.retire();
    f.channel.record(text);
    const args = JSON.stringify(f.idle.mock.calls);
    expect(f.idle).toHaveBeenCalledOnce();
    expect(["transport_close_requested", "session_diagnostic"]).toContain(f.idle.mock.calls[0]![1]);
    for (const privateText of ["synthetic-secret", "/private/customer", "alice@", "token"])
      expect(args).not.toContain(privateText);
    expect(sink).not.toHaveBeenCalled();
  });

  it("retains a sink failure without leaking its exception", async () => {
    const f = fixture(), lease = f.channel.activate(owner, async () => { throw new Error("private exception"); });
    f.channel.record("accepted diagnostic");
    lease.retire();
    await vi.waitFor(() => expect(f.failed.mock.calls).toEqual([[owner]]));
    expect(f.idle).not.toHaveBeenCalled();
  });
});
