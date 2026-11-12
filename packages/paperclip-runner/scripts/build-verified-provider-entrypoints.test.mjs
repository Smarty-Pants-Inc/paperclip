import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    await bundlePiExtensions({ outputRoot: root });
    delete process.env.PAPERCLIP_PI_BIND_SOCKET; delete process.env.PAPERCLIP_PI_BIND_INITIAL;
    process.env.PAPERCLIP_PI_INSTRUCTIONS_FILE = join(root, "instructions.md");
    process.env.PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY = "test-host";
    const { default: factory } = await import(pathToFileURL(join(root, "index.js")).href);
    factory(pi); await emit("session_start");
    const register = () => registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: "probe", path: join(root, "child-bridge.js") }] });
    assert.throws(register, /already registered/);
    await emit("session_shutdown");
    register().dispose();
  } finally {
    await emit("session_shutdown");
    for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

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
