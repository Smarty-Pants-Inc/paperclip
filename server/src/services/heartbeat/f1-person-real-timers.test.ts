import { describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { F1_REFUSALS, f1PersonFlow } from "../../__tests__/helpers/f1-person-flow.js";

const support = await getEmbeddedPostgresTestSupport();
// Keep: recorded RFL F1-2 incident and the trust boundary between a physically
// stopped old owner and admission. Real timers pin cold private-pool liveness;
// fake-clock tests alone can deadlock before the first DB connection opens.
describe.skipIf(!support.supported)("F1 real-timer automatic successor admission", () => {
  it.each(F1_REFUSALS)("completes admission after the stranded owner settles: %s", async refusal => {
    vi.useRealTimers();
    const f = await f1PersonFlow(refusal, "real");
    try {
      expect(vi.isFakeTimers()).toBe(false);
      expect((await f.snapshot()).actions).toEqual([]);
      await f.start();
      const final = await f.untilSubmitted();
      await f.evidence("real-timer-admission");
      expect(final.errors).toEqual([]);
      expect(final.elapsedMs).toBeLessThanOrEqual(120_000);
      expect(final.runs.find(run => run.id === f.owner.id)).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
      expect(final.actions.find(action => action.fingerprint === `native-continuation:${f.owner.id}`))
        .toMatchObject({ status: "resolved", outcome: "restored", evidence: { runId: f.owner.id } });
      expect(final.issue.status).not.toBe("blocked");
      expect(final.blocker).toBeNull();
      expect(final.comments.filter(comment => comment.authorType === "system" && !comment.metadata?.supersededByCommentId)).toHaveLength(1);
      const successors = final.runs.filter(run => run.id !== f.owner.id && run.id !== f.source.id);
      expect(successors).toHaveLength(1);
      expect(successors[0].nativeSessionId).not.toBe(f.sessionId);
      expect(successors[0].runnerProfileJson?.nativeExecutionInput).toMatchObject({ binding: { runId: successors[0].id } });
      // This test stops at admitted native input; the local API listener/model
      // are not supplied. It does not claim an answered provider turn.
    } finally { await f.cleanup(); }
  }, 120_000);
});
