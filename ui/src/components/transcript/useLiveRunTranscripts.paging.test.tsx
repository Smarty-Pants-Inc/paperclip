// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { __liveUpdatesTestUtils, type CompanyLiveEventHandler } from "../../context/LiveUpdatesProvider";
import { LiveTranscriptInterests } from "../../lib/live-transcript-interests";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLogChunk } from "../../adapters";
import { useLiveRunTranscripts } from "./useLiveRunTranscripts";

const { logMock, buildTranscriptMock } = vi.hoisted(() => ({
  logMock: vi.fn(async (_runId: string, _offset: number, _limit: number, _options?: unknown) =>
    ({ runId: "run-1", store: "memory", logRef: "log-1", content: "", nextOffset: 0 })),
  buildTranscriptMock: vi.fn((chunks: unknown[]) => chunks),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { censorUsernameInLogs: false } }) }));
vi.mock("../../api/instanceSettings", () => ({ instanceSettingsApi: { getGeneral: vi.fn() } }));
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { log: logMock } }));
vi.mock("../../adapters", () => ({
  buildTranscript: buildTranscriptMock,
  getUIAdapter: () => null,
  onAdapterChange: () => () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECORDS = 600;
const BOUND = 4_000;
const record = (seq: number) =>
  `${JSON.stringify({ ts: `2026-11-17T00:${String(seq).padStart(6, "0")}Z`, stream: "stdout", chunk: `línea ${seq} ✓ ${"·".repeat(seq % 50)}`, seq })}\n`;
const saved = encoder.encode(Array.from({ length: RECORDS }, (_, index) => record(index + 1)).join(""));
let failNextRangeRead = false;

function serveSavedLog(offset: number, limit: number) {
  const end = Math.min(saved.length, offset + limit);
  return { runId: "run-1", store: "memory", logRef: "log-1", content: decoder.decode(saved.slice(offset, end)), nextOffset: end };
}

type Hook = ReturnType<typeof useLiveRunTranscripts>;
let latest!: Hook;
function Harness() {
  latest = useLiveRunTranscripts({
    runs: [{ id: "run-1", status: "succeeded", adapterType: "codex_local", logBytes: saved.length }],
    enableRealtimeUpdates: false,
    maxBytesPerRun: BOUND,
    logReadLimitBytes: 4_096,
  });
  return null;
}

function mount() {
  const root = createReactRoot(document.createElement("div"));
  const listeners = new Set<CompanyLiveEventHandler>();
  const subscription = {
    companyId: "company-1", transcripts: new LiveTranscriptInterests(),
    subscribe(handler: CompanyLiveEventHandler) { listeners.add(handler); return () => { listeners.delete(handler); }; },
  };
  const { LiveEventSubscriptionContext } = __liveUpdatesTestUtils;
  return {
    render: (children: ReactNode) => root.render(
      <LiveEventSubscriptionContext.Provider value={subscription}>{children}</LiveEventSubscriptionContext.Provider>,
    ),
    unmount: () => root.unmount(),
  };
}

const windowChunks = () => (latest.transcriptByRun.get("run-1") ?? []) as unknown as RunLogChunk[];
const units = () => windowChunks().reduce((total, chunk) => total + chunk.chunk.length, 0);
const seqs = () => windowChunks().map((chunk) => chunk.seq!);
const paging = () => latest.outputPagingByRun.get("run-1")!;

function expectContiguous() {
  const values = seqs();
  expect(new Set(values).size).toBe(values.length);
  values.forEach((seq, index) => { if (index > 0) expect(seq).toBe(values[index - 1]! + 1); });
}

describe("useLiveRunTranscripts paging: bounded memory, every line reachable", () => {
  beforeEach(() => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    failNextRangeRead = false;
    logMock.mockReset();
    logMock.mockImplementation(async (_id, offset, limit) => {
      if (failNextRangeRead) { failNextRangeRead = false; throw new Error("network down"); }
      return serveSavedLog(offset, limit);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("(a) keeps at most the stated window after reading a log larger than it", async () => {
    const view = mount();
    try {
      await act(async () => view.render(<Harness />));
      expect(saved.length).toBeGreaterThan(BOUND * 5);
      expect(units()).toBeLessThanOrEqual(BOUND);
      expect(seqs().at(-1)).toBe(RECORDS);
      expect(paging()).toEqual({ hasEarlier: true, hasLater: false, earlier: "idle", later: "idle" });
    } finally { await act(async () => view.unmount()); }
  });

  it("(b) Show earlier output reloads exactly the evicted ranges, in order, with no duplicates", async () => {
    const view = mount();
    try {
      await act(async () => view.render(<Harness />));
      const reached: number[] = [...seqs()];
      let guard = 0;
      while (paging().hasEarlier && guard++ < 1_000) {
        const firstBefore = seqs()[0]!;
        logMock.mockClear();
        await act(async () => latest.loadEarlierOutput("run-1"));
        const [, offset, limit] = logMock.mock.calls[0]!;
        // The request covers exactly the evicted records and nothing else.
        const range = decoder.decode(saved.slice(offset, offset + limit));
        const restored = seqs().filter((seq) => seq < firstBefore);
        expect(range).toBe(restored.map(record).join(""));
        expect(restored.at(-1)).toBe(firstBefore - 1);
        expectContiguous();
        reached.unshift(...restored);
      }
      expect(reached).toEqual(Array.from({ length: RECORDS }, (_, index) => index + 1));
    } finally { await act(async () => view.unmount()); }
  });

  it("(c) paging up to the start and back down keeps the bound every step", async () => {
    const view = mount();
    try {
      await act(async () => view.render(<Harness />));
      const newest = seqs();
      for (let round = 0; round < 2; round += 1) {
        while (paging().hasEarlier) {
          await act(async () => latest.loadEarlierOutput("run-1"));
          expect(units()).toBeLessThanOrEqual(BOUND);
          expectContiguous();
        }
        expect(seqs()[0]).toBe(1);
        expect(paging().hasLater).toBe(true);
        while (paging().hasLater) {
          await act(async () => latest.loadLaterOutput("run-1"));
          expect(units()).toBeLessThanOrEqual(BOUND);
          expectContiguous();
        }
        expect(seqs()).toEqual(newest);
      }
    } finally { await act(async () => view.unmount()); }
  });

  it("(d) a failed earlier read shows the error state and Retry recovers the same range", async () => {
    const view = mount();
    try {
      await act(async () => view.render(<Harness />));
      const before = seqs();
      failNextRangeRead = true;
      await act(async () => latest.loadEarlierOutput("run-1"));
      expect(paging()).toMatchObject({ hasEarlier: true, earlier: "error" });
      expect(seqs()).toEqual(before);
      await act(async () => latest.loadEarlierOutput("run-1"));
      expect(paging().earlier).toBe("idle");
      expect(seqs()).toContain(before[0]! - 1);
      expect(seqs()[0]).toBeLessThan(before[0]!);
      expectContiguous();
    } finally { await act(async () => view.unmount()); }
  });
});
