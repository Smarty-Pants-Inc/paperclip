import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { REMOTE_RUNNER_IDENTITY_READY_SCRIPT } from "./remote-runner-readiness.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-readiness-")); roots.push(root);
  const path = join(root, "runner-process.identity");
  const marker = (nonce = "selected") => `${nonce}\n4321\n2026-11-12T22:12:00.000Z\nrunner-selected\nlinux:abcd-1234:100\n`;
  const wait = (timeout = 1000, fingerprint = true, prefix = "") => exec(process.execPath,
    ["-e", prefix + REMOTE_RUNNER_IDENTITY_READY_SCRIPT, "paperclip-runner-process-identity", path, "selected", "runner-selected", String(timeout), String(fingerprint)], { timeout: 5000 });
  const publish = async (content = marker()) => { await writeFile(`${path}.tmp`, content); await rename(`${path}.tmp`, path); };
  return { root, path, marker, wait, publish };
}

// Keep: trust boundary. Readiness never authorizes a different launch nonce,
// runner, unsafe marker, or process generation. The server parses it again.
it("returns an already-published exact marker without waiting for an event", async () => {
  const f = await fixture(); await f.publish();
  expect((await f.wait()).stdout).toBe(f.marker());
});

it("wakes on the launch writer's atomic rename instead of a controller poll", async () => {
  const f = await fixture();
  // Publish only after the child has subscribed and completed its initial read.
  // The outer process timeout is shorter than the final-read deadline, so a
  // missing event cannot pass merely by finding the marker at that deadline.
  const publication = `
const notificationFs = require("node:fs"), watchDirectory = notificationFs.watch;
notificationFs.watch = (...args) => {
  const watcher = watchDirectory(...args);
  setTimeout(() => {
    notificationFs.writeFileSync(${JSON.stringify(`${f.path}.tmp`)}, ${JSON.stringify(f.marker())});
    notificationFs.renameSync(${JSON.stringify(`${f.path}.tmp`)}, ${JSON.stringify(f.path)});
  }, 50);
  return watcher;
};
`;
  expect((await f.wait(15000, true, publication)).stdout).toBe(f.marker());
});

it("reads an exact published marker even when directory notifications are unavailable", async () => {
  const f = await fixture(); await f.publish();
  const unavailable = 'require("node:fs").watch = () => { throw new Error("watch unavailable"); };\n';
  expect((await f.wait(1000, true, unavailable)).stdout).toBe(f.marker());
});

it("uses the bounded final read when notifications cannot be installed", async () => {
  const f = await fixture();
  const publication = `
require("node:fs").watch = () => { throw new Error("watch unavailable"); };
setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(f.path)}, ${JSON.stringify(f.marker())}), 50);
`;
  expect((await f.wait(150, true, publication)).stdout).toBe(f.marker());
});

it("ignores an old launch and unrelated directory events until the exact marker arrives", async () => {
  const f = await fixture(); await f.publish(f.marker("previous-launch"));
  const waiting = f.wait(); void waiting.catch(() => undefined);
  await mkdir(join(f.root, "unrelated"));
  await new Promise(resolve => setTimeout(resolve, 100));
  await f.publish();
  expect((await waiting).stdout).toBe(f.marker());
});

it.each(["symlink", "wrong runner", "missing fingerprint"])("refuses readiness for %s", async kind => {
  const f = await fixture();
  if (kind === "symlink") { await writeFile(join(f.root, "outside"), f.marker()); await symlink(join(f.root, "outside"), f.path); }
  else await f.publish(kind === "wrong runner" ? f.marker().replace("runner-selected", "other-runner") : f.marker().replace("linux:abcd-1234:100\n", ""));
  await expect(f.wait(40)).rejects.toMatchObject({ code: 3 });
});
