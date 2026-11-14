import { createServer } from "node:http";
import { once } from "node:events";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { F1_HISTORY, F1_MESSAGE, F1_REFUSALS, f1PersonFlow } from "../../__tests__/helpers/f1-person-flow.js";

let peerDb: Db;

// Controlled provider boundary, shaped like helpers/native-answer-peer.ts.
// The REAL native runtime composes the fresh handoff and pending input, calls
// startTurn, and persists turn.submitted through its ordinary control-plane port.
// No test constructs that envelope or manually starts the admitted run.
vi.mock("../../vendor/paperclip-runner/index.js", async original => {
  const real = await original<typeof import("../../vendor/paperclip-runner/index.js")>();
  return { ...real, createNativeSessionBackend: (execution: Parameters<typeof real.createNativeSessionBackend>[0]) => {
    const identity = { ...execution.binding, sessionId: execution.session.normalizedSessionId! };
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
    let text = "";
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const contract = execution.completionContract.contract as { revision: string; criteria: Array<{ id: string }> };
    const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Controlled input receipt.",
      completionClaim: { contractRevision: contract.revision, objectiveSatisfied: true,
        criteria: contract.criteria.map(criterion => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [] };
    const session = {
      identity: () => identity, capabilities: async () => capabilities,
      startTurn: async (turn: { message: { text: string } }) => { text = turn.message.text; started(); return { turnId: "f1-input-turn" }; },
      async *events() {
        await ready;
        const [run] = await peerDb.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
        if (!run?.runnerInstanceId) throw new Error("F1 peer requires the selected runner identity");
        const events = [
          { eventType: "turn.submitted", payload: { text } },
          { eventType: "item.completed", payload: { kind: "agentMessage", channel: "final", text: result.summary } },
          { eventType: "run.result.proposed", payload: result },
          { eventType: "turn.completed", payload: {} },
        ];
        for (const [index, event] of events.entries()) yield {
          schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceSeq: index + 1,
          sourceEventId: `${identity.runId}:${index}`, sourceInstanceId: run.runnerInstanceId,
          sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId,
          turnId: "f1-input-turn", priority: 0, emittedAt: new Date().toISOString(), ...event,
        };
      },
      result: async () => result,
      snapshot: async () => ({ backendKind: "mock", identity, sessionId: identity.sessionId, providerSessionId: "f1-input-peer",
        driverKind: execution.session.driverKind, cursor: "4", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], semanticResult: result }),
      close: async () => { started(); },
    };
    return { descriptor: async () => ({ kind: "mock", name: "F1 submitted-input peer", version: "1", capabilities,
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }),
      openSession: async () => session, recoverSession: async () => ({ recovered: true, session }) };
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const listener = createServer((_request, response) => { response.statusCode = 404; response.end(); });
// The normal local executor requires a bound listener even with a controlled
// provider. This is test-local, not a substitute server or a production bypass.
beforeAll(async () => {
  registerLocalRuntimeApiServer(listener);
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
});
afterAll(async () => {
  listener.closeAllConnections();
  if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
});

// Keep: RFL F1-2; a note alone did not prove that the person's input ever
// reached an automatic successor. Read the submitted prompt from durable events.
describe.skipIf(!support.supported)("F1 automatic successor submitted input", () => {
  it.each(F1_REFUSALS)("submits pending person text plus fresh history inside 120 seconds: %s", async refusal => {
    const f = await f1PersonFlow(refusal, "advancing");
    peerDb = f.db;
    try {
      expect((await f.snapshot()).actions).toEqual([]);
      await f.start();
      const final = await f.untilSubmitted(true);
      await f.evidence("submitted-input");
      expect(final.errors).toEqual([]);
      expect(final.elapsedMs).toBeLessThanOrEqual(120_000);
      const successors = final.runs.filter(run => run.id !== f.owner.id && run.id !== f.source.id);
      expect(successors).toHaveLength(1);
      const successor = successors[0];
      expect(successor.nativeSessionId).not.toBe(f.sessionId);
      expect(final.runs.find(run => run.id === f.owner.id)).toMatchObject({ status: "failed", nativePhase: "terminal_failure" });
      expect(final.actions.find(action => action.fingerprint === `native-continuation:${f.owner.id}`))
        .toMatchObject({ status: "resolved", outcome: "restored", evidence: { runId: f.owner.id } });
      expect(final.issue.status).not.toBe("blocked");
      expect(final.blocker).toBeNull();
      expect(final.comments.filter(comment => comment.authorType === "system" && !comment.metadata?.supersededByCommentId)).toHaveLength(1);
      const submitted = final.events.filter(event => event.runId === successor.id && event.eventType === "turn.submitted");
      expect(submitted).toHaveLength(1);
      const payload = submitted[0].payload as { prpEvent: { payload: { text: string } } };
      const envelope = JSON.parse(payload.prpEvent.payload.text) as { task: { prompt: string } };
      expect(envelope.task.prompt).toContain("pending comments: 1/1");
      expect(envelope.task.prompt).toContain(F1_MESSAGE);
      expect(envelope.task.prompt).toContain("## Fresh session handoff");
      expect(envelope.task.prompt).toContain(F1_HISTORY);
      expect(envelope.task.prompt).toContain("Noted ALDER-B.");
      // Provider output here is controlled. This proves automatic submission,
      // not a real model answer or live Boat qualification.
    } finally { await f.cleanup(); }
  }, 120_000);
});
