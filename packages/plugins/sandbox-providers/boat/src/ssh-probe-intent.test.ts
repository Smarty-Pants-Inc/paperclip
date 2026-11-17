import { afterEach, expect, it, vi } from "vitest";
import { BoatSshCarrier } from "./ssh-carrier.js";
import { OwnedSshAgent } from "./ssh-agent.js";
import { editGuestKey, IMAGE_PREFLIGHT } from "./ssh-keys.js";

// Keep: data-safety boundary. An individual read is repeatable; the same API's
// key editor is not. No SSH, agent process, generated credential, or network.
afterEach(() => vi.restoreAllMocks());
it("R6 SSH existence check alone opts into idempotent_probe before SSH/key installation", async () => {
  vi.spyOn(OwnedSshAgent.prototype, "start").mockResolvedValue({} as any);
  const run = vi.fn(async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "" }));
  const request = vi.fn();
  const carrier = new BoatSshCarrier(() => ({ run, request }));
  const lease = { driverKey: "boat", companyId: "c", environmentId: "e", providerLeaseId: "bx_intent",
    config: { duplexCarrier: "ssh" }, runnerId: "r", guardianPreflight: { usable: true } } as any;
  await expect(carrier.prepare(lease)).rejects.toMatchObject({ code: "BOAT_SSH_PREFLIGHT_FAILED" });
  expect(run).toHaveBeenCalledExactlyOnceWith(IMAGE_PREFLIGHT, 10_000, undefined, { intent: "idempotent_probe" });
  expect(request).not.toHaveBeenCalled(); // fail before registration or any SSH
});
it("R6 guardian health is an explicit read on the otherwise mixed SSH adapter", async () => {
  const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: '{"ok":true,"result":{"state":"empty"}}', stderr: "" }));
  const carrier = new BoatSshCarrier(() => ({ run, request: vi.fn() }));
  await expect(carrier.health({} as any)).resolves.toBeUndefined();
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("paperclip-guardian:health"), 10_000, undefined, { intent: "idempotent_probe" });
});
it("R6 key mutation through that same adapter has no repeatable intent", async () => {
  const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }));
  await editGuestKey({ run, request: vi.fn(async () => ({})) }, "bx_intent",
    { workerId: "worker", publicKey: "ssh-ed25519 YQ==", expiresAt: 2000, runnerId: "r" }, false);
  expect(run).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("/usr/bin/flock"), 15_000, undefined);
});
