import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { readGuardianPreflightFailure, GUARDIAN_FILES, GUARDIAN_DIRECTORY, GUARDIAN_UPLOAD_DIRECTORY } from "./guardian-stage.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: secret-bearing provider boundary and failure paths that cannot be
// exercised on live Boat in this task. These are not live continuity proofs.
const names = GUARDIAN_FILES;
const guest = GUARDIAN_DIRECTORY;
const uploadDir = GUARDIAN_UPLOAD_DIRECTORY;
const bootId = "11111111-1111-4111-8111-111111111111";
const oldBoot = "22222222-2222-4222-8222-222222222222";
const secret = "CANARY-API-SECRET-NOT-IN-COMMANDS-OR-ASSETS";
const signedSecret = "CANARY-SIGNED-URL-NOT-IN-COMMANDS";
const assets = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(`../guest/${name}`, import.meta.url))] as const)));
const hashes = Object.fromEntries(names.map(name => [name, createHash("sha256").update(assets[name]).digest("hex")]));
const base = { driverKey: "boat", companyId: "company", environmentId: "environment", config: { apiKey: secret, duplexCarrier: "ssh" } };
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mockBoat(options: { staged?: boolean; nodeVersion?: string; fail?: string; state?: string; badReply?: boolean; poisonHash?: boolean } = {}) {
  const commands: string[] = [], uploads: { path: string; bytes: Buffer; headers: Headers }[] = [];
  const disk = new Map<string, Buffer>(options.staged ? names.map(name => [`${guest}/${name}`, assets[name]]) : []);
  const signed = new Map<string, string>();
  let deleted = false, stopped = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url), method = init.method ?? "GET";
    if (signed.has(u)) {
      if (options.fail === "upload") return ok({ message: secret }, 500);
      const path = signed.get(u)!, bytes = Buffer.from(init.body as Uint8Array);
      uploads.push({ path, bytes, headers: new Headers(init.headers) }); disk.set(path, bytes);
      return ok({ ok: true });
    }
    if (u.endsWith("/files/upload-url")) {
      const path = JSON.parse(init.body as string).path;
      if (options.fail === "url") return ok({ url: `http://invalid.test/${signedSecret}` });
      const url = `https://upload.test/${signed.size}?token=${signedSecret}`;
      signed.set(url, path); return ok({ url, method: "PUT", path });
    }
    if (u.endsWith("/files") && method === "PUT") {
      const file = JSON.parse(init.body as string); disk.set(file.path, Buffer.from(file.content)); return ok({ ok: true });
    }
    if (u.endsWith("/commands") && method === "POST") {
      const command = JSON.parse(init.body as string).command;
      commands.push(command);
      if (command.startsWith("cat '")) return ok({ exitCode: 0, stdout: disk.get(command.slice(5, -1))?.toString() ?? "" });
      if (options.fail && command.includes(`paperclip-guardian:${options.fail}`)) return ok({ exitCode: 1, stderr: secret, stdout: signedSecret });
      if (command.includes("paperclip-guardian:seal")) for (const name of names) if (disk.has(`${uploadDir}/${name}`)) disk.set(`${guest}/${name}`, disk.get(`${uploadDir}/${name}`)!);
      if (command.includes("paperclip-guardian:probe")) return ok({ exitCode: 0, stdout: JSON.stringify({
        nodeVersion: options.nodeVersion ?? "24.11.0", bootId, installed: names.every(name => disk.has(`${guest}/${name}`)),
        hashes: Object.fromEntries(names.map(name => [name, disk.has(`${guest}/${name}`) ? (options.poisonHash ? "0".repeat(64) : hashes[name]) : null])),
      }) });
      if (command.includes("paperclip-guardian:preflight")) return ok({ exitCode: 0, stdout: options.badReply ? secret : JSON.stringify({ ok: true, result: options.state === "running" || options.state === "exited" ? {
        state: options.state, pid: 123, startTime: "456", bootId, generation: "33333333-3333-4333-8333-333333333333", code: null, signal: null,
      } : { state: options.state ?? "empty" } }) });
      return ok({ exitCode: 0, stdout: "", stderr: "" });
    }
    if (u.endsWith("/sandboxes") && method === "POST") return ok({ sandbox: { id: "bx_guardian" } });
    if (u.endsWith("/resume")) return ok({ sandbox: { id: "bx_guardian" } });
    if (u.endsWith('/stop') && method === 'POST') { stopped = true; return ok({ operation: { id: 'stop' } }); }
    if (method === "DELETE") { deleted = true; throw new Error('Unexpected DELETE'); }
    if (u.endsWith("/sandboxes/bx_guardian")) return ok({ sandbox: { id: "bx_guardian", state: stopped ? "archived" : "ready", ...(stopped ? { stop: { id: "stop", status: "completed" } } : {}) } });
    throw new Error(`Unexpected mock route: ${method} ${new URL(u).pathname}`);
  }));
  return { commands, uploads, disk, get deleted() { return deleted; }, get stopped() { return stopped; } };
}
afterEach(() => vi.unstubAllGlobals());

describe("guardian staging through Boat lease hooks", () => {
  it("does nothing when duplexCarrier is absent", async () => {
    const boat = mockBoat();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...base, config: { apiKey: secret } });
    expect(lease.metadata?.guardianPreflight).toBeUndefined();
    expect(boat.commands).toEqual([]); expect(boat.uploads).toEqual([]);
  });
  it("preserves opt-in through config normalization and rejects unknown carriers", async () => {
    expect(await plugin.definition.onEnvironmentValidateConfig!(base)).toMatchObject({ ok: true, normalizedConfig: { duplexCarrier: "ssh" } });
    expect(await plugin.definition.onEnvironmentValidateConfig!({ ...base, config: { ...base.config, duplexCarrier: "shell" } })).toMatchObject({ ok: false });
  });
  it("uploads exact packed guest bytes, installs the user unit, and returns typed preflight", async () => {
    const boat = mockBoat();
    const lease = await plugin.definition.onEnvironmentAcquireLease!(base);
    expect(lease.metadata?.guardianPreflight).toMatchObject({ schema: "paperclip/boat-guardian-preflight/v1", usable: true,
      pluginVersion: manifest.version, guestDirectory: guest, nodeVersion: "24.11.0", bootId,
      hashes, unit: "paperclip-guardian.service", active: true, status: { state: "empty" }, machine: "unknown", coldStartRequired: true });
    expect(lease.metadata?.runnerGuardianVersion).toBe(1);
    expect(boat.uploads).toHaveLength(8);
    for (const name of names) expect(boat.uploads.find(upload => upload.path === `${uploadDir}/${name}`)?.bytes).toEqual(assets[name]);
    for (const upload of boat.uploads) {
      expect(upload.headers.has("authorization")).toBe(false);
      expect(upload.bytes.toString()).not.toContain(secret); expect(upload.bytes.toString()).not.toContain(signedSecret);
    }
    expect(boat.commands.some(command => command.includes("daemon-reload") && command.includes("enable --now paperclip-guardian"))).toBe(true);
    for (const command of boat.commands) { expect(command).not.toContain(secret); expect(command).not.toContain(signedSecret); }
    expect(JSON.stringify(lease.metadata?.guardianPreflight)).not.toContain(secret);
  });
  it("skips all uploads when the one hash probe matches", async () => {
    const boat = mockBoat({ staged: true });
    const lease = await plugin.definition.onEnvironmentAcquireLease!(base);
    expect(lease.metadata?.guardianPreflight).toMatchObject({ usable: true });
    expect(boat.uploads).toEqual([]);
    expect(boat.commands.filter(command => command.includes("paperclip-guardian:probe"))).toHaveLength(1);
  });
  it("repairs a partial guest directory and verifies again before service start", async () => {
    const boat = mockBoat({ staged: true }); boat.disk.delete(`${guest}/protocol.mjs`);
    await plugin.definition.onEnvironmentAcquireLease!(base);
    expect(boat.uploads.map(upload => upload.path)).toEqual(names.map(name => `${uploadDir}/${name}`));
    const probes = boat.commands.map((c, i) => c.includes("paperclip-guardian:probe") ? i : -1).filter(i => i >= 0);
    expect(probes).toHaveLength(2);
    expect(boat.commands.findIndex(c => c.includes("paperclip-guardian:service"))).toBeGreaterThan(probes[1]);
  });
  it.each(["24.10.9", "22.20.0", "not-a-version"])("fails closed for unsupported node %s before upload", async nodeVersion => {
    const boat = mockBoat({ nodeVersion });
    await expect(plugin.definition.onEnvironmentAcquireLease!(base)).rejects.toMatchObject({ code: "BOAT_GUARDIAN_NODE_UNSUPPORTED", data: { usable: false } });
    expect(boat.uploads).toEqual([]); expect(boat.stopped).toBe(true); expect(boat.deleted).toBe(false);
  });
  it.each(["probe", "prepare", "upload", "url", "service", "preflight"])("keeps %s failures typed and body-free, with acquire cleanup", async fail => {
    const boat = mockBoat({ fail });
    const error = await plugin.definition.onEnvironmentAcquireLease!(base).then(() => null, error => error);
    expect(error).toMatchObject({ name: "BoatGuardianPreflightError", data: { schema: "paperclip/boat-guardian-preflight-error/v1", usable: false } });
    expect(`${error?.message} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(`${error?.message} ${JSON.stringify(error)}`).not.toContain(signedSecret);
    expect(boat.stopped).toBe(true); expect(boat.deleted).toBe(false);
  });
  it("rejects uploaded hash mismatch instead of starting an unverified guardian", async () => {
    const boat = mockBoat({ poisonHash: true });
    await expect(plugin.definition.onEnvironmentAcquireLease!(base)).rejects.toMatchObject({ code: "BOAT_GUARDIAN_HASH_MISMATCH" });
    expect(boat.commands.some(c => c.includes("paperclip-guardian:service"))).toBe(false);
  });
  it.each([{ badReply: true }, { state: "invented" }])("rejects invalid guardian status without echoing its body (%j)", async options => {
    mockBoat(options);
    await expect(plugin.definition.onEnvironmentAcquireLease!(base)).rejects.toMatchObject({ code: "BOAT_GUARDIAN_STATUS_INVALID" });
  });
  it.each([
    { previous: { boot_id: oldBoot }, state: "empty", machine: "new", cold: true },
    { previous: { boot_id: bootId }, state: "running", machine: "same", cold: false },
    { previous: { guardianPreflight: { bootId } }, state: "empty", machine: "same", cold: true },
    { previous: {}, state: "empty", machine: "unknown", cold: true },
    { previous: { boot_id: bootId }, state: "exited", machine: "same", cold: false },
  ])("rechecks resume and reports boot/empty-state cold-start evidence (%j)", async row => {
    const boat = mockBoat({ staged: true, state: row.state });
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...base, providerLeaseId: "bx_guardian", leaseMetadata: row.previous });
    expect(lease.metadata?.guardianPreflight).toMatchObject({ usable: true, bootId, machine: row.machine, coldStartRequired: row.cold, status: { state: row.state } });
    expect(boat.uploads).toEqual([]);
    expect(boat.commands.some(c => c.includes("restart"))).toBe(false);
  });
  it("runs acquire then resume on the scoped reusable Runner lease, after workspace proof", async () => {
    const options = { state: "empty" }, boat = mockBoat(options);
    const scoped = { ...base, config: { ...base.config, reuseLease: true }, agentId: "agent", executionWorkspaceId: "workspace", adapterType: "paperclip_runner" };
    const lease = await plugin.definition.onEnvironmentAcquireLease!(scoped);
    expect(lease.metadata?.workspaceSentinel).toMatchObject({ result: "written" });
    options.state = "running";
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...scoped, providerLeaseId: "bx_guardian", leaseMetadata: lease.metadata });
    expect(resumed.metadata?.workspaceSentinel).toMatchObject({ result: "matched" });
    expect(resumed.metadata?.guardianPreflight).toMatchObject({ usable: true, machine: "same", coldStartRequired: false, status: { state: "running" } });
    expect(boat.uploads).toHaveLength(8);
    expect(resumed.metadata?.runnerGuardianVersion).toBe(1);
    const verification = boat.commands.findIndex(command => command.startsWith("cat '"));
    expect(verification).toBeGreaterThan(0);
    expect(boat.commands.slice(verification + 1).some(command => command.includes("paperclip-guardian:preflight"))).toBe(true);
  });
  it("removes stale usable metadata when the carrier is disabled on resume", async () => {
    const boat = mockBoat();
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...base, config: { apiKey: secret }, providerLeaseId: "bx_guardian", leaseMetadata: { guardianPreflight: { usable: true } } });
    expect(lease.metadata?.guardianPreflight).toBeUndefined(); expect(boat.commands).toEqual([]); expect(boat.uploads).toEqual([]);
  });
  it("does not return stale usable metadata or delete a retained lease on resume failure", async () => {
    const boat = mockBoat({ staged: true, fail: "preflight" });
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...base, providerLeaseId: "bx_guardian", leaseMetadata: { guardianPreflight: { usable: true } } })).rejects.toMatchObject({ data: { usable: false } });
    expect(boat.deleted).toBe(false);
  });
  it("keeps preflight and typed body-free refusal recognizable through the real SDK worker RPC", async () => {
    mockBoat({ staged: true });
    const input = new PassThrough(), output = new PassThrough(), lines = createInterface({ input: output });
    const pending = new Map<string, { resolve(value: any): void; reject(error: any): void; timer: NodeJS.Timeout }>();
    const host = startWorkerRpcHost({ plugin, stdin: input, stdout: output, rpcTimeoutMs: 1000 });
    let sequence = 0;
    lines.on("line", line => {
      const message = JSON.parse(line), call = pending.get(message.id);
      if (call) { pending.delete(message.id); clearTimeout(call.timer); if (message.error) call.reject(message.error); else call.resolve(message.result); }
      else if (message.method && message.id !== undefined) input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }) + "\n");
    });
    const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = `guardian-${++sequence}`, timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout")); }, 3000);
      pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    try {
      await rpc("initialize", { manifest, config: {}, apiVersion: 1, instanceInfo: { instanceId: "guardian-staging", hostVersion: "0.3.0-canary.12" } });
      const lease = await rpc("environmentAcquireLease", base);
      expect(lease.metadata.guardianPreflight).toMatchObject({ usable: true, hashes, status: { state: "empty" } });
      mockBoat({ staged: true, fail: "preflight" });
      const error = await rpc("environmentResumeLease", { ...base, providerLeaseId: "bx_guardian", leaseMetadata: { guardianPreflight: lease.metadata.guardianPreflight } }).then(() => null, error => error);
      // SDK intentionally does not forward arbitrary provider .data. The
      // closed message code, and this reader, preserve the typed refusal.
      expect(readGuardianPreflightFailure(error)).toEqual({ schema: "paperclip/boat-guardian-preflight-error/v1", code: "BOAT_GUARDIAN_PREFLIGHT_FAILED", usable: false });
      expect(JSON.stringify(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(signedSecret);
      expect(readGuardianPreflightFailure({ message: "BOAT_GUARDIAN_PREFLIGHT_FAILED extra text" })).toBeUndefined();
    } finally {
      for (const call of pending.values()) clearTimeout(call.timer);
      host.stop(); lines.close(); input.destroy(); output.destroy();
    }
  });
});
