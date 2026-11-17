import { createServer } from "node:http";
import { once } from "node:events";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { F1_HISTORY, F1_MESSAGE, F1_REFUSALS, F1_REPLAY_ANSWER, F1_REPLAY_REQUEST, f1PersonFlow,
} from "../../__tests__/helpers/f1-person-flow.js";

const SR_ANSWER_TEXT = "SR-ANSWER: you said yes, so the word is ALDER-B.";
const SR_PARKED_TEXT = "I re-asked you and I'm parked waiting for your answer.";

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
    const result: Record<string, unknown> = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Controlled input receipt.",
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
        // Silent-replay script (stands in for the live model, f5c33c68): it acts on
        // the person's answer only when the turn's input carries it; otherwise it
        // re-asks (rejected: the idempotency key exists). Output only; the RED
        // assertions read the built input, not this script.
        const replayTurn = text.includes(F1_REPLAY_REQUEST.slice(0, 40));
        const answerSeen = (execution.interactionResponses ?? []).some(response => response.response.status === "answered");
        const scripted: Array<{ eventType: string; itemId?: string; payload: Record<string, unknown> }> = !replayTurn ? [] : [
          ...(!answerSeen ? [
            { eventType: "item.started", itemId: "sr-reask", payload: { kind: "dynamicToolCall", item: { type: "dynamicToolCall", tool: "request_human_input" } } },
            { eventType: "item.failed", itemId: "sr-reask", payload: { kind: "dynamicToolCall", error: "Interaction idempotency key already exists for a different request" } },
          ] : []),
        ];
        if (replayTurn) Object.assign(result, { reportedWorkDisposition: "yielded", summary: answerSeen ? SR_ANSWER_TEXT : SR_PARKED_TEXT,
          continuation: { kind: "response_wake", idempotencyKey: "sr-park-response-wake", summary: "Parked for the person's next message." } });
        const events = [
          { eventType: "turn.submitted", payload: { text } },
          ...scripted,
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

  // RED silent-replay INPUT side (RFL 10:21Z binding scope: (a) the carry + (a') the current-state
  // contract; org 09:38Z/09:56Z). Replays gate 3's rows (db-f5c33c68.txt): the person answered
  // question 1c287ff0; the run that answer woke (a37d4698, `f.source`, its nativeExecutionInput held the
  // answer) was refused; the automatic successor (f5c33c68: forceFreshSession, wake
  // issue_recovery_action_restored, retry_of a37d4698) is seeded by execution-recovery-resolution.ts
  // -> continuation-comment-input.ts, built by heartbeat/runtime-selection.ts (materializer + contract)
  // and heartbeat/session-preparation.ts -> native-session-handoff.ts (fresh history). Asserts read the
  // successor's ACTUAL built input: nativeExecutionInput and the submitted model envelope.
  it("silent-replay: the automatic successor's input is the person's answer, not the old turn", async () => {
    const f = await f1PersonFlow(F1_REFUSALS[0], "advancing", "answered_question");
    peerDb = f.db;
    try {
      await f.start();
      let final = await f.untilSubmitted(true);
      const isSuccessor = (runId: string) => ![f.owner.id, f.source.id, f.replay!.askerId].includes(runId);
      // Wait for the successor's own submitted model envelope (bounded).
      for (let i = 0; i < 40 && !final.events.some(event => isSuccessor(event.runId) && event.eventType === "turn.submitted"); i += 1) {
        await vi.advanceTimersByTimeAsync(500);
        await f.hb.drainActiveRunExecutions();
        final = await f.snapshot();
      }
      await f.evidence("silent-replay");
      const successors = final.runs.filter(run => isSuccessor(run.id));
      expect(successors).toHaveLength(1);
      const successor = successors[0];
      const context = successor.contextSnapshot as Record<string, unknown>;
      // The successor's live shape (f5c33c68.context_snapshot).
      expect(context).toMatchObject({ forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" });
      const input = successor.runnerProfileJson?.nativeExecutionInput as { interactionResponses?: Array<{ interactionId: string;
        response: { status: string } }>; task?: { prompt?: string }; completionContract?: { contract?: { criteria?: Array<{ requirement: string }> } } } | undefined;
      const submitted = final.events.find(event => event.runId === successor.id && event.eventType === "turn.submitted");
      const envelope = JSON.parse(String((submitted?.payload as { prpEvent?: { payload?: { text?: string } } } | undefined)
        ?.prpEvent?.payload?.text ?? "{}")) as { task?: { prompt?: string }; completionContract?: { criteria?: Array<{ requirement: string }> } };
      const modelPrompt = envelope.task?.prompt ?? "";
      const wakeAt = modelPrompt.indexOf("## Paperclip Wake Payload");
      const handoff = wakeAt > 0 ? modelPrompt.slice(0, wakeAt) : "";
      const oldTurn = F1_REPLAY_REQUEST.slice(0, 40);
      const observed = {
        envelopeSubmitted: modelPrompt.length > 0,
        retryOf: successor.retryOfRunId === f.source.id ? "source" : successor.retryOfRunId,
        // (i) the person's answer is the successor's native input.
        answer: input?.interactionResponses?.filter(response => response.interactionId === f.replay!.interactionId)
          .map(response => response.response.status),
        // (ii) neither the built prompt nor the completion contract re-requests the old turn.
        contractReRequests: [...(input?.completionContract?.contract?.criteria ?? []), ...(envelope.completionContract?.criteria ?? [])]
          .filter(criterion => criterion.requirement.includes(oldTurn)).length,
        wakeReRequests: [input?.task?.prompt ?? "", wakeAt >= 0 ? modelPrompt.slice(wakeAt) : modelPrompt]
          .filter(prompt => prompt.includes(oldTurn)).length,
        // (iii) the fresh history is not cut at the old park comment: it holds the question and its answer.
        handoffHasQuestion: handoff.includes("Repeat the word when I continue?"),
        handoffHasAnswer: handoff.includes(F1_REPLAY_ANSWER),
      };
      await appendObserved({ observed, successorContext: Object.fromEntries(Object.entries(context).filter(([key]) =>
        /^(source|wakeReason|retryOfRunId|previousRunId|forceFreshSession|commentId|wakeCommentId|wakeCommentIds|interactionIds?|interactionKind|conversationReplayThroughCommentId)$/.test(key))),
      interactionResponses: input?.interactionResponses, criteria: input?.completionContract?.contract?.criteria, handoff });
      expect(observed).toEqual({ envelopeSubmitted: true, retryOf: "source", answer: ["answered"], contractReRequests: 0, wakeReRequests: 0,
        handoffHasQuestion: true, handoffHasAnswer: true });
    } finally { await f.cleanup(); }
  }, 120_000);
});

async function appendObserved(observed: unknown) {
  const file = process.env.PAPERCLIP_SILENT_REPLAY_OBSERVED;
  if (file) await (await import("node:fs/promises")).appendFile(file, `${JSON.stringify(observed)}\n`);
}
