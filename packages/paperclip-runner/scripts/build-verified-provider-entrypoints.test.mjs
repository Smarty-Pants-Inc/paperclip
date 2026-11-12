import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";

import {
  bundleVerifiedProviderEntrypoints,
  verifiedProviderEntrypoints,
  bundlePiExtensions,
  piExtensionEntrypoints,
} from "./build-verified-provider-entrypoints.mjs";

test("provider entrypoints include self-contained ESM and descriptor-safe CommonJS bundles", async () => {
  const bundles = await bundleVerifiedProviderEntrypoints({ write: false });
  assert.equal(bundles.length, verifiedProviderEntrypoints.length);
  for (const { entrypoint, result, verifiedResult } of bundles) {
    for (const bundle of [result, verifiedResult]) {
      assert.equal(bundle.outputFiles?.length, 1, entrypoint.name);
      const source = bundle.outputFiles[0].text;
      assert.match(source, /^#!\/usr\/bin\/env node\n/);
    }
    assert.doesNotMatch(
      verifiedResult.outputFiles[0].text,
      /\bimport\.meta\b/,
      entrypoint.name,
    );
  }
});

test("written provider entrypoints satisfy qualified launch permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX launch permissions do not apply on Windows");
    return;
  }
  await bundleVerifiedProviderEntrypoints();
  for (const entrypoint of verifiedProviderEntrypoints) {
    for (const output of [entrypoint.output, entrypoint.verifiedOutput]) {
      const mode = (await stat(output)).mode;
      assert.equal(mode & 0o022, 0, entrypoint.name);
      assert.notEqual(mode & 0o100, 0, entrypoint.name);
    }
  }
});

test("Pi host and child bridge are separate self-contained ESM entrypoints", async () => {
  const bundles = await bundlePiExtensions({ write: false });
  assert.equal(bundles.length, 2);
  assert.deepEqual(piExtensionEntrypoints.map(entry => entry.filename), ["index.js", "child-bridge.js"]);
  for (const { entrypoint, result } of bundles) {
    assert.equal(result.outputFiles.length, 1, entrypoint.name);
    const output = Object.values(result.metafile.outputs).find(value => value.entryPoint);
    assert.ok(output.imports.every(value => value.external), entrypoint.name);
  }
});

async function writePiManifest(root) {
  const path = "dist/drivers/pi/extension/child-bridge.js";
  const sha256 = `sha256:${createHash("sha256").update(await readFile(join(root, path))).digest("hex")}`;
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ payload: { artifacts: { piChildBridge: { path, sha256 } } } }));
}

test("relocated built host registers its sibling bridge in the independently loaded package registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-built-extensions-"));
  const keys = ["PAPERCLIP_PI_BIND_SOCKET", "PAPERCLIP_PI_BIND_INITIAL", "PAPERCLIP_PI_INSTRUCTIONS_FILE", "PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY"];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  const handlers = new Map();
  const pi = { events: { on() { return () => {}; }, emit() {} }, on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); } };
  const ctx = { sessionManager: { getSessionId: () => "relocated-built-parent" }, isIdle: () => true, abort() {} };
  const emit = async name => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await bundlePiExtensions({ outputRoot: join(root, "dist/drivers/pi/extension") });
    await writePiManifest(root);
    delete process.env.PAPERCLIP_PI_BIND_SOCKET; delete process.env.PAPERCLIP_PI_BIND_INITIAL;
    process.env.PAPERCLIP_PI_INSTRUCTIONS_FILE = join(root, "instructions.md");
    process.env.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY = "test-host";
    const { default: factory } = await import(pathToFileURL(join(root, "dist/drivers/pi/extension/index.js")).href);
    factory(pi); await emit("session_start");
    const register = () => registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: "probe", path: join(root, "dist/drivers/pi/extension/child-bridge.js") }] });
    assert.throws(register, /already registered/);
    await emit("session_shutdown");
    register().dispose();
  } finally {
    await emit("session_shutdown");
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

for (const defect of ["missing-file", "wrong-sha"]) {
  test(`built host rechecks child integrity at registration after factory: ${defect}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-entrypoints-integrity-late-"));
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      const distRoot = join(root, "dist");
      await bundlePiExtensions({ outputRoot: join(distRoot, "drivers/pi/extension") });
      await writePiManifest(root);
      const hostPath = join(distRoot, "drivers", "pi", "extension", "index.js");
      const childPath = join(distRoot, "drivers", "pi", "extension", "child-bridge.js");
      const { installPiSubagentComposition } = await import(pathToFileURL(hostPath).href);
      const handlers = new Map(); let aborts = 0;
      const handle = installPiSubagentComposition({
        events: { on() { return () => {}; }, emit() {} },
        on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
      });
      if (defect === "missing-file") await rm(childPath);
      else await writeFile(childPath, "export default function changedAfterFactory() {}\n");
      try {
        assert.throws(() => handlers.get("session_start")({}, {
          sessionManager: { getSessionId: () => "must-not-register" },
          abort: () => { aborts++; },
        }), /Pi child bridge integrity check failed/);
        assert.equal(aborts, 1);
      } finally { handle.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const defect of ["missing-file", "wrong-sha", "missing-manifest", "wrong-path"]) {
  test(`built host fails closed before child registration on ${defect}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-built-integrity-"));
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      const outputRoot = join(root, "dist/drivers/pi/extension");
      await bundlePiExtensions({ outputRoot });
      await writePiManifest(root);
      if (defect === "missing-file") await rm(join(outputRoot, "child-bridge.js"));
      if (defect === "wrong-sha") await writeFile(join(outputRoot, "child-bridge.js"), "export default function tampered() {}\n");
      if (defect === "missing-manifest") await rm(join(root, "provider-pack.json"));
      if (defect === "wrong-path") {
        const file = join(root, "provider-pack.json");
        const manifest = JSON.parse(await readFile(file, "utf8"));
        manifest.payload.artifacts.piChildBridge.path = "elsewhere/child-bridge.js";
        await writeFile(file, JSON.stringify(manifest));
      }
      const { installPiSubagentComposition } = await import(pathToFileURL(join(outputRoot, "index.js")).href);
      const pi = { events: { on() { return () => {}; }, emit() {} }, on() {} };
      assert.throws(() => installPiSubagentComposition(pi), /Pi child bridge integrity check failed/);
      // Failure must not leave the process-global registry or seam claimed.
      if (defect === "missing-file") await writeFile(join(outputRoot, "child-bridge.js"), "export default function restored() {}\n");
      const registration = registerRequiredChildExtensions({ sessionId: `failed-${defect}`, extensions: [{ id: "probe", path: join(outputRoot, "child-bridge.js") }] });
      registration.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

// Package-layout regression runs in the existing verified-entrypoint test lane.
import "./provision-pi-package.test.mjs";

import "./materialize-kimi-distribution.test.mjs";
import "./provision-kimi-package.test.mjs";
import "./patch-kimi-runtime.test.mjs";
import "./kimi-metadata-probe.test.mjs";
import "./antigravity-provisioner-layout.test.mjs";
import "./materialize-antigravity-distribution.test.mjs";
import "./probe-antigravity-metadata.test.mjs";
import "./patch-antigravity-runtime.test.mjs";
