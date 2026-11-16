import { afterEach, expect, it, vi } from "vitest";
import { withBudgetSpan } from "./budget-tracing.js";

const start = vi.hoisted(() => vi.fn());
vi.mock("@opentelemetry/api", () => ({ trace: { getTracer: () => ({ startActiveSpan: start }) } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it("leaves tracing unused without an operator endpoint", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  await expect(withBudgetSpan("budget.accounting.transaction", async () => 42)).resolves.toBe(42);
  expect(start).not.toHaveBeenCalled();
});

it("does not create a span for an unchanged recovery result", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  const work = vi.fn(async () => 0);
  await expect(withBudgetSpan("budget.accounting.recover", work, undefined, changed => changed > 0)).resolves.toBe(0);
  expect(work).toHaveBeenCalledOnce();
  expect(start).not.toHaveBeenCalled();
});

it("retains the operation's time interval when recording progress after completion", async () => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const end = vi.fn();
  start.mockImplementation((_name, _options, callback) => callback({ end }));
  try {
    await expect(withBudgetSpan("budget.accounting.recover", async () => { clock.mockReturnValue(2_000); return 1; },
      undefined, changed => changed > 0)).resolves.toBe(1);
    expect(start.mock.calls[0][1]).toMatchObject({ startTime: 1_000 });
    expect(end).toHaveBeenCalledWith(2_000);
  } finally { clock.mockRestore(); }
});

it.each(["before", "after", "end", "rejected", "missing"])("keeps deferred recovery authoritative when tracing fails %s", async failure => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  start.mockImplementation((_name, _options, callback) => {
    if (failure === "before") throw new Error("before callback");
    if (failure === "rejected") return Promise.reject(new Error("tracer rejected"));
    if (failure === "missing") return undefined;
    const result = callback({ end: () => { if (failure === "end") throw new Error("end failed"); }, setStatus: vi.fn() });
    if (failure === "after") throw new Error("after callback");
    return result;
  });
  const work = vi.fn(async () => 1);
  await expect(withBudgetSpan("budget.accounting.recover", work, undefined, changed => changed > 0)).resolves.toBe(1);
  expect(work).toHaveBeenCalledOnce();
  const error = new Error("accounting failed");
  const failed = vi.fn(async () => { throw error; });
  await expect(withBudgetSpan("budget.accounting.recover", failed, undefined, () => false)).rejects.toBe(error);
  expect(failed).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledTimes(2);
});

it.each(["before", "after", "end", "rejected", "missing"])("keeps accounting authoritative when tracing fails %s", async failure => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  start.mockImplementation((_name, _options, callback) => {
    if (failure === "before") throw new Error("before callback");
    if (failure === "rejected") return Promise.reject(new Error("tracer rejected"));
    if (failure === "missing") return undefined;
    const result = callback({ end: () => { if (failure === "end") throw new Error("end failed"); } });
    if (failure === "after") throw new Error("after callback");
    return result;
  });
  const work = vi.fn(async () => 42);
  await expect(withBudgetSpan("budget.accounting.transaction", work)).resolves.toBe(42);
  expect(work).toHaveBeenCalledOnce();
  const error = new Error("original accounting failure");
  const failed = vi.fn(async () => { throw error; });
  await expect(withBudgetSpan("budget.accounting.transaction", failed)).rejects.toBe(error);
  expect(failed).toHaveBeenCalledOnce();
});
