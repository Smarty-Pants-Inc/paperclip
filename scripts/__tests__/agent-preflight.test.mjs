import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PLUGIN_SDK_BUILD_MARKERS, pluginSdkBuildStep } from "../agent-preflight.mjs";

// A worktree with the real ensure-plugin-build-deps script and a stand-in
// compiler that emits dist/index.js next to the tsconfig it is given.
function worktree(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(new URL("../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  mkdirSync(path.dirname(compiler), { recursive: true });
  writeFileSync(compiler, `
const fs = require("node:fs");
const path = require("node:path");
const target = path.dirname(process.argv[3]);
if (fs.existsSync("fail")) process.exit(2);
fs.appendFileSync("builds", path.relative(process.cwd(), target) + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
fs.writeFileSync(path.join(target, "dist/index.js"), "export {};\\n");
`);
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    mkdirSync(path.join(root, target, "src"), { recursive: true });
    writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const builds = () => existsSync(path.join(root, "builds"))
    ? readFileSync(path.join(root, "builds"), "utf8").trim().split("\n") : [];
  return { root, builds };
}

test("a fresh worktree gets the plugin SDK and its shared dependency built", t => {
  const { root, builds } = worktree(t);
  const result = pluginSdkBuildStep(root);
  assert.equal(result.step, "plugin-sdk");
  assert.equal(result.action, "built");
  assert.deepEqual(builds(), ["packages/shared", "packages/plugins/sdk"]);
  for (const marker of PLUGIN_SDK_BUILD_MARKERS) assert.ok(existsSync(path.join(root, marker)), marker);
  assert.ok(existsSync(path.join(root, "packages/plugins/sdk/dist/index.js")));
});

test("unchanged sources skip the build and a source change rebuilds", t => {
  const { root, builds } = worktree(t);
  pluginSdkBuildStep(root);
  assert.equal(pluginSdkBuildStep(root).action, "skipped");
  assert.equal(builds().length, 2);

  writeFileSync(path.join(root, "packages/plugins/sdk/src/index.ts"), "export const changed = true;\n");
  assert.equal(pluginSdkBuildStep(root).action, "built");
  assert.deepEqual(builds().slice(2), ["packages/plugins/sdk"]);
});

test("a missing SDK dist is rebuilt even when the shared build is current", t => {
  const { root, builds } = worktree(t);
  pluginSdkBuildStep(root);
  rmSync(path.join(root, "packages/plugins/sdk/dist"), { recursive: true, force: true });
  assert.equal(pluginSdkBuildStep(root).action, "built");
  assert.deepEqual(builds().slice(2), ["packages/plugins/sdk"]);
});

test("a failed build fails the preflight", t => {
  const { root } = worktree(t);
  writeFileSync(path.join(root, "fail"), "");
  assert.throws(() => pluginSdkBuildStep(root), /ensure-plugin-build-deps\.mjs failed/);
});

test("a build that reports success without its outputs fails the preflight", t => {
  const { root } = worktree(t);
  assert.throws(() => pluginSdkBuildStep(root, () => 0), /no completion marker/);
});

test("workspace link preflight repairs links without server code or build outputs", t => {
  const rootDir = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = mkdtempSync(path.join(os.tmpdir(), "workspace-links-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  function writePackage(directory, manifest) {
    const target = path.join(fixture, directory);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest));
    return target;
  }

  writePackage(".", { type: "module" });
  const shared = writePackage("packages/shared", { name: "@paperclipai/shared" });
  const nested = writePackage("packages/plugins/example", { name: "@paperclipai/example" });
  writePackage("server", {
    name: "@paperclipai/server",
    dependencies: { "@paperclipai/shared": "workspace:*", external: "1.0.0" },
    devDependencies: { "@paperclipai/example": "workspace:*" },
  });
  writePackage("ui", { name: "@paperclipai/ui" });
  writePackage("cli", { name: "paperclipai" });
  const scope = path.join(fixture, "server/node_modules/@paperclipai");
  mkdirSync(scope, { recursive: true });
  const sharedLink = path.join(scope, "shared");
  const nestedLink = path.join(scope, "example");
  symlinkSync(nested, sharedLink);
  mkdirSync(path.join(fixture, "scripts"));
  const script = path.join(fixture, "scripts/ensure-workspace-package-links.ts");
  copyFileSync(path.join(rootDir, "scripts/ensure-workspace-package-links.ts"), script);

  function preflight() {
    const result = spawnSync(process.execPath, [path.join(rootDir, "cli/node_modules/tsx/dist/cli.mjs"), script], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }

  assert.match(preflight(), /detected stale workspace package links for server/);
  assert.equal(realpathSync(sharedLink), shared);
  assert.equal(realpathSync(nestedLink), nested);
  assert.equal(existsSync(path.join(fixture, "server/node_modules/external")), false);
  assert.equal(existsSync(path.join(shared, "dist")), false);
  assert.equal(existsSync(path.join(fixture, "server/src")), false);
  assert.equal(preflight(), "");
});
