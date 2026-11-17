import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readCompletedAssistantMessageCandidate,
  resolveHeartbeatRunResponse,
  selectHeartbeatRunFinalAgentMessage,
} from "../services/heartbeat-run-summary.js";
import { presentsAcceptedSummary } from "../services/issues.js";

// H5 round 2 (d): the closest real seam the suites support without the
// env-gated full-server Pi e2e (native-pi-rpc-final-channel.e2e.test.ts needs
// a built runner and remote provider pack). The fixture is the exact runner
// event stream emitted by the pack test
// pi_rpc_oversized_finish_is_refused_once_and_the_whole_answer_stays_final
// (runner-core tests/native_provider_backend.rs, PAPERCLIP_H5_RUNNER_EVENTS_OUT):
// a pi_rpc chat whose agent first put a 28 KB answer into paperclip_finish.
// This replays it through the server's finalizer selection
// (native-run-finalizer.ts readCompletedAssistantMessageCandidate ->
// selectHeartbeatRunFinalAgentMessage -> resolveHeartbeatRunResponse) and the
// review gate (issues.ts presentsAcceptedSummary).
// RED: H5_RUNNER_EVENTS=<base stream> replays the base runner's stream.
const path = process.env.H5_RUNNER_EVENTS
  ?? new URL("./fixtures/h5-pi-rpc-oversized-finish-events.json", import.meta.url).pathname;
const stream = JSON.parse(readFileSync(path, "utf8")) as Array<{ eventType: string; payload: Record<string, any> }>;

describe("a pi_rpc chat's 28 KB answer: runner events -> finalization -> one whole posted comment", () => {
  const denials = stream.filter((e) => e.eventType === "harness.diagnostic" && e.payload.code === "semantic_tool_denied"
    && e.payload.operationId === "paperclip_finish");
  const accepted = stream.filter((e) => e.eventType === "semantic_tool.result" && e.payload.semantic_tool?.code === "semantic_tool_succeeded");

  it("the runner refused the oversized finish exactly once, marked for counting", () => {
    expect(denials.map((d) => d.payload.denialCode)).toEqual(["completion_summary_over_cap"]);
    expect(accepted).toHaveLength(1);
    expect(stream.at(-1)?.eventType).toBe("run.terminal");
    expect(stream.at(-1)?.payload.runTerminalState).toBe("succeeded");
  });

  it("finalization posts the whole answer once, not the summary, not truncated", () => {
    const candidates = stream.flatMap((event, seq) => {
      if (event.eventType !== "item.completed") return [];
      const candidate = readCompletedAssistantMessageCandidate({
        seq, prpEvent: { eventType: event.eventType, sourceEventId: `runner-event-${seq}`, itemId: event.payload.itemId, payload: event.payload },
      });
      return candidate ? [candidate] : [];
    });
    const final = selectHeartbeatRunFinalAgentMessage({ candidates });
    expect(final?.channel).toBe("final");
    const whole = final!.text;
    expect(whole.length).toBeGreaterThanOrEqual(28_000);
    // The accepted finish summary is the answer's verbatim opening the runner's
    // over-cap guidance asks for (the fixture provider sent 11,500 characters).
    const summary = Array.from(whole).slice(0, 11_500).join("");
    const resolved = resolveHeartbeatRunResponse({
      resultJson: {
        finalizationPhase: "committed",
        finalizationReasonCode: "completed",
        nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary, evidence: [{ ref: "provider:pi_rpc:agent-message" }] },
      },
      preferFinalResponseOverExistingComment: true,
      externalChatResponseWakeSummaryAuthorized: true,
      externalChatCommittedResponseWakeSummaryAuthorized: true,
      finalAgentMessage: { text: whole, sourceEventId: final!.sourceEventId!, channel: "final" },
    });
    expect(resolved.decision.commentAction).toBe("create");
    expect(resolved.text).toBe(whole);
    expect(resolved.text).not.toMatch(/truncated/i);
    // A review-gated reply of the same body is authorized by that summary.
    expect(presentsAcceptedSummary(summary, resolved.text!)).toBe(true);
    expect(presentsAcceptedSummary(Array.from(whole).slice(0, 2_000).join(""), resolved.text!)).toBe(false);
  });
});
