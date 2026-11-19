import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createProviderTraceFileSink } from "../contracts/provider-trace-file-sink.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerPrefixKeys } from "../../test/provider-prefix-keys.js";
import { createPiEventProjector } from "./pi/pi-event-projector.js";
import { ProcessCodexAppServerTransport } from "./codex/app-server-transport.js";
import { createProviderFailure } from "./provider-failure.js";
import { canonicalProviderEventsFromCodex } from "../provider-events.js";

// Keep reason: never-OK exposing a credential at real output/write boundaries.
// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21032
const filesUnder = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name);
  return entry.isDirectory() ? filesUnder(path) : [path];
});

describe("K1 bare provider keys before Pi event serialization and spill", () => {
  for (const [family, key] of providerPrefixKeys) {
    it.each(["tool output", "final answer"])(`${family}: masks %s including after the excerpt`, kind => {
      const directory = mkdtempSync(join(tmpdir(), "provider-prefix-spill-"));
      try {
        const body = `start ${key}\n${"x".repeat(80 * 1024)}\nlate ${key}\n${"y".repeat(230 * 1024)}`;
        const event = kind === "tool output"
          ? { type: "tool_execution_end", toolCallId: "fixture", toolName: "bash", result: { content: [{ type: "text", text: body }] } }
          : { type: "message_end", message: { role: "assistant", provider: "fixture", model: "fixture", timestamp: 1, responseId: "reply-1", stopReason: "stop", content: [{ type: "text", text: body }] } };
        const before = JSON.stringify(event);
        const events = createPiEventProjector({ runId: "run", turnId: "turn", spillDirectory: directory }).project(event);
        const encoded = JSON.stringify(events);
        expect(encoded).not.toContain(key);
        expect(encoded).toContain("start [REDACTED]\\n");
        const paths = filesUnder(directory);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const saved = readFileSync(path, "utf8");
          expect(saved).not.toContain(key);
          expect(saved).toContain("start [REDACTED]\n");
          expect(saved).toContain("\nlate [REDACTED]\n");
          expect(statSync(path).mode & 0o777).toBe(0o600);
        }
        expect(JSON.stringify(event)).toBe(before);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe("unregistered provider keys at the real trace spool write", () => {
  it.each(providerPrefixKeys)("masks %s in persisted raw frames and trace metadata", async (_family, key) => {
    const directory = mkdtempSync(join(tmpdir(), "provider-prefix-trace-"));
    try {
      const path = join(directory, "trace.ndjson");
      const sink = await createProviderTraceFileSink({ path, provider: "pi_rpc", channel: "fixture" });
      expect(sink).not.toBeNull();
      const frameId = sink!.frame({ direction: "provider_to_client", transport: "stdio", raw: JSON.stringify({ message: `upstream ${key}` }) });
      sink!.interpretation({ frameId: frameId!, stage: "fixture", ruleId: "fixture", disposition: "rejected", reason: `upstream ${key}` });
      await sink!.finish({ reason: `upstream ${key}` });
      const saved = readFileSync(path, "utf8");
      expect(saved).not.toContain(key);
      const rows = saved.trim().split("\n").map(line => JSON.parse(line));
      const frame = rows.find(row => row.kind === "frame");
      const decoded = Buffer.from(frame.rawBase64, "base64");
      expect(decoded.toString("utf8")).not.toContain(key);
      expect(JSON.parse(decoded.toString("utf8"))).toEqual({ message: "upstream [REDACTED]" });
      expect(frame.byteLength).toBe(decoded.byteLength);
      expect(frame.digest).toBe(`sha256:${createHash("sha256").update(decoded).digest("hex")}`);
      expect(rows.find(row => row.kind === "interpretation").reason).toBe("upstream [REDACTED]");
      expect(rows.find(row => row.kind === "trace_status").reason).toBe("upstream [REDACTED]");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("K3 Codex process JSON-RPC error -> provider failure", () => {
  it.each(providerPrefixKeys)("masks %s before exposing the transport error", async (_family, key) => {
    const transport = new ProcessCodexAppServerTransport({
      command: process.execPath,
      args: ["-e", `process.stdin.once('data', chunk => { const request = JSON.parse(String(chunk)); process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: ${JSON.stringify(`upstream ${key}\nretry denied`)} } }) + '\\n'); });`],
      environment: { PATH: process.env.PATH },
    });
    let error: unknown;
    try {
      try { await transport.request("turn/start", {}); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      // The raw transport error is also a logging boundary, before providerFailureMessage.
      expect(String(error)).not.toContain(key);
      expect(String(error)).toContain("[REDACTED]");
      const failure = createProviderFailure({ provider: "codex", phase: "turn", message: String(error) });
      expect(failure?.message).not.toContain(key);
      expect(failure?.message).toContain("[REDACTED]");
    } finally {
      await transport.close();
    }
  });
});

it.each(providerPrefixKeys)("masks %s in the canonical provider notice caller", (_family, key) => {
  const events = canonicalProviderEventsFromCodex("mcpServer/startupStatus/updated", { name: "fixture", status: "failed", error: `upstream ${key}\nretry denied` });
  expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain(key);
  expect(JSON.stringify(events)).toContain("[REDACTED]");
});
