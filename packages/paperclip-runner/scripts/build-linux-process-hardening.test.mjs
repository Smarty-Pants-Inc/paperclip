import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { buildLinuxProcessHardening } from "./build-linux-process-hardening.mjs";

// Keep reason: the credential-bearing proxy must harden THIS post-exec process,
// fail closed on missing/tampered pack code, and retain /proc/self/fd access.
test("Linux proxy isolation artifact and fail-closed loader", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-process-hardening-"));
  try {
    const cli = join(root, "dist/cli");
    mkdirSync(cli, { recursive: true });
    const native = buildLinuxProcessHardening(join(cli, "linux-process-hardening.node"));
    const original = readFileSync(native);
    const manifest = { payload: { artifacts: { piProcessHardening: {
      path: "dist/cli/linux-process-hardening.node",
      sha256: `sha256:${createHash("sha256").update(original).digest("hex")}`,
    } } } };
    const manifestPath = join(root, "provider-pack.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli/linux-process-hardening.ts");
    const guard = join(root, "guard.mjs");
    writeFileSync(guard, transformSync(readFileSync(source, "utf8"), { loader: "ts", format: "esm", target: "node22" }).code);
    const entrypoint = pathToFileURL(join(cli, "pi-rpc-app-server-proxy.cjs")).href;
    const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { protectPiProxyProcess } from ${JSON.stringify(pathToFileURL(guard).href)};
      import { readdirSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      protectPiProxyProcess(${JSON.stringify(entrypoint)});
      const peer = spawnSync('/bin/cat', ['/proc/' + process.pid + '/environ'], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ peerStatus: peer.status, peerDenied: peer.stderr.includes('Permission denied'),
        selfFdAccessible: readdirSync('/proc/self/fd').length > 0,
        ownEnvironmentRetained: process.env.PI_ISOLATION_DECOY === 'fixture' }));
    `], { encoding: "utf8", env: { PATH: process.env.PATH, PI_ISOLATION_DECOY: "fixture" }, timeout: 10_000 });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { peerStatus: 1, peerDenied: true, selfFdAccessible: true, ownEnvironmentRetained: true });

    writeFileSync(native, Buffer.concat([original, Buffer.from("tampered")]));
    const tampered = run();
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /integrity check failed/);
    writeFileSync(native, original);
    chmodSync(native, 0o666);
    assert.match(run().stderr, /not a trusted regular file/);
    chmodSync(native, 0o644);
    rmSync(native);
    assert.match(run().stderr, /ENOENT/);
    writeFileSync(native, original, { mode: 0o644 });
    writeFileSync(manifestPath, JSON.stringify({ payload: { artifacts: {} } }));
    assert.match(run().stderr, /integrity check failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
