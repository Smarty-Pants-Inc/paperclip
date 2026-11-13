// Keep: SSH trust boundary, key revocation, and ambiguous host-control reply data safety.
import { afterEach, expect, it } from "vitest";
import { readFile, readdir, stat } from "node:fs/promises";
import { OwnedSshAgent } from "./ssh-agent.js";
import { mergeAuthorizedKeys, forcedKeyLine } from "./ssh-keys.js";
import { parseSshEndpoint } from "./ssh-carrier.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("keeps an ed25519 private key in the owned agent, not argv, env or files", async () => {
  const agent = new OwnedSshAgent(); cleanups.push(() => agent.close());
  const ready = await agent.start();
  expect(ready.publicKey).toMatch(/^ssh-ed25519 /);
  expect((await stat(ready.dir)).mode & 0o777).toBe(0o700);
  expect(await readdir(ready.dir)).toEqual(["agent.sock", "identity.pub"]);
  expect((await readFile(ready.publicFile, "utf8")).trim()).toBe(ready.publicKey);
  expect((await readFile(`/proc/${ready.pid}/cmdline`, "utf8"))).not.toMatch(/PRIVATE|ssh-ed25519/);
});
it("pins only validated API values; prefers the proxy endpoint and rejects option injection", () => {
  expect(parseSshEndpoint({hostKey: "ssh-ed25519 AAAA", sshEndpoint: "203.0.113.1:2222", machineIp: "10.0.0.1", sshUser: "user"})).toEqual({host: "203.0.113.1", port: 2222, user: "user", hostKey: "ssh-ed25519 AAAA"});
  expect(parseSshEndpoint({hostKey: "ssh-ed25519 AAAA", machineIp: "10.0.0.1"}).port).toBe(22);
  for (const hostKey of [undefined, "", "ssh-ed25519 AAAA\n* ssh-rsa AAAA"]) expect(() => parseSshEndpoint({hostKey, machineIp:"10.0.0.1"})).toThrow();
  expect(() => parseSshEndpoint({hostKey:"ssh-ed25519 AAAA", sshEndpoint:"-oProxyCommand=bad:22"})).toThrow();
});
it("merges two workers, retires only the exact owner, and bounds abandoned marked keys", () => {
  const a = {workerId:"worker-a", publicKey:"ssh-ed25519 YQ==", expiresAt:2000, runnerId:"runner"};
  const b = {workerId:"worker-b", publicKey:"ssh-ed25519 Yg==", expiresAt:2000, runnerId:"runner"};
  const unrelated = 'ssh-ed25519 dW5yZWxhdGVk operator\n';
  const first = mergeAuthorizedKeys(unrelated + a.publicKey + "\n", a, false, 1000);
  expect(first).toContain(forcedKeyLine(a));
  const second = mergeAuthorizedKeys(first + b.publicKey + "\n", b, false, 1000);
  expect(second).toContain(forcedKeyLine(a)); expect(second).toContain(forcedKeyLine(b));
  const retired = mergeAuthorizedKeys(second, a, true, 1000);
  expect(retired).toBe(unrelated + forcedKeyLine(b) + "\n");
  expect(mergeAuthorizedKeys(second, b, true, 3000)).toBe(unrelated);
});
it.each([undefined, "", "r;id", "r\"", "r\n", "r".repeat(129)])("rejects invalid Runner binding %j before writing a forced key", runnerId => {
  expect(() => forcedKeyLine({workerId:"worker",publicKey:"ssh-ed25519 YQ==",expiresAt:2000,runnerId:runnerId as string})).toThrow("BOAT_SSH_INVALID_RUNNER");
});
it("bounds abandoned worker entries at 32 without removing an unmarked foreign key", () => {
  const foreign = 'ssh-ed25519 Zm9yZWlnbg== operator-key\n';
  let text = foreign;
  for (let i=0;i<32;i++) text = mergeAuthorizedKeys(text,{workerId:`worker-${i}`,publicKey:`ssh-ed25519 ${Buffer.from(`key-${i}`).toString("base64")}`,expiresAt:2000,runnerId:"runner"},false,1000);
  const extra={workerId:"worker-extra",publicKey:"ssh-ed25519 ZXh0cmE=",expiresAt:2000,runnerId:"runner"};
  expect(() => mergeAuthorizedKeys(text,extra,false,1000)).toThrow("BOAT_SSH_KEY_LIMIT");
  expect(mergeAuthorizedKeys(text,extra,false,3000)).toBe(foreign+forcedKeyLine(extra)+"\n");
  // Even an unmarked copy of our key is never removed by retirement.
  expect(mergeAuthorizedKeys(foreign+extra.publicKey+"\n",extra,true,1000)).toBe(foreign+extra.publicKey+"\n");
});
