import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import { projectPiRecording } from "../../../test-support/pi-rpc-golden.js";

const fixture = (name: string) => readFileSync(new URL(`../../../test-fixtures/pi-rpc/${name}`, import.meta.url), "utf8");
const wire = (name: string) => fixture(`${name}-1.5.2.jsonl`).trim().split("\n").map(line => JSON.parse(line));
const commands = (name: string) => fixture(`${name}-1.5.2.commands.jsonl`).trim().split("\n").map(line => JSON.parse(line));
const scenarios = ["baseline", "unsupported-thinking", "abort", "queue", "retry", "compaction", "extension", "subagent"];
const envelope = (event: Record<string, unknown>, index: number) => ({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `pi-${index}`, sourceSeq: index + 1, sourceInstanceId: "capture", sourceKind: "runner", runId: "pi-capture", normalizedSessionId: "pi-session", priority: 1, emittedAt: "2026-11-12T06:26:00.000Z", ...event } as PrpEvent);

describe("immutable real Pi 1.5.2 lifecycle recordings against the controlled peer", () => {
  it.each(scenarios)("replays %s into its normalized golden with valid PRP envelopes", name => {
    const actual = projectPiRecording(wire(name), name === "extension");
    expect(actual).toEqual(JSON.parse(fixture(`${name}-1.5.2.normalized.json`)));
    for (const [index, event] of actual.entries()) expect(validatePrpEvent(envelope(event, index)), JSON.stringify(event)).toMatchObject({ ok: true });
    const provenance = JSON.parse(fixture(`${name}-1.5.2.provenance.json`));
    expect(provenance).toMatchObject({ runtimeVersion: "1.5.2", childExitCode: 0, childSignal: null, noLiveProviderCalls: true });
  });
  it("observes successful unsupported set(high) clamping to off, not acknowledgment", () => {
    const raw = wire("unsupported-thinking");
    expect(commands("unsupported-thinking").at(-2)).toMatchObject({ type: "set_thinking_level", level: "high" });
    expect(raw.filter(event => event.command === "get_available_thinking_levels").at(-1)?.data).toEqual({ levels: ["off"] });
    expect(raw.filter(event => event.command === "set_thinking_level").at(-1)).toMatchObject({ success: true });
    expect(raw.filter(event => event.command === "set_thinking_level").at(-1)?.data).toBeUndefined();
    expect(raw.at(-1).data.thinkingLevel).toBe("off");
  });
  it("aborts an actually streaming turn and waits for agent_settled", () => {
    const raw = wire("abort");
    expect(raw.some(event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")).toBe(true);
    expect(raw.some(event => event.type === "message_end" && event.message.stopReason === "aborted")).toBe(true);
    expect(raw.find(event => event.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(commands("abort").slice(-2).map(command => command.type)).toEqual(["clear_queue", "abort"]);
  });
  it("queues then consumes steer and follow_up once, in order, within one native run", () => {
    const raw = wire("queue");
    for (const name of ["steer", "follow_up"]) expect(raw.find(event => event.command === name)?.data.disposition).toBe("queued");
    const users = raw.filter(event => event.type === "message_end" && event.message.role === "user").map(event => JSON.stringify(event.message.content));
    expect(users).toHaveLength(3); expect(users[1]).toContain("steering-marker"); expect(users[2]).toContain("followup-marker");
    expect(raw.filter(event => event.type === "agent_settled")).toHaveLength(1);
  });
  it("keeps one projector/Runner turn across a real HTTP-500 auto-retry", () => {
    const raw = wire("retry"), normalized = projectPiRecording(raw);
    expect(raw.filter(event => event.type === "agent_start")).toHaveLength(2);
    expect(raw).toContainEqual(expect.objectContaining({ type: "auto_retry_start", attempt: 1 }));
    expect(raw).toContainEqual(expect.objectContaining({ type: "auto_retry_end", success: true }));
    expect(new Set(normalized.map(event => event.turnId))).toEqual(new Set(["turn-1"]));
  });
  it("compacts before final settlement on the stub's small context model", () => {
    const raw = wire("compaction");
    const start = raw.findIndex(event => event.type === "compaction_start");
    expect(start).toBeGreaterThan(raw.findIndex(event => event.type === "agent_start"));
    expect(raw.slice(start + 1).some(event => event.type === "compaction_end" && event.result)).toBe(true);
    expect(raw.slice(start + 1).some(event => event.type === "agent_settled")).toBe(true);
    expect(raw.find(event => event.command === "set_model").data.contextWindow).toBe(4096);
  });
  it("fences an extension-started turn without ever sending prompt", () => {
    const raw = wire("extension");
    expect(commands("extension").map(command => command.type)).toEqual(["clear_queue", "abort"]);
    expect(raw.some(event => event.type === "agent_start")).toBe(true);
    expect(raw.find(event => event.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(projectPiRecording(raw, true)).toEqual([{ eventType: "harness.diagnostic", payload: { code: "pi_unrequested_agent_start_fenced", providerMethod: "agent_start" } }]);
  });
  it("calls the installed subagent tool without launching a child, keeping usage unknown", () => {
    const raw = wire("subagent");
    const tool = raw.find(event => event.type === "tool_execution_end" && event.toolName === "subagent");
    expect(tool).toMatchObject({ isError: false }); expect(JSON.stringify(tool.result)).not.toContain("Tool subagent not found");
    expect(raw.find(event => event.type === "tool_execution_start" && event.toolName === "subagent").args).toMatchObject({ action: "list" });
    expect(projectPiRecording(raw)).toContainEqual(expect.objectContaining({ eventType: "usage.reported", payload: expect.objectContaining({ childUsage: "unknown", accountingComplete: false }) }));
  });
});

// Expected skip: the required production encoder is absent on exact b7bfd4e5.
// Port below is the explicit test seam code-lead must expose, not a claimed
// existing export. Do not replace it with the OpenCode encoder as fake proof.
const proxy = new URL("../../cli/pi-app-server-proxy.ts", import.meta.url);
it.skipIf(!existsSync(proxy))("goldens -> production Pi proxy encoder (missing src/cli/pi-app-server-proxy.ts)", async () => {
  const { encodePiProjectedEvent, decodePiProxyReplayFrame } = await import(proxy.href);
  expect(typeof encodePiProjectedEvent).toBe("function");
  expect(typeof decodePiProxyReplayFrame).toBe("function");
  for (const name of scenarios) {
    const golden = JSON.parse(fixture(`${name}-1.5.2.normalized.json`));
    for (const event of golden) {
      const frames = encodePiProjectedEvent({ threadId: "pi-session", runId: "pi-capture", ...event });
      // Exercise the real JSONL byte boundary, preserving Unicode separators.
      const decoded = Buffer.from(frames.map((frame: unknown) => JSON.stringify(frame) + "\n").join(""), "utf8").toString("utf8").trim().split("\n").map(line => decodePiProxyReplayFrame(JSON.parse(line)));
      expect(decoded).toContainEqual(expect.objectContaining(event));
    }
  }
});
