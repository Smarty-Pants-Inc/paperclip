import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "../../vendor/paperclip-runner/testing.js";
import { QUALIFIED_PI_RPC_PROFILE, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeTurnAccounting, nativeUsageCostUsd, normalizeNativeUsage, usesNativeUsageDelivery } from "./native-usage-accounting.js";

const provider = { kind: "opencode" as const, model: "test-model" };
const event = (sourceSeq: number, eventType: string, turnId = "turn-1", payload: Record<string, unknown> = {}) => ({
  sourceInstanceId: "producer", sourceSeq, eventType, turnId, payload,
} as PrpEvent);

describe("native turn accounting", () => {
  it("selects producer delivery only for supported remote Runner execution", () => {
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider })).toBe(true);
    expect(usesNativeUsageDelivery({ runnerd: false, remote: true, provider })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: false, provider })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider: { kind: "cursor_cloud", model: "caller-model" } as never })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider: { kind: "muse", model: null } as never })).toBe(false);
  });

  it.each([
    provider,
    { kind: "pi_rpc" as const, model: "anthropic/claude-opus-5-5", profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" as const },
  ])("$kind reconstructs cumulative turn usage without counting repeated producer events twice", provider => {
    const accounting = createNativeTurnAccounting(provider);
    const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 120, outputTokens: 10, providerCostUsd: 0.25 } } };
    const history = [event(1, "turn.started"), event(2, "item.completed", "turn-1", usage), event(3, "turn.completed"),
      event(4, "turn.started", "turn-2"), event(5, "item.completed", "turn-2", usage), event(6, "turn.completed", "turn-2")];
    history.forEach(value => accounting.observe(value));
    history.forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 240, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 });
    expect(nativeUsageCostUsd(snapshot.usage, provider)).toBe(0.5);
  });

  it.each([1, 2])("accounts measured Pi message deltas after %i compactions without counting summaries or replay twice", count => {
    const accounting = createNativeTurnAccounting({ kind: "pi_rpc", model: "paperclip/faux", profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" });
    const projector = createPiEventProjector({ runId: "run", turnId: "turn-1" });
    let seq = 0;
    const history: PrpEvent[] = [event(++seq, "turn.started")];
    const project = (value: unknown) => history.push(...projector.project(value).map(projected =>
      event(++seq, projected.eventType, projected.turnId, projected.payload)));
    const message = (id: string, input: number, output: number) => ({ type: "message_end", message: {
      role: "assistant", provider: "neutral", model: "model", responseId: id, stopReason: "stop", content: [],
      usage: { input, output, cacheRead: 2, cacheWrite: 0, cost: { total: 0.02, totalFromProvider: false } },
    } });
    project(message("first", 11, 3));
    for (let index = 1; index <= count; index++) {
      project({ type: "compaction_start", reason: "threshold" });
      project({ type: "compaction_end", result: { tokensBefore: 90, estimatedTokensAfter: 30 } });
      project(message(`after-${index}`, 7, 5));
    }
    history.push(event(++seq, "turn.completed"));
    history.forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({
      inputTokens: 11 + count * 7, outputTokens: 3 + count * 5, cachedInputTokens: 2 + count * 2, cacheWriteTokens: 0,
    });
    expect(snapshot.usage).toMatchObject({ accountingCostIncomplete: true });
    history.forEach(value => accounting.observe(value));
    expect(accounting.snapshot()).toEqual(snapshot);
  });

  it.each(["turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted", "finish"])(
    "keeps measured usage as a lower bound when %s ends on a summary",
    terminal => {
      const accounting = createNativeTurnAccounting(provider);
      const measured = { kind: "usage", usage: { runDeltaComplete: true,
        runDelta: { inputTokens: 14, outputTokens: 8, providerCostUsd: 0.25 } } };
      const summary = { kind: "usage", usage: { source: "pi_summarization_unaccounted",
        runDelta: {}, runDeltaComplete: false, summaryUsage: "unknown" } };
      const history = [event(1, "turn.started"), event(2, "item.completed", "turn-1", measured),
        event(3, "item.completed", "turn-1", summary)];
      history.forEach(value => accounting.observe(value));
      expect(accounting.snapshot().complete).toBe(false);
      const snapshot = terminal === "finish" ? accounting.finish("turn-1")
        : (accounting.observe(event(4, terminal)), accounting.snapshot());
      expect(snapshot.complete).toBe(true);
      expect(snapshot.turnId).toBe("turn-1");
      expect(normalizeNativeUsage(snapshot.usage)).toMatchObject({ inputTokens: 14, outputTokens: 8 });
      expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
      history.forEach(value => accounting.observe(value));
      expect(accounting.snapshot()).toEqual(snapshot);
    },
  );

  it.each(["turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted", "finish"])(
    "keeps measured usage when the summary arrives after %s",
    terminal => {
      const accounting = createNativeTurnAccounting(provider);
      accounting.observe(event(1, "turn.started"));
      accounting.observe(event(2, "item.completed", "turn-1", { kind: "usage", usage: {
        runDeltaComplete: true, runDelta: { inputTokens: 14, outputTokens: 8 },
      } }));
      if (terminal === "finish") accounting.finish("turn-1");
      else accounting.observe(event(3, terminal));
      accounting.observe(event(4, "item.completed", "turn-1", { kind: "usage", usage: {
        source: "pi_summarization_unaccounted", summaryUsage: "unknown", runDeltaComplete: false, runDelta: {},
      } }));
      const snapshot = accounting.snapshot();
      expect(snapshot.complete).toBe(true);
      expect(snapshot.turnId).toBe("turn-1");
      expect(normalizeNativeUsage(snapshot.usage)).toMatchObject({ inputTokens: 14, outputTokens: 8 });
      expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    },
  );

  it("does not invent a measured receipt for a summary-only turn", () => {
    const accounting = createNativeTurnAccounting(provider);
    [event(1, "turn.started"), event(2, "item.completed", "turn-1", { kind: "usage", usage: {
      source: "pi_summarization_unaccounted", summaryUsage: "unknown", runDeltaComplete: false, runDelta: {},
    } }), event(3, "turn.completed")].forEach(value => accounting.observe(value));
    expect(accounting.snapshot().complete).toBe(false);
    expect(accounting.snapshot().turnId).toBeUndefined();
    expect(accounting.snapshot().usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
  });

  it("keeps the lower-bound fact after another turn and still rejects unmeasured message deltas", () => {
    const accounting = createNativeTurnAccounting(provider);
    const measured = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 14, outputTokens: 8 } } };
    [event(1, "turn.started"), event(2, "item.completed", "turn-1", measured),
      event(3, "item.completed", "turn-1", { kind: "usage", usage: {
        source: "pi_summarization_unaccounted", summaryUsage: "unknown", runDeltaComplete: false, runDelta: {},
      } }), event(4, "turn.completed"), event(5, "turn.started", "turn-2"),
      event(6, "item.completed", "turn-2", measured), event(7, "turn.completed", "turn-2")].forEach(value => accounting.observe(value));
    expect(accounting.snapshot().complete).toBe(true);
    expect(normalizeNativeUsage(accounting.snapshot().usage)).toMatchObject({ inputTokens: 28, outputTokens: 16 });
    expect(accounting.snapshot().usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    accounting.observe(event(8, "item.completed", "turn-2", { kind: "usage", usage: { runDelta: {}, runDeltaComplete: false } }));
    expect(accounting.snapshot().complete).toBe(false);
    expect(normalizeNativeUsage(accounting.snapshot().usage)).toMatchObject({ inputTokens: 14, outputTokens: 8 });
  });

  it.each([false, true])("replays real-session usage through the projector and accounting (ends on summary: %s)", endsOnSummary => {
    const fixture = JSON.parse(readFileSync(new URL(
      "../../../../packages/paperclip-runner/test-fixtures/pi-rpc/real-session-usage-only.json", import.meta.url), "utf8")) as {
      events: { type: string; message?: { role: string; usage: Record<string, number> } }[];
    };
    const projector = createPiEventProjector({ runId: "usage-replay", turnId: "turn-1" });
    const accounting = createNativeTurnAccounting({ kind: "pi_rpc", model: "redacted", profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" });
    const entries = endsOnSummary ? fixture.events.slice(0, fixture.events.findIndex(value => value.type === "compaction_end") + 1) : fixture.events;
    let seq = 0;
    const history: PrpEvent[] = [event(++seq, "turn.started")];
    entries.forEach((entry, index) => {
      const wire = entry.message ? { ...entry, message: { ...entry.message, responseId: `redacted-${index}`, content: [], stopReason: "stop" } } : entry;
      history.push(...projector.project(wire).map(projected => event(++seq, projected.eventType, projected.turnId, projected.payload)));
    });
    history.push(event(++seq, "turn.completed"));
    history.forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.turnId).toBe("turn-1");
    expect(normalizeNativeUsage(snapshot.usage)).toEqual(endsOnSummary
      ? { inputTokens: 45516, outputTokens: 991, cachedInputTokens: 402976, cacheWriteTokens: 45502 }
      : { inputTokens: 88603, outputTokens: 1889, cachedInputTokens: 517776, cacheWriteTokens: 88585 });
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    history.forEach(value => accounting.observe(value));
    expect(accounting.snapshot()).toEqual(snapshot);
  });

  it("retains the final compacted turn in the controlled-peer recording", () => {
    const projected = JSON.parse(readFileSync(new URL(
      "../../../../packages/paperclip-runner/test-fixtures/pi-rpc/compaction-1.5.2.normalized.json", import.meta.url), "utf8")) as PrpEvent[];
    const accounting = createNativeTurnAccounting(provider);
    let seq = 0;
    let turn: string | undefined;
    const history: PrpEvent[] = [];
    for (const projectedEvent of projected) {
      if (projectedEvent.turnId !== turn) {
        if (turn) history.push(event(++seq, "turn.completed", turn));
        turn = projectedEvent.turnId;
        history.push(event(++seq, "turn.started", turn));
      }
      history.push(event(++seq, projectedEvent.eventType, turn, projectedEvent.payload as Record<string, unknown>));
    }
    history.push(event(++seq, "turn.completed", turn));
    history.forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 3909, outputTokens: 6, cachedInputTokens: 4, cacheWriteTokens: 0 });
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
  });

  // Keep reason: S11-parent's real facade emits a display-only usage item
  // immediately after the measured usage item; it must not erase paid tokens.
  it("ignores display-only usage items rather than resetting the measured Pi turn", () => {
    const accounting = createNativeTurnAccounting({ kind: "pi_rpc", model: "paperclip/faux", profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" });
    accounting.observe(event(1, "turn.started"));
    accounting.observe(event(2, "item.completed", "turn-1", { kind: "usage", usage: {
      runDelta: { inputTokens: 14, outputTokens: 8 }, runDeltaComplete: true,
    } }));
    accounting.observe(event(3, "item.completed", "turn-1", { kind: "usage", item: { type: "usage", status: "completed" } }));
    accounting.observe(event(4, "turn.completed"));
    expect(accounting.snapshot().complete).toBe(true);
    expect(normalizeNativeUsage(accounting.snapshot().usage)).toMatchObject({ inputTokens: 14, outputTokens: 8 });
  });

  // s7501 run 0a18c2d0 (ACPX Claude): K1 killed the Runner mid-turn. ACPX
  // reports provisional zero usage until a turn ends, so the lost turn never
  // got a complete report. The restored Runner failed it as lost on restore and
  // the continuation turn completed with full usage, yet the receipt stayed
  // incomplete until the 10-minute closure timeout.
  it("closes a run whose earlier turn was lost on restore, as a lower bound", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const accounting = createNativeTurnAccounting(acpx);
    const provisional = { kind: "usage", usage: { runDeltaComplete: false,
      runDelta: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 } } };
    const final = { kind: "usage", usage: { runDeltaComplete: true,
      runDelta: { requests: 1, inputTokens: 6, outputTokens: 1446, cacheReadTokens: 124322, cacheWriteTokens: 2794, providerCostUsd: 0 } } };
    [event(7, "turn.started", "turn-lost"), event(10, "item.completed", "turn-lost", provisional),
      event(16, "item.completed", "turn-lost", provisional),
      event(26, "turn.failed", "turn-lost", { status: "failed", error: { code: "provider_turn_lost_on_restore", recoverable: true } }),
      event(29, "turn.started", "turn-next"), event(32, "item.completed", "turn-next", provisional),
      event(70, "item.completed", "turn-next", final)].forEach(value => accounting.observe(value));
    expect(accounting.snapshot().complete).toBe(false);
    accounting.observe(event(73, "turn.completed", "turn-next", { status: "completed" }));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 2800, outputTokens: 1446, cachedInputTokens: 124322, cacheWriteTokens: 2794 });
  });

  // w-20261110T100747-s20386 run 71f71d10 (ACPX Claude): K1 killed the
  // provider after the agent's finish tool call, before the turn's final usage
  // report. The restored Runner resumed the session and reported the same
  // turn completed without that report, so its receipt stayed incomplete until
  // the 10-minute closure timeout although the result was accepted.
  it("closes a turn that completed across a session restore without its final report, as a lower bound", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const provisional = { kind: "usage", usage: { runDeltaComplete: false,
      runDelta: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 } } };
    const before = [event(7, "turn.started", "turn-span"), event(10, "item.completed", "turn-span", provisional),
      event(113, "item.completed", "turn-span", provisional)];
    const restored = [event(119, "session.resumed", undefined as never, { context: {} }),
      event(124, "turn.completed", "turn-span", { status: "completed" })];
    const accounting = createNativeTurnAccounting(acpx);
    [...before, ...restored].forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    // The executor certifies completion only when the snapshot names the terminal turn.
    expect(snapshot.turnId).toBe("turn-span");
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    // A replay of the same history after another restart reaches the same state.
    const replayed = createNativeTurnAccounting(acpx);
    [...before, ...restored, ...before, ...restored].forEach(value => replayed.observe(value));
    expect(replayed.snapshot()).toEqual(snapshot);
  });

  it("keeps a restored turn's own final report when it arrives after the restore", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const accounting = createNativeTurnAccounting(acpx);
    const provisional = { kind: "usage", usage: { runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 } } };
    const final = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 40, outputTokens: 7, providerCostUsd: 0.01 } } };
    [event(1, "turn.started", "turn-span"), event(2, "item.completed", "turn-span", provisional),
      event(3, "session.resumed", undefined as never), event(4, "item.completed", "turn-span", final),
      event(5, "turn.completed", "turn-span")].forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.usage).not.toHaveProperty("accountingUsageLost");
    expect(normalizeNativeUsage(snapshot.usage)).toMatchObject({ inputTokens: 40, outputTokens: 7 });
  });

  it("keeps an incomplete turn pending when the session resumed before it started", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "session.resumed", undefined as never));
    accounting.observe(event(2, "turn.started"));
    accounting.observe(event(3, "item.completed", "turn-1", { kind: "usage", usage: { runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0 } } }));
    accounting.observe(event(4, "turn.completed"));
    expect(accounting.snapshot().complete).toBe(false);
  });

  it("keeps a turn that failed for any other reason without usage pending", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "turn.started"));
    accounting.observe(event(2, "turn.failed", "turn-1", { error: { code: "provider_terminal_error_missing" } }));
    expect(accounting.snapshot().complete).toBe(false);
    expect(accounting.snapshot().usage).not.toHaveProperty("accountingUsageLost");
  });

  it("keeps an incomplete provider report pending instead of trusting placeholder zeroes", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "turn.started"));
    accounting.observe(event(2, "item.completed", "turn-1", { kind: "usage", usage: {
      runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
    } }));
    accounting.observe(event(3, "turn.completed"));
    expect(accounting.snapshot().complete).toBe(false);
    expect(accounting.snapshot().usage?.accountingCostIncomplete).toBe(true);
    expect(normalizeNativeUsage({ runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0 } })).toBeUndefined();
  });
});
