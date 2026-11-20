import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindCommentIngressTiming, drainCommentIngressTimings, markCommentIngressRunInserted, measureCommentIngress, withCommentIngressTiming } from "./comment-ingress-timing.js";
import { createNativeRunTrace, nativeRunPreparationStarts } from "./native-runtime/native-run-trace.js";

const comment = () => ({ id: randomUUID(), createdAt: new Date() });
describe("comment ingress historical spans", () => {
  it("preserves the measured value and the original error without a recorder or I/O", async () => {
    const value = {}, failure = new Error("original");
    expect(await measureCommentIngress("comment.ingress.no_scope", () => value)).toBe(value);
    await expect(measureCommentIngress("comment.ingress.no_scope", () => { throw failure; })).rejects.toBe(failure);
    const c = comment();
    await withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      await expect(measureCommentIngress("comment.ingress.failure", () => { throw failure; })).rejects.toBe(failure);
      markCommentIngressRunInserted(c.id);
    });
    expect(drainCommentIngressTimings([c.id])).toEqual(expect.arrayContaining([expect.objectContaining({ name: "comment.ingress.failure", outcome: "failed" })]));
  });
  it("does not mix concurrent comments and consumes each accepted input once", async () => {
    const cs = [comment(), comment()];
    await Promise.all(cs.map((c, i) => withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      await measureCommentIngress(`comment.ingress.owner_${i}`, async () => { await Promise.resolve(); });
      markCommentIngressRunInserted(c.id);
    })));
    for (const [i, c] of cs.entries()) {
      expect(drainCommentIngressTimings([c.id]).map(s => s.name)).toEqual(["comment.to_run_inserted", `comment.ingress.owner_${i}`]);
      expect(drainCommentIngressTimings([c.id])).toEqual([]);
    }
  });
  it("an older outbox message's INSERT cannot end the current POST's span", async () => {
    const c = comment();
    await withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      markCommentIngressRunInserted(randomUUID());
      await measureCommentIngress("comment.ingress.current", () => true);
      markCommentIngressRunInserted(c.id);
      await measureCommentIngress("comment.ingress.after_insert", () => true);
    });
    expect(drainCommentIngressTimings([c.id]).map(s => s.name)).toEqual(["comment.to_run_inserted", "comment.ingress.current"]);
  });
  it("coalesced or cross-process input without an observed INSERT is not invented", async () => {
    const c = comment();
    await withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      await measureCommentIngress("comment.ingress.coalesced", () => true);
    });
    expect(drainCommentIngressTimings([c.id])).toEqual([]);
    expect(drainCommentIngressTimings([randomUUID()])).toEqual([]);
  });
  it("retains in-flight parents if native dispatch drains before the HTTP call returns", async () => {
    const c = comment();
    await withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      await measureCommentIngress("comment.ingress.parent", async () => {
        await measureCommentIngress("comment.ingress.child", () => true);
        markCommentIngressRunInserted(c.id);
        const spans = drainCommentIngressTimings([c.id]);
        expect(spans.map(s => s.name)).toEqual(["comment.to_run_inserted", "comment.ingress.parent", "comment.ingress.child"]);
        for (const span of spans) expect(span.endedAtMs).toBeGreaterThanOrEqual(span.startedAtMs);
        expect(nativeRunPreparationStarts(spans, Date.now()).preparationStartedAtMs).toBeGreaterThanOrEqual(Math.max(...spans.map(s => s.endedAtMs)));
        const events: string[] = [];
        const parents: Record<string, unknown> = {};
        const trace = createNativeRunTrace({ runId: randomUUID(), onEvent: async event => {
          if (event.eventType === "run.performance.span") {
            events.push(String(event.payload?.span));
            parents[String(event.payload?.span)] = event.payload?.parentSpan;
          }
        } });
        for (const span of spans) await trace.record(span);
        await trace.finish("ok");
        expect(events).toEqual(expect.arrayContaining(["comment.to_run_inserted", "comment.ingress.parent", "comment.ingress.child"]));
        expect(parents).toMatchObject({ "comment.ingress.parent": "comment.to_run_inserted",
          "comment.ingress.child": "comment.ingress.parent" });
      });
    });
  });
  it("bounded detail never suppresses the underlying work", async () => {
    const c = comment(); let calls = 0;
    await withCommentIngressTiming(async () => {
      bindCommentIngressTiming(c);
      for (let i=0; i<600; i++) await measureCommentIngress("comment.ingress.bounded", () => ++calls);
      markCommentIngressRunInserted(c.id);
    });
    expect(calls).toBe(600);
    expect(drainCommentIngressTimings([c.id])).toHaveLength(513);
  });
});
