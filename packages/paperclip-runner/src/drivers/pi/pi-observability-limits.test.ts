import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assistant, attrs, environment, openPi, sentinel, spans, terminal, tool } from "./pi-observability.test-fixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([false, true])("R5/H2: 200 calls/tools, split bodies, exact known deltas; subagent=%s", async subagent => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("{}"); }));
  const pi = await openPi();
  try {
    await pi.start();
    for (let i = 0; i < 200; i++) {
      const name = subagent && i === 0 ? "subagent" : "read";
      pi.peer.send(...assistant(`call-${i}`, { tool: name }), ...tool(`call-${i}`, name, "x".repeat(8192)));
    }
    pi.peer.send(...terminal); await pi.settled();
  } finally { await pi.close(); }
  expect(bodies.length).toBeGreaterThan(1);
  for (const body of bodies) expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(1048576);
  const all = spans(bodies);
  expect(all).toHaveLength(130); // root, first 64 tools + 64 usage, ONE overflow
  expect(new Set(all.map(s => s.spanId)).size).toBe(130);
  expect(new Set(all.map(s => s.traceId)).size).toBe(1);
  const aggregate = all.filter(s => s.name === "pi.turn.overflow");
  expect(aggregate).toHaveLength(1);
  expect(attrs(aggregate[0])).toMatchObject({
    "paperclip.observability.truncated": true, "paperclip.observability.incomplete": subagent,
    "paperclip.observability.totals_exact": !subagent,
    "paperclip.observability.usage_count": 200, "paperclip.observability.tool_count": 200,
    "paperclip.observability.overflow.usage_count": 136, "paperclip.observability.overflow.tool_count": 136,
  });
  const cumulative = pi.events.filter(e => e.eventType === "item.completed" && e.payload.kind === "usage").at(-1)?.payload.usage as any;
  const sum = (key: string) => all.reduce((n, s) => n + (attrs(s)[key] ?? 0), 0);
  expect(sum("gen_ai.usage.input_tokens")).toBe(cumulative.total.inputTokens);
  expect(sum("gen_ai.usage.output_tokens")).toBe(cumulative.total.outputTokens);
  expect(sum("gen_ai.usage.cache_read.input_tokens")).toBe(cumulative.total.cachedInputTokens);
  expect(sum("gen_ai.usage.cache_creation.input_tokens")).toBe(cumulative.total.cacheWriteTokens);
  expect(sum("gen_ai.usage.cost")).toBe(cumulative.providerReportedCostUsd);
  expect(cumulative.runDeltaComplete).toBe(!subagent);
  if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `R5-subagent-${subagent}.json`), JSON.stringify({
    requestBytes: bodies.map(body => Buffer.byteLength(JSON.stringify(body))), spans: all.length,
    aggregate: attrs(aggregate[0]), cumulative, exported: { input: sum("gen_ai.usage.input_tokens"), output: sum("gen_ai.usage.output_tokens"),
      cacheRead: sum("gen_ai.usage.cache_read.input_tokens"), cacheWrite: sum("gen_ai.usage.cache_creation.input_tokens"), cost: sum("gen_ai.usage.cost") },
  }, null, 2));
});
it("A2.3/4: missing delta is not a zero-token generation and marks the aggregate incomplete", async () => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}"); });
  const pi = await openPi();
  try { await pi.start(); pi.peer.send(...assistant("known"), ...assistant("missing", { usage: null }), ...terminal); await pi.settled(); }
  finally { await pi.close(); }
  expect(spans(bodies).filter(s => s.name === "pi.model.usage")).toHaveLength(1);
  const aggregate = spans(bodies).find(s => s.name === "pi.turn.overflow");
  expect(aggregate).toBeDefined();
  expect(attrs(aggregate)).toMatchObject({ "paperclip.observability.incomplete": true, "paperclip.observability.totals_exact": false, "paperclip.observability.skipped_usage_count": 1 });
  expect(attrs(aggregate)).not.toHaveProperty("gen_ai.usage.input_tokens");
});
it("A2.5: estimated cost is explicitly catalog_estimate, never provider billing", async () => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response("{}"); });
  const pi = await openPi();
  try {
    await pi.start(); pi.peer.send(...assistant("estimate", { usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } } }), ...terminal); await pi.settled();
  } finally { await pi.close(); }
  const usage = spans(bodies).find(s => s.name === "pi.model.usage");
  expect(usage).toBeDefined();
  expect(attrs(usage)).toMatchObject({ "gen_ai.usage.cost": 0.25, costProvenance: "catalog_estimate" });
});
it.each(["hang", "500", "dns"])("R6: %s receiver cannot change outcome or block terminal delivery; diagnostic is sanitized", async fault => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  let requests = 0, active = 0, peak = 0;
  const settleMs: number[] = [];
  const server = createServer((_req, res) => {
    requests++; active++; peak = Math.max(peak, active);
    res.once("close", () => active--);
    if (fault === "500") { res.writeHead(500); res.end(sentinel); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  if (fault === "dns") vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => { throw new TypeError(`getaddrinfo ENOTFOUND ${sentinel}`); }));
  const pi = await openPi({ ...environment, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces` });
  try {
    const turns = fault === "hang" ? 5 : 1;
    for (let i = 1; i <= turns; i++) {
      await pi.start();
      pi.peer.send(...assistant(`fault-${i}`));
      await vi.waitFor(() => expect(pi.events.filter(e => e.eventType === "usage.reported")).toHaveLength(i), { interval: 1 });
      const start = performance.now(); pi.peer.send(...terminal); await pi.settled(i);
      settleMs.push(performance.now() - start);
      expect(settleMs.at(-1)).toBeLessThan(50);
      if (fault === "hang" && i <= 4) await vi.waitFor(() => expect(requests).toBe(i), { interval: 1 });
    }
    await pi.close();
    expect(pi.events.filter(e => e.eventType === "turn.completed")).toHaveLength(turns);
    if (fault === "hang") { expect(requests).toBe(4); expect(peak).toBeLessThanOrEqual(4); }
    expect(warnings).toHaveBeenCalledWith("Company observability export unavailable (export_failed).");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(sentinel);
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `R6-${fault}.json`), JSON.stringify({ fault, requests, peak, settleMs,
      completed: pi.events.filter(e => e.eventType === "turn.completed").length, diagnostics: warnings.mock.calls }, null, 2));
  } finally {
    await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 8000);
