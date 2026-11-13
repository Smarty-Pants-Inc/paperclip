import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { encodeChannelBytes } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: trust boundary; scope confusion, cancellation races and lost-open replies
// must not be seeded against a live tenant. Real local SSH/guardian coverage is separate.
const scope = { driverKey: "boat", companyId: "company", environmentId: "environment", providerLeaseId: "bx_duplex" };
const command = ["/usr/local/libexec/paperclip-runner-guardian", "client", "--protocol", "1", "--runner-id", "runner"];
const config = { apiKey: "boat-fixture", duplexCarrier: "ssh" };
const open = (hostRouteId = "route") => ({ ...scope, hostRouteId, command });
async function fixture(scopeOverride: Partial<typeof scope> = {}) {
  const { BoatDuplexChannels } = await import("./duplex.js");
  const session = { write: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const connect = vi.fn(async () => session);
  const prepare = vi.fn(async () => ({} as any));
  const notify = { data: vi.fn(), exit: vi.fn() };
  const channels = new BoatDuplexChannels({ prepare, connect, notify, activity: async (_lease: unknown, fn: () => Promise<unknown>) => fn() });
  channels.bind({ ...scope, ...scopeOverride, config, guardianPreflight: { usable: true } });
  return { channels, session, connect, prepare, notify };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => { await plugin.definition.onShutdown!(); });

describe("Boat duplex SDK surface", () => {
  it("implements the four hooks with the S9 per-lease marker gate", async () => {
    const ctx = { logger: { info() {} }, duplexChannel: { data() {}, exit() {} } } as any;
    await plugin.definition.setup(ctx);
    expect(manifest.environmentDrivers![0].sandboxCapabilities?.duplexCommandStream).toBe(true);
    for (const name of ["onDuplexChannelOpen", "onDuplexChannelWrite", "onDuplexChannelStop", "onDuplexChannelClose"] as const) expect(plugin.definition[name]).toBeTypeOf("function");
  });
  it("binds the real Core provider-key form and refuses foreign teardown without fencing its owner", async () => {
    const driverKey = "plugin:paperclip.boat-sandbox-provider:boat";
    const f = await fixture({ driverKey });
    await f.channels.open({ ...open(), driverKey });
    await expect(f.channels.suspend({ ...scope, driverKey: "boat" })).rejects.toThrow(/scope/);
    expect(f.session.close).not.toHaveBeenCalled();
    await f.channels.suspend({ ...scope, driverKey });
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });
  it("refuses uncached leases instead of discovering a sandbox by unscoped ID", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(plugin.definition.onDuplexChannelOpen!(open())).rejects.toThrow(/lease|scope/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Boat duplex ownership", () => {
  it("refuses config-off before any key registration, even when directly called", async () => {
    const f = await fixture(); f.channels.bind({ ...scope, config: { ...config, duplexCarrier: "off" } });
    await expect(f.channels.open(open())).rejects.toMatchObject({ code: "BOAT_SSH_DISABLED" });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("preserves Core's fully qualified provider driver key instead of normalizing it to boat", async () => {
    const driverKey = "plugin:paperclip.boat-sandbox-provider:boat", f = await fixture({ driverKey });
    const channel = await f.channels.open({ ...open(), driverKey });
    await expect(f.channels.open(open("short-key"))).rejects.toThrow(/scope|lease/i);
    await expect(f.channels.suspend(scope)).rejects.toThrow(/scope/);
    await f.channels.close(channel); await f.channels.suspend({ ...scope, driverKey });
  });
  it.each(["driverKey", "companyId", "environmentId", "providerLeaseId"] as const)("refuses changed %s before network or spawn", async key => {
    const f = await fixture();
    await expect(f.channels.open({ ...open(), [key]: "foreign" })).rejects.toThrow(/scope|lease/i);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([["/bin/sh", "-c", "echo secret"], [...command, "secret"], [command[0], command[1], "/tmp/attacker.sock"], ["node", ...command.slice(1)]])("refuses untrusted argv", async argv => {
    const f = await fixture();
    await expect(f.channels.open({ ...open(), command: argv })).rejects.toThrow(/command/i);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("does not replace a cached allocation with a foreign scope or account", async () => {
    const f = await fixture();
    expect(() => f.channels.bind({ ...scope, companyId: "other", config })).toThrow(/scope/);
    expect(() => f.channels.bind({ ...scope, config: { apiKey: "other-account" } })).toThrow(/scope/);
  });
  it("binds notifications and writes to the exact live pair", async () => {
    const f = await fixture(); const result = await f.channels.open(open());
    await f.channels.write({ ...result, data: encodeChannelBytes(Buffer.from("frame\n")) });
    expect(Buffer.from(f.session.write.mock.calls[0][0])).toEqual(Buffer.from("frame\n"));
    await expect(f.channels.write({ ...result, hostRouteId: "foreign", data: encodeChannelBytes(Buffer.from("secret\n")) })).rejects.toThrow(/route/);
    await expect(f.channels.stop({ ...result, workerSessionId: "foreign" })).rejects.toThrow(/route/);
    expect(f.session.write).toHaveBeenCalledTimes(1); expect(f.session.close).not.toHaveBeenCalled();
    const callbacks = f.connect.mock.calls[0][2]; callbacks.data(Buffer.from("reply\n")); callbacks.exit({ exitCode: 0 });
    expect(f.notify.data).toHaveBeenCalledWith(result.hostRouteId, result.workerSessionId, Buffer.from("reply\n"));
    expect(f.notify.exit).toHaveBeenCalledWith(result.hostRouteId, result.workerSessionId, 0, undefined);
  });
  it("closes a lost-open reply by host route and ignores the nonauthoritative session ID", async () => {
    const f = await fixture(); const bound = await f.channels.open(open());
    expect(await f.channels.close({ hostRouteId: "route", workerSessionId: "not-authoritative" })).toEqual(bound);
    expect(await f.channels.close({ hostRouteId: "route" })).toEqual(bound);
    expect(f.session.close).toHaveBeenCalledTimes(1);
    await expect(f.channels.open(open())).rejects.toThrow(/used|closed/);
  });
  it("fences close-before-open so a delayed open cannot create a child", async () => {
    const f = await fixture(); expect(await f.channels.close({ hostRouteId: "route" })).toEqual({ hostRouteId: "route" });
    await expect(f.channels.open(open())).rejects.toThrow(/used|closed/); expect(f.prepare).not.toHaveBeenCalled();
  });
  it("reserves the route before asynchronous setup and cancels in-flight open", async () => {
    const f = await fixture(); let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    f.prepare.mockImplementationOnce(async () => { await wait; return {} as any; });
    const pending = f.channels.open(open()).catch(e => e);
    await expect(f.channels.open(open())).rejects.toThrow(/used/);
    const closing = f.channels.close({ hostRouteId: "route" }); finish();
    expect(await pending).toBeInstanceOf(Error); await closing;
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("closes the child when cancellation races with connect", async () => {
    const f = await fixture(); let finish!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    f.connect.mockImplementationOnce(async () => { entered(); await wait; return f.session; });
    const pending = f.channels.open(open()).catch(e => e); await started;
    const closing = f.channels.close({ hostRouteId: "route" }); finish();
    expect(await pending).toBeInstanceOf(Error); await closing; expect(f.session.close).toHaveBeenCalledTimes(1);
  });
  it("shares one pending teardown between concurrent route-only closes", async () => {
    const f = await fixture(); const result = await f.channels.open(open());
    let finish!: () => void;
    f.session.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const a = f.channels.close({ hostRouteId: "route" }), b = f.channels.close({ hostRouteId: "route" });
    await vi.waitFor(() => expect(f.session.close).toHaveBeenCalledTimes(1)); finish();
    expect(await a).toEqual(result); expect(await b).toEqual(result);
  });
  it("does not acknowledge an uncertain close; exact route retry reconciles it", async () => {
    const f = await fixture(); await f.channels.open(open()); f.session.close.mockRejectedValueOnce(new Error("private transport details"));
    await expect(f.channels.close({ hostRouteId: "route" })).rejects.toThrow(/close/i);
    expect(await f.channels.close({ hostRouteId: "route" })).toHaveProperty("workerSessionId");
    expect(f.session.close).toHaveBeenCalledTimes(2);
  });
  it("bounds bytes and refuses malformed wire values without forwarding them", async () => {
    const f = await fixture(); const result = await f.channels.open(open());
    for (const data of ["not base64!!!", encodeChannelBytes(Buffer.alloc(65537))]) await expect(f.channels.write({ ...result, data })).rejects.toThrow(/bytes|limit/i);
    expect(f.session.write).not.toHaveBeenCalled();
  });
  it("fences release, drains all clients, then permits exact successful rebind", async () => {
    const f = await fixture(); await f.channels.open(open()); await f.channels.suspend(scope);
    expect(f.session.close).toHaveBeenCalledTimes(1);
    await expect(f.channels.open(open("after-stop"))).rejects.toThrow(/lease/i);
    f.channels.bind({ ...scope, config, guardianPreflight: { usable: true } }); await f.channels.open(open("after-resume"));
    await f.channels.shutdown(); expect(f.session.close).toHaveBeenCalledTimes(2);
  });
  it("denies teardown with changed account or scope without touching a live client", async () => {
    const f = await fixture(); await f.channels.open(open());
    await expect(f.channels.suspend({ ...scope, config: { apiKey: "other" } })).rejects.toThrow(/scope/);
    await expect(f.channels.suspend({ ...scope, companyId: "other" })).rejects.toThrow(/scope/);
    expect(f.session.close).not.toHaveBeenCalled(); await f.channels.shutdown();
  });
  it("bounds pending/live connections and reclaims only settled destroyed leases", async () => {
    const f = await fixture();
    for (let i = 0; i < 32; i++) await f.channels.open(open(`live-${i}`));
    await expect(f.channels.open(open("over-limit"))).rejects.toThrow(/limit/);
    await f.channels.close({ hostRouteId: "live-0" }); await f.channels.open(open("within-limit"));
    expect(() => f.channels.forgetDestroyed({ ...scope, config })).toThrow(/settled/);
    await f.channels.suspend({ ...scope, config }); f.channels.forgetDestroyed({ ...scope, config });
    await expect(f.channels.open(open("after-destroy"))).rejects.toThrow(/lease/i);
    f.channels.bind({ ...scope, config, guardianPreflight: { usable: true } }); await f.channels.open(open("new-owned-allocation")); await f.channels.shutdown();
  });
  it("evicts only settled oldest tombstones and preserves recent duplicate fences", async () => {
    const f = await fixture(); for (let i = 0; i < 8200; i++) {
      const route = await f.channels.open(open(`closed-${i}`)); await f.channels.close(route);
    }
    await expect(f.channels.open(open("closed-8199"))).rejects.toThrow(/used|closed/);
    await f.channels.open(open("new-route")); await f.channels.shutdown();
  });
});
