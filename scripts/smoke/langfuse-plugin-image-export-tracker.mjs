// TRACKER: upstream @langfuse/pi-observability-plugin@0.1.2 exports tool images.
// Opt-in RED, not an ordinary passing CI test. No credentials or cloud requests.
// Run: node scripts/smoke/langfuse-plugin-image-export-tracker.mjs /absolute/plugin/src/index.ts
// Keep: third-party data boundary. Executes the UNMODIFIED public plugin factory;
// substitutes only Pi/OTel/Langfuse hosts and inspects the payload after its mask.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";

const source = process.argv[2];
if (!source) throw new Error("Supply the public Langfuse plugin src/index.ts; this is an opt-in upstream RED tracker");
const original = await readFile(source, "utf8");
const key = "paperclip.langfuse.image-export-tracker";
const host = `const host = globalThis[Symbol.for(${JSON.stringify(key)})];`;
const mocks = {
  "@earendil-works/pi-coding-agent": 'export const getAgentDir = () => "/nonexistent-paperclip-langfuse-tracker";',
  "@langfuse/otel": `${host} export class LangfuseSpanProcessor { constructor(options) { host.mask = options.mask; } onStart() {} async forceFlush() {} }`,
  "@langfuse/tracing": `${host} export const LangfuseOtelSpanAttributes = {}; export const setLangfuseTracerProvider = () => {}; export const startObservation = (...args) => host.observation(...args);`,
  "@opentelemetry/api": "export const TraceFlags = { SAMPLED: 1 };",
  "@opentelemetry/sdk-trace-node": "export class AlwaysOnSampler {} export class NodeTracerProvider { async forceFlush() {} async shutdown() {} }",
};
for (const media of ["true", "false"]) {
  test(`UPSTREAM RED TRACKER: tool image export is reference-only (LANGFUSE_MEDIA_UPLOAD_ENABLED=${media})`, async () => {
    const env = { ...process.env };
    const handlers = new Map();
    const exported = [];
    const state = {
      mask: ({ data }) => data,
      observation(name, initial) {
        const emit = data => exported.push(state.mask({ data: JSON.stringify({ name, ...data }) }));
        emit(initial);
        return { update: emit, end() {}, startObservation: state.observation,
          otelSpan: { spanContext: () => ({ traceFlags: 1 }) } };
      },
    };
    globalThis[Symbol.for(key)] = state;
    try {
      process.env.LANGFUSE_TRACING_ENABLED = "true";
      process.env.LANGFUSE_PUBLIC_KEY = "fake-public";
      process.env.LANGFUSE_SECRET_KEY = "fake-secret";
      process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED = media;
      const compiled = await build({
        stdin: { contents: original + `\n// tracker media=${media}`, loader: "ts", resolveDir: process.cwd() },
        bundle: true, write: false, platform: "node", format: "esm",
        plugins: [{ name: "tracker-hosts", setup(b) {
          b.onResolve({ filter: /^@/ }, args => {
            if (!(args.path in mocks)) throw new Error(`Unexpected plugin dependency: ${args.path}`);
            return { path: args.path, namespace: "tracker" };
          });
          b.onLoad({ filter: /.*/, namespace: "tracker" }, args => ({ contents: mocks[args.path], loader: "js" }));
        } }],
      });
      const plugin = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}#media=${media}`);
      plugin.default({ on: (name, fn) => handlers.set(name, fn) });
      const ctx = { cwd: "/tracker", hasUI: false, sessionManager: { getSessionId: () => "tracker-session", getBranch: () => [] } };
      const bytes = Buffer.from("synthetic private screenshot tracker pixels");
      const data = bytes.toString("base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await handlers.get("before_agent_start")({ prompt: "inspect one frame", images: [] }, ctx);
      await handlers.get("tool_execution_start")({ toolCallId: "capture-1", toolName: "capture_frame", args: {} }, ctx);
      await handlers.get("tool_execution_end")({ toolCallId: "capture-1", isError: false,
        result: { content: [{ type: "image", data, mimeType: "image/png" }] } }, ctx);
      await handlers.get("agent_settled")({}, ctx);
      const payload = JSON.stringify(exported);
      // Report booleans only: never print image bodies, even on assertion failure.
      assert.deepEqual({
        bodyAbsent: !payload.includes(data), dataUrlAbsent: !payload.includes("data:image/"),
        hashPresent: payload.includes(sha256), sizePresent: payload.includes(String(bytes.length)),
        mimePresent: payload.includes("image/png"),
      }, { bodyAbsent: true, dataUrlAbsent: true, hashPresent: true, sizePresent: true, mimePresent: true });
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
      Object.assign(process.env, env);
      delete globalThis[Symbol.for(key)];
    }
  });
}
