import { expect, it, vi } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { createOpenCodeCompanyObservability } from "../opencode/company-observability.js";
import { PI_COMPANY_OBSERVABILITY } from "./pi-observability-events.js";
import { attrs, environment, spans } from "./pi-observability.test-fixture.js";
const event = (eventType: PrpEvent["eventType"], payload: Record<string, unknown> = {}, itemId?: string): PrpEvent => ({
  schema: "paperclip.prp.event.v1", sourceEventId: "e", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner", runId: "run", normalizedSessionId: "session", turnId: "turn", itemId,
  eventType, payload, emittedAt: new Date().toISOString(), schemaVersion: 1, priority: 1,
});
it("H2: JSON escaping may require more than four chunks; stream every span without exceeding in-flight admission", async () => {
  const bodies: any[] = [];
  let active = 0, peak = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    active++; peak = Math.max(peak, active);
    const body = String(init?.body);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1048576);
    bodies.push(JSON.parse(body));
    await new Promise<void>(resolve => setImmediate(resolve)); active--;
    return new Response("{}");
  });
  const observer = createOpenCodeCompanyObservability({ environment, model: "test", sensitiveValues: [], profile: PI_COMPANY_OBSERVABILITY, fetch: fetcher })!;
  expect(observer).toBeDefined();
  observer.observe(event("turn.submitted"));
  for (let i = 0; i < 64; i++) observer.observe(event("tool.execution.completed", { name: "read", output: "\0".repeat(8192) }, String(i)));
  observer.observe(event("turn.completed"));
  await observer.close();
  expect(bodies.length).toBeGreaterThan(4);
  expect(peak).toBeLessThanOrEqual(4);
  expect(spans(bodies)).toHaveLength(65);
  expect(new Set(spans(bodies).map(s => s.spanId)).size).toBe(65);
  for (const span of spans(bodies).slice(1)) expect(attrs(span)["langfuse.observation.output"]).toBe("\0".repeat(8192));
});
