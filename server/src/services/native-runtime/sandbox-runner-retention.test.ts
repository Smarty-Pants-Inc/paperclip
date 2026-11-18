import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createSandboxRunnerRetention, createSandboxRunnerSupervision, SANDBOX_RUNNER_GUARDIAN_CLIENT } from "./sandbox-runner-retention.js";

const source = { runnerInstanceId: "runner", environmentLeaseId: "durable-lease-A", runId: "run-A", normalizedSessionId: "session", turnId: "turn", itemId: "item" };
const binding = { companyId: "company", environmentId: "environment", providerKey: "plugin:boat:sandbox", providerLeaseId: "boat-123", scopeDigest: "scope", accountIdentity: "account", credentialIdentity: "revision" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const parkId = `park_${hash(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)))))}`;
function fixture() {
  const order: string[] = [], commands: readonly string[][] = [], frames: Record<string, any>[] = [];
  let handle = async (frame: Record<string, any>): Promise<Record<string, unknown>> => {
    if (frame.op === "qualify") return { id: frame.id, status: "qualified", guardianVersion: 1, privateHostControlVersion: 1, runnerBinary: "/runtime/runnerd", runnerDigest: "sha256:verified" };
    if (frame.op === "observe") return { id: frame.id, status: "observed", identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 };
    order.push(frame.op);
    return { id: frame.id, status: frame.op === "park" ? "parked" : frame.op === "claim" ? "claimed" : "retired", ...(frame.op === "retire" ? { executionStopped: true, descendantsStopped: true, sessionStateAvailable: true } : {}) };
  };
  const openDuplexChannel = vi.fn(async ({ command }: { command: readonly string[] }): Promise<CommandManagedDuplexChannel> => {
    (commands as string[][]).push([...command]);
    let data: (b: Uint8Array) => void = () => {}, exit: (e: { exitCode: number | null; transportClosed?: boolean }) => void = () => {};
    return { onData: cb => { data = cb; }, onExit: cb => { exit = cb; }, stop: () => exit({ exitCode: 0 }), close: async () => {},
      write: bytes => { const frame = JSON.parse(Buffer.from(bytes).toString()); frames.push(frame); void handle(frame).then(reply => data(Buffer.from(`${JSON.stringify(reply)}\n`)), () => exit({ exitCode: null, transportClosed: true })); } };
  });
  const lifecycle = { releaseLease: vi.fn(async () => { order.push("stop"); }), resumeLease: vi.fn(async (): Promise<"resumed" | "unavailable"> => { order.push("resume"); return "resumed"; }) };
  const supervision = createSandboxRunnerSupervision();
  const input = { binding, lifecycle, openDuplexChannel, runnerInstanceId: "runner", supervision, timeoutMs: 50 };
  const owner = createSandboxRunnerRetention(input);
  owner.bindRoute({ quiesce: () => { order.push("quiesce"); }, close: async () => { order.push("close"); } });
  return { owner, input, lifecycle, order, frames, commands, supervision, setHandler: (next: typeof handle) => { const prior = handle; handle = next; return prior; } };
}
async function qualify(f: ReturnType<typeof fixture>) { await f.owner.qualify({ runnerBinary: "/runtime/runnerd", runnerDigest: "sha256:verified" }); }

describe("sandbox resident Runner trust boundary", () => {
  it("requires explicit live guardian qualification, not a reusable+duplex bit", async () => {
    const f = fixture(); expect(f.owner.driver).toBeUndefined(); await qualify(f); expect(f.owner.driver).toBeDefined();
    f.setHandler(async frame => ({ id: frame.id, status: "qualified", guardianVersion: 1, privateHostControlVersion: 0 }));
    const other = createSandboxRunnerRetention(f.input);
    await expect(other.qualify({ runnerBinary: "/runtime/runnerd", runnerDigest: "sha256:verified" })).rejects.toThrow("qualification");
    expect(other.driver).toBeUndefined();
  });
  it("fences supervision and quiesces before park ACK, stop ACK, then route close", async () => {
    const f = fixture(); await qualify(f);
    let parkAck!: () => void, stopAck!: () => void;
    const original = f.setHandler(async frame => { if (frame.op === "park") await new Promise<void>(r => { parkAck = r; }); return original(frame); });
    f.lifecycle.releaseLease.mockImplementation(async () => { f.order.push("stop"); await new Promise<void>(r => { stopAck = r; }); });
    const releasing = f.owner.driver!.release(source);
    await vi.waitFor(() => expect(parkAck).toBeDefined()); expect(f.supervision.paused).toBe(true); expect(f.order).toEqual(["quiesce"]);
    parkAck(); await vi.waitFor(() => expect(stopAck).toBeDefined()); expect(f.order).toEqual(["quiesce", "park", "stop"]);
    stopAck(); await releasing; expect(f.order).toEqual(["quiesce", "park", "stop", "close"]);
  });
  it.each(["park", "stop"])("retries lost %s ACK without changing the park cut or prematurely closing", async lost => {
    const f = fixture(); await qualify(f); let first = true;
    const original = f.setHandler(async frame => { if (lost === "park" && frame.op === "park" && first) { first = false; throw new Error("lost"); } return original(frame); });
    if (lost === "stop") f.lifecycle.releaseLease.mockImplementation(async () => { if (first) { first = false; throw new Error("lost"); } });
    await expect(f.owner.driver!.release(source)).rejects.toThrow(); expect(f.order).not.toContain("close");
    await f.owner.driver!.release(source);
    const parks = f.frames.filter(x => x.op === "park"); expect(parks.every(x => JSON.stringify(x) === JSON.stringify(parks[0]))).toBe(true);
    expect(parks[0]).toEqual({ op: "park", id: parkId, identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 }); expect(f.order.at(-1)).toBe("close");
  });
  it("does not reopen the guardian after a confirmed park when stop or route-close ACK is retried", async () => {
    const f = fixture(); await qualify(f); let stopped = false, lost = true, closeLost = true;
    const original = f.setHandler(async frame => { if (stopped) throw new Error("stopped VM cannot exec"); return original(frame); });
    f.lifecycle.releaseLease.mockImplementation(async () => { stopped = true; if (lost) { lost = false; throw new Error("lost stop ACK"); } });
    f.owner.bindRoute({ quiesce() {}, close: async () => { if (closeLost) { closeLost = false; throw new Error("close interrupted"); } } });
    await expect(f.owner.driver!.release(source)).rejects.toThrow("lost stop ACK");
    await expect(f.owner.driver!.release(source)).rejects.toThrow("close interrupted");
    await f.owner.driver!.release(source);
    expect(f.frames.filter(frame => frame.op === "park")).toHaveLength(1);
    expect(f.lifecycle.releaseLease).toHaveBeenCalledTimes(2);
  });
  it("resumes the exact environment before claiming with the same private ticket on retry", async () => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source); f.order.length = 0;
    let first = true;
    const original = f.setHandler(async frame => { if (frame.op === "claim" && first) { first = false; throw new Error("lost claim"); } return original(frame); });
    const ticket = "SECRET-fresh-ticket";
    await expect(f.owner.driver!.resume(source, ticket)).rejects.toThrow();
    await expect(f.owner.driver!.resume(source, ticket)).resolves.toBe("resumed");
    expect(f.order).toEqual(["resume", "resume", "claim"]); expect(f.supervision.paused).toBe(false);
    expect(f.frames.filter(x => x.op === "claim")).toEqual(Array(2).fill({ op: "claim", id: `claim_${hash(ticket)}`, parkId, bootstrapTicket: ticket }));
    expect(JSON.stringify(f.commands)).not.toContain(ticket); expect(JSON.stringify(f.owner.proof())).not.toContain(ticket);
    expect(f.commands.every(c => c[0] === SANDBOX_RUNNER_GUARDIAN_CLIENT && !c.includes(ticket))).toBe(true);
  });
  it("never claims on failed resume; absence is not a retirement or checkpoint proof", async () => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    f.lifecycle.resumeLease.mockRejectedValueOnce(new Error("resource mismatch"));
    await expect(f.owner.driver!.resume(source, "ticket")).rejects.toThrow("resource mismatch");
    f.lifecycle.resumeLease.mockResolvedValueOnce("unavailable");
    await expect(f.owner.driver!.resume(source, "ticket")).resolves.toBe("unavailable");
    expect(f.frames.some(x => x.op === "claim")).toBe(false); expect(f.owner.retiredBeforeClaim()).toBe(false);
  });
  it.each(["exact", "different-source", "different-cut", "missing-stop", "missing-state"])("requires an exact source/cut + stopped descendants + checkpoint for absence recovery: %s", async kind => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    const original = f.setHandler(async frame => frame.op !== "claim" ? original(frame) : ({ id: frame.id, status: "absent",
      identity: kind === "different-source" ? { ...source, environmentLeaseId: "other" } : source,
      lastControllerCommandSeq: kind === "different-cut" ? 5 : 4, ackedSourceSeq: 8, executionStopped: true,
      descendantsStopped: kind !== "missing-stop", sessionStateAvailable: kind !== "missing-state" }));
    await expect(f.owner.driver!.resume(source, "ticket")).resolves.toBe("unavailable");
    expect(f.owner.retiredBeforeClaim()).toBe(kind === "exact");
    if (kind === "exact") { await f.owner.retire(); expect(f.frames.some(frame => frame.op === "retire")).toBe(false); }
  });
  it.each(["wrong-id", "unknown-status", "wrong-source"])("holds unknown or contradictory guardian receipts: %s", async kind => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    const original = f.setHandler(async frame => frame.op !== "claim" ? original(frame)
      : ({ id: kind === "wrong-id" ? "unrelated" : frame.id, status: kind === "unknown-status" ? "timeout" : "conflict" }));
    await expect(f.owner.driver!.resume(source, "ticket")).rejects.toThrow("native_sandbox_runner_");
    expect(f.owner.retiredBeforeClaim()).toBe(false); expect(f.supervision.paused).toBe(true);
  });
  it("fences stale in-flight park replies before lease stop after a successor rebind", async () => {
    const f = fixture(); await qualify(f); let acknowledge!: () => void;
    const original = f.setHandler(async frame => { if (frame.op === "park") await new Promise<void>(done => { acknowledge = done; }); return original(frame); });
    const pending = f.owner.driver!.release(source); void pending.catch(() => undefined);
    await vi.waitFor(() => expect(acknowledge).toBeDefined());
    f.owner.rebind({ ...f.input }); acknowledge();
    await expect(pending).rejects.toThrow("owner_cancelled");
    expect(f.lifecycle.releaseLease).not.toHaveBeenCalled(); expect(f.order).not.toContain("close");
  });
  it("retries retirement publication after exact native retirement without signalling that process again", async () => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    const onRetired = vi.fn().mockRejectedValueOnce(new Error("write interrupted")).mockResolvedValue(undefined);
    f.owner.rebind({ ...f.input, onRetired });
    await expect(f.owner.retire()).rejects.toThrow("write interrupted");
    await f.owner.retire(); expect(onRetired).toHaveBeenCalledTimes(2);
    expect(f.frames.filter(frame => frame.op === "retire")).toHaveLength(1);
  });
  it.each(["companyId", "environmentId", "providerKey", "providerLeaseId", "scopeDigest", "accountIdentity", "credentialIdentity"] as const)("refuses a changed %s on owner rebind", async key => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    expect(() => f.owner.rebind({ ...f.input, binding: { ...binding, [key]: "different" } })).toThrow("rebound");
  });
  it("uses successor callbacks, never the first lease's stale lifecycle closure", async () => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    const next = { releaseLease: vi.fn(async () => {}), resumeLease: vi.fn(async () => "resumed" as const) };
    f.owner.rebind({ ...f.input, lifecycle: next });
    await f.owner.driver!.resume(source, "ticket"); expect(next.resumeLease).toHaveBeenCalledOnce(); expect(f.lifecycle.resumeLease).not.toHaveBeenCalled();
  });
  it("fences cancellation and late claim receipts; retirement carries the original cut and claim ID", async () => {
    const f = fixture(); await qualify(f); await f.owner.driver!.release(source);
    let claimAck!: () => void;
    const original = f.setHandler(async frame => { if (frame.op === "claim") await new Promise<void>(r => { claimAck = r; }); return original(frame); });
    const pending = f.owner.driver!.resume(source, "ticket"); void pending.catch(() => {});
    await vi.waitFor(() => expect(claimAck).toBeDefined()); const retiring = f.owner.retire(); claimAck();
    await expect(pending).rejects.toThrow("cancelled"); await retiring;
    expect(f.frames.find(x => x.op === "retire")).toMatchObject({ parkId, claimId: `claim_${hash("ticket")}`, identity: source, lastControllerCommandSeq: 4, ackedSourceSeq: 8 });
  });
  it("keys launch receipts by process nonce so a proven cold replacement can retain the durable Runner ID", async () => {
    const f = fixture(); await qualify(f);
    const original = f.setHandler(async frame => frame.op === "launch" ? { id: frame.id, status: "launched" } : original(frame));
    const request = { command: "/runtime/runnerd", args: ["--runner-id", "runner"], cwd: "/workspace", environment: { PRIVATE: "secret-launch-environment" },
      identityPath: "/state/identity", identityNonce: "process-A", diagnosticsDirectory: "/state/diagnostics" };
    await f.owner.launch(request); await f.owner.launch(request);
    const replacement = createSandboxRunnerRetention(f.input); await replacement.qualify({ runnerBinary: "/runtime/runnerd", runnerDigest: "sha256:verified" });
    await replacement.launch({ ...request, identityNonce: "process-B" });
    const launches = f.frames.filter(frame => frame.op === "launch");
    expect(launches[0]).toEqual(launches[1]); expect(launches[0]!.id).toBe(`launch_${hash("runner:process-A")}`);
    expect(launches[2]!.id).toBe(`launch_${hash("runner:process-B")}`); expect(launches[2]!.id).not.toBe(launches[0]!.id);
    expect(JSON.stringify(f.commands)).not.toContain("secret-launch-environment");
  });
  it("invalidates in-flight monitor probes, wakes on claim and locally detaches without remote-exit evidence", async () => {
    const s = createSandboxRunnerSupervision(); const before = s.generation;
    s.pause(); expect(s.accepts(before)).toBe(false); let ready = false; const waiting = s.waitUntilActive().then(() => { ready = true; });
    await Promise.resolve(); expect(ready).toBe(false); s.resume(); await waiting; expect(ready).toBe(true);
    const active = s.generation; s.detach(); expect(s.accepts(active)).toBe(false); expect(s.detached).toBe(true);
  });
});
