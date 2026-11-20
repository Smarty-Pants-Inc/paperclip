import { describe, expect, it } from "vitest";
import { PAPERCLIP_PERSON_STOPPED_PREVIOUS_TURN_NOTE } from "@paperclipai/adapter-utils/server-utils";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";
import { buildNativeExecutionWithCheckpoint, nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, nativeSessionKey } from "./native-session-executor.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000002";
const issueId = "30000000-0000-4000-8000-000000000003";
const firstRun = "40000000-0000-4000-8000-000000000004";
const nextRun = "50000000-0000-4000-8000-000000000005";
const sessionId = "60000000-0000-4000-8000-000000000006";
function execution(runId: string, id = sessionId) {
  return buildNativeExecutionInput({ companyId, agentId, runId,
    issue: { id: issueId, identifier: null, title: "Daily conversation", description: null, workMode: "standard" },
    taskPrompt: "Current message", workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: id, provider: "pi_rpc", model: "provider/model-a",
    completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`,
      schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } },
    runtimeContext: nativeRuntimeContextFixture(),
  });
}
function prior(previous = execution(firstRun)) {
  return { id: firstRun, companyId, agentId, nativeSessionId: sessionId, runnerProfileJson: {
    nativeExecutionInput: previous, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("local", "pi_rpc"),
    sessionCheckpoint: { backendKind: "runner", driverKind: "pi_rpc", sessionId: "pi-facade", providerSessionId: "pi-header",
      identity: { runId: firstRun, sessionId, companyId, issueId, agentId }, cursor: "42", semanticResult: null,
      terminal: null, activeTurnId: null, terminalTurns: [], pendingRuntimeRequests: [] },
  } };
}

describe("Pi conversation identity is not a checkpoint/config generation (data safety, #20303)", () => {
  it("does not remint on first admission without a checkpoint", () => {
    const result = buildNativeExecutionWithCheckpoint({ previousRun: null, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId }) => execution(nextRun, normalizedSessionId) });
    expect(result.normalizedSessionId).toBe(sessionId);
    expect(result.execution.session.normalizedSessionId).toBe(sessionId);
  });
  it("keeps the record id when no reusable checkpoint exists", () => {
    const result = buildNativeExecutionWithCheckpoint({ previousRun: { ...prior(), runnerProfileJson: {} }, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId }) => execution(nextRun, normalizedSessionId) });
    expect(result.normalizedSessionId).toBe(sessionId);
    expect(result.checkpoint).toBeNull();
  });
  it("fails closed at the executor mint site instead of using session-${runId}", () => {
    const current = execution(nextRun);
    current.session.normalizedSessionId = undefined as unknown as string;
    expect(() => nativeSessionKey(current)).toThrow("pi_conversation_identity_missing");
  });
});

// c1-prime (Paul interrupts after STEP1; the SAME Pi session continues and is re-sent the whole task).
// The receipts list is the guard that stops a redo of STEP1: it stays; only the false
// "fresh session" wording becomes true. C1 removed the list and the model redid STEP1 on two real takes.
describe("same-session Interrupt successor keeps the receipts list with true wording (c1-prime)", () => {
  const interruptedRunId = "80000000-0000-4000-8000-000000000008";
  const wakePayload = {
    reason: "issue_commented",
    issue: { id: issueId, identifier: null, title: "Daily conversation", status: "in_progress", priority: "medium" },
    personStoppedPreviousTurn: true,
    interruptedTurnToolCalls: [{ name: "echo STEP1 > /tmp/step1", status: "completed", output: "STEP1-RESULT-wrote-step1" }],
    executionContinuation: {
      version: 1, companyId, issueId, objective: "Six steps", interruptedRunId,
      trigger: { reason: "issue_commented", interactionId: null, sourceRunId: interruptedRunId },
      originCommentIds: [], messages: [], humanResponses: [], interactionOutcomes: [], completedWork: null,
      unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    },
  };
  function successor(runId: string, id: string, resumedSession: boolean) {
    return buildNativeExecutionInput({ companyId, agentId, runId,
      issue: { id: issueId, identifier: null, title: "Daily conversation", description: null, workMode: "standard" },
      taskPrompt: "Run STEP1..STEP6", workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: id, provider: "pi_rpc", model: "provider/model-a", wakePayload, resumedSession,
      completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
  }
  function request(previousRun: Parameters<typeof buildNativeExecutionWithCheckpoint>[0]["previousRun"]) {
    const built = buildNativeExecutionWithCheckpoint({ previousRun, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId, resumedSession }) => successor(nextRun, normalizedSessionId, resumedSession) });
    // Every string the model request carries, as the model reads it.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(buildNativeModelEnvelope(built.execution));
    return { built, text: strings.join("\n\n") };
  }
  const RECEIPTS = /\n## Commands already run in the interrupted turn \(do not run these again\)\n[\s\S]*Do not run them again; continue from the next step\.[\s\S]*\n1\. `echo STEP1 > \/tmp\/step1`: completed\n {3}result: STEP1-RESULT-wrote-step1/;

  it("verified same session (checkpoint rebinds): receipts list present, no 'fresh session' text", () => {
    const { built, text } = request(prior(successor(firstRun, sessionId, false)));
    expect(built.checkpoint, "the server verified the same session continues").not.toBeNull();
    expect(text, "the receipts list is the guard against redoing STEP1: never removed").toMatch(RECEIPTS);
    expect(text, "a continuing session is never told it is fresh").not.toMatch(/fresh session/i);
    expect(text).toContain("The tool calls below already ran in this session (completed or started)");
    expect(text).toContain("already ran; do not run them again; continue from the next step");
    // rf-4 wording bar: with the whole task re-sent, never point the model at its history.
    const corrected = text.split("\n").filter((line) => line.startsWith("The person interrupted") || line.startsWith("A previous run on this task"));
    expect(corrected).toHaveLength(2);
    for (const line of corrected) expect(line).not.toMatch(/history|Continue from the existing work/i);
  });

  it("fresh successor (no previous run) and fallback (checkpoint fails): byte-identical fresh wording with the list", () => {
    const fresh = request(null);
    const fallback = request({ ...prior(), runnerProfileJson: {} });
    expect(fallback.built.checkpoint).toBeNull();
    for (const { text } of [fresh, fallback]) {
      expect(text).toMatch(RECEIPTS);
      expect(text).toContain("This fresh session does not hold that turn; the tool calls below are the calls recorded since your last reply");
      expect(text).toContain("This is a fresh session: that run's conversation and tool calls are not in this input");
      expect(text).not.toContain("already ran in this session");
    }
    expect(fallback.text).toBe(fresh.text);
  });
});

// adopt-a2-order (Paul's agent is frozen in `sleep 600`; he presses Interrupt and asks "9 + 10").
// The successor got the cut `sleep 600` and the new message together and finished the OLD request first:
// "19" never came. With a new message carried, it is answered first; a cut-mid-flight call is not re-run
// unless the person asks. The receipts list stays (lesson C1).
describe("Interrupt successor carrying a new message answers it first (adopt-a2-order)", () => {
  const interruptedRunId = "80000000-0000-4000-8000-000000000009";
  const commentId = "90000000-0000-4000-8000-000000000010";
  const continuation = {
    version: 1, companyId, issueId, objective: "Wait ten minutes", interruptedRunId,
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: interruptedRunId },
    originCommentIds: [], messages: [], humanResponses: [], interactionOutcomes: [], completedWork: null,
    unresolvedInteractionIds: [], coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
  };
  const interruptWake = {
    reason: "issue_commented",
    issue: { id: issueId, identifier: null, title: "Daily conversation", status: "in_progress", priority: "medium" },
    // adopt-a2-order3: an Interrupt never carries personStoppedPreviousTurn (server-owned, Stop only:
    // readPersonStoppedPreviousTurn never matches an Interrupt). The Stop row below sets it.
    interruptedTurnToolCalls: [
      { name: "bash", target: "echo STEP1 > /tmp/step1", status: "completed", output: "STEP1-RESULT-wrote-step1" },
      { name: "bash", target: "sleep 600", status: "interrupted", output: "" },
    ],
    commentIds: [commentId], latestCommentId: commentId,
    comments: [{ id: commentId, issueId, body: "9 + 10", createdAt: "2026-11-20T00:00:00.000Z", author: { type: "user", id: "paul" } }],
    executionContinuation: continuation,
  };
  // No Interrupt: a plain continuation with a new message (must render as at base).
  const { interruptedTurnToolCalls: _t, ...plainWake } = interruptWake;
  function successor(wakePayload: Record<string, unknown>, id: string, resumedSession: boolean, runId = nextRun) {
    return buildNativeExecutionInput({ companyId, agentId, runId,
      issue: { id: issueId, identifier: null, title: "Daily conversation", description: null, workMode: "standard" },
      taskPrompt: "9 + 10", workspace: { id: runId, cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: id, provider: "pi_rpc", model: "provider/model-a", wakePayload, resumedSession,
      completionContract: { id: "70000000-0000-4000-8000-000000000007", sha256: `sha256:${"a".repeat(64)}`,
        schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Answer", criteria: [{ id: "answer", requirement: "Answer" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
  }
  function request(wakePayload: Record<string, unknown>, previousRun: Parameters<typeof buildNativeExecutionWithCheckpoint>[0]["previousRun"]) {
    const built = buildNativeExecutionWithCheckpoint({ previousRun, normalizedSessionId: sessionId,
      buildExecution: ({ normalizedSessionId, resumedSession }) => successor(wakePayload, normalizedSessionId, resumedSession) });
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(buildNativeModelEnvelope(built.execution));
    return { built, text: strings.join("\n\n") };
  }
  const ANSWER_FIRST = "The person interrupted your previous turn and sent a new message. Answer their new message first.";
  const CUT_NOT_RERUN = "A call marked interrupted was cut mid-flight. If it was only a wait or sleep, do not run it again unless the person asks.";
  const LIST = /\n## Commands already run in the interrupted turn \(do not run these again\)\n[\s\S]*Do not run them again[.;][\s\S]*\n1\. `bash` \(`echo STEP1 > \/tmp\/step1`\): completed\n {3}result: STEP1-RESULT-wrote-step1\n2\. `bash` \(`sleep 600`\): interrupted/;

  for (const [name, previousRun, sameSession] of [
    ["fresh successor (new session)", null, false],
    ["same-session successor (checkpoint rebinds)", "prior", true],
  ] as const) {
    it(`${name}: new message answered first, cut sleep not re-run, completed steps still listed`, () => {
      const { built, text } = request(interruptWake, previousRun === "prior" ? prior(successor(interruptWake, sessionId, false, firstRun)) : null);
      expect(built.checkpoint !== null, "session identity of this row").toBe(sameSession);
      expect(text, "the receipts list is never removed (C1)").toMatch(LIST);
      expect(text, "the new message is answered first").toContain(ANSWER_FIRST);
      expect(text, "a cut-mid-flight wait is not re-run unless asked").toContain(CUT_NOT_RERUN);
      expect(text).toContain("9 + 10");
      expect(text.indexOf(ANSWER_FIRST), "said before the list").toBeLessThan(text.indexOf("1. `bash`"));
      // Nothing points the model back at the old request ahead of the new message.
      expect(text).not.toMatch(/continue from the next step|continue from the (conversation|history|existing work)|Continue from the latest user request/i);
      expect(text.indexOf(ANSWER_FIRST), "answer first, before any re-run check").toBeLessThan(text.indexOf("check whether it took effect"));
    });
  }

  it("fresh Interrupt model input: answer 9 + 10 before a cut sleep, preserving completed echo STEP1", () => {
    const input = successor({ ...interruptWake,
      interruptedTurnToolCalls: [
        { name: "bash", target: "echo STEP1", status: "completed", output: "STEP1" },
        { name: "bash", target: "sleep 600", status: "interrupted", output: "" },
      ],
    }, sessionId, false);
    // Read the real fresh bootstrap envelope, not a receipt fixture or a resumed-session delta.
    const envelope = buildNativeModelEnvelope(input);
    const text = envelope.task.prompt;
    expect(input.continuationPrompt ?? null).toBeNull();
    expect.soft(text, "the person's new request is answered first").toContain(ANSWER_FIRST);
    expect.soft(text, "an Interrupt is not a Stop").not.toContain("The person stopped your previous turn");
    expect.soft(text, "the authenticated new comment is the current request, not the old wait objective")
      .toMatch(/New comments in order:\n1\. comment [^\n]+ by user paul\n9 \+ 10(?:\n|$)/);
    expect.soft(text, "completed work is carried with its saved result")
      .toMatch(/## Commands already run in the interrupted turn \(do not run these again\)[\s\S]*\n1\. `bash` \(`echo STEP1`\): completed\n {3}result: STEP1\n2\. `bash` \(`sleep 600`\): interrupted: it may or may not have taken effect/);
    expect.soft(text, "completed calls must not be run again")
      .toContain("the completed calls below must not be run again.");
    expect.soft(text, "a cut sleep is a wait, not a command to replay").toContain(CUT_NOT_RERUN);
    expect.soft(text.indexOf(ANSWER_FIRST), "answer-first instruction precedes the cut sleep receipt")
      .toBeGreaterThanOrEqual(0);
    expect.soft(text.indexOf(ANSWER_FIRST)).toBeLessThan(text.indexOf("2. `bash` (`sleep 600`)"));
    const unknownOutcomesNote = "Earlier actions with unknown outcomes are not confirmed or replayed";
    expect.soft(!text.includes(unknownOutcomesNote) || text.includes(CUT_NOT_RERUN),
      "an unknown-outcomes notice cannot replace explicit do-not-replay-wait guidance").toBe(true);
  });

  it("fresh Stop model input: answer 9 + 10 without continuing the stopped work, preserving completed echo STEP1", () => {
    const input = successor({ ...interruptWake, personStoppedPreviousTurn: true,
      interruptedTurnToolCalls: [
        { name: "bash", target: "echo STEP1", status: "completed", output: "STEP1" },
        { name: "bash", target: "sleep 600", status: "interrupted", output: "" },
      ],
    }, sessionId, false);
    const text = buildNativeModelEnvelope(input).task.prompt;
    expect(input.continuationPrompt ?? null).toBeNull();
    expect.soft(text).toContain(PAPERCLIP_PERSON_STOPPED_PREVIOUS_TURN_NOTE);
    expect.soft(text).toContain("The person stopped your previous turn and sent a new message. Answer their new message. Do not resume or redo the stopped work unless they ask; the completed calls below must not be run again.");
    expect.soft(text).toMatch(/New comments in order:\n1\. comment [^\n]+ by user paul\n9 \+ 10(?:\n|$)/);
    expect.soft(text, "Stop carries the same saved receipts as Interrupt")
      .toMatch(/## Commands already run in the interrupted turn \(do not run these again\)[\s\S]*\n1\. `bash` \(`echo STEP1`\): completed\n {3}result: STEP1\n2\. `bash` \(`sleep 600`\): interrupted: it may or may not have taken effect/);
    expect.soft(text, "a Stop never instructs the successor to continue").not.toMatch(/\bcontinue\b/i);
    expect.soft(text).not.toContain("Then continue");
    expect.soft(text).not.toContain(ANSWER_FIRST);
  });

  // adopt-a2-order2 (rf-4 T2 bar): the person interrupts a 6-step task after STEP2 while STEP3 (not a wait) is
  // mid-flight and asks "9 + 10". The answer comes first, but STEP3-6 must still be done: the words must say to
  // continue from the next unfinished step and must not forbid re-running a cut call that was not a wait.
  it("6-step task cut at STEP3 (not a wait): new message first, then continue from the next unfinished step", () => {
    const sixStepWake = { ...interruptWake,
      interruptedTurnToolCalls: [
        { name: "bash", target: "echo STEP1 > /tmp/step1", status: "completed", output: "STEP1-done" },
        { name: "bash", target: "echo STEP2 > /tmp/step2", status: "completed", output: "STEP2-done" },
        { name: "bash", target: "echo STEP3 > /tmp/step3", status: "interrupted", output: "" },
      ],
      executionContinuation: { ...continuation, objective: "Run STEP1 to STEP6 in order" },
    };
    for (const previousRun of [null, "prior"] as const) {
      const { text } = request(sixStepWake, previousRun === "prior" ? prior(successor(sixStepWake, sessionId, false, firstRun)) : null);
      expect(text).toContain("9 + 10");
      expect(text, "answer first").toContain("Answer their new message first.");
      const resume = text.search(/continue[^.\n]* from the next unfinished step/);
      expect(resume, "says to continue the task from the next unfinished step").toBeGreaterThan(-1);
      expect(text.indexOf("Answer their new message first."), "answer before continuing").toBeLessThan(resume);
      expect(text, "STEP3 (not a wait) is not forbidden").not.toMatch(/cut mid-flight\. Do not run it again unless the person asks/);
      expect(text, "only a wait or sleep is not re-run").toContain("If it was only a wait or sleep, do not run it again unless the person asks.");
      expect(text, "a cut non-wait call is checked, then run again").toContain("Otherwise check whether it took effect before you run it again.");
      expect(text).not.toMatch(/continue from the (conversation|history|existing work)/i);
      expect(text).toMatch(/\n1\. `bash` \(`echo STEP1 > \/tmp\/step1`\): completed[\s\S]*\n2\. `bash` \(`echo STEP2 > \/tmp\/step2`\): completed[\s\S]*\n3\. `bash` \(`echo STEP3 > \/tmp\/step3`\): interrupted/);
    }
  });

  it("no Interrupt (plain continuation with a new message): none of the Interrupt wording", () => {
    for (const previousRun of [null, prior(successor(plainWake, sessionId, false, firstRun))]) {
      const { text } = request(plainWake, previousRun);
      expect(text).toContain("9 + 10");
      expect(text).not.toContain("Commands already run in the interrupted turn");
      expect(text).not.toContain(ANSWER_FIRST);
      expect(text).not.toContain("cut mid-flight");
    }
  });

  // adopt-a2-order3: a person's STOP (server-owned personStoppedPreviousTurn) with receipts and a new message.
  // The new message is answered; the stopped work is NOT resumed or redone unless asked: none of the
  // Interrupt's 'then continue' wording may leak into a Stop successor. Receipts list still stays (C1).
  it("Stop successor with receipts and a new message: answer it, do not resume the stopped work (no 'continue')", () => {
    const stopWake = { ...interruptWake, personStoppedPreviousTurn: true };
    const STOP_SENTENCE = "The person stopped your previous turn and sent a new message. Answer their new message. Do not resume or redo the stopped work unless they ask; the completed calls below must not be run again.";
    for (const previousRun of [null, "prior"] as const) {
      const { text } = request(stopWake, previousRun === "prior" ? prior(successor(stopWake, sessionId, false, firstRun)) : null);
      expect(text).toContain("9 + 10");
      expect(text, "the Stop note is kept, once").toContain(PAPERCLIP_PERSON_STOPPED_PREVIOUS_TURN_NOTE);
      expect(text.split(PAPERCLIP_PERSON_STOPPED_PREVIOUS_TURN_NOTE)).toHaveLength(2);
      expect(text, "the receipts list is never removed (C1)").toMatch(LIST);
      expect(text, "the Stop sentence").toContain(STOP_SENTENCE);
      expect(text, "no Interrupt text leaks into a Stop").not.toContain("continue the task from the next unfinished step");
      expect(text, "no Interrupt text leaks into a Stop").not.toContain("Then continue");
      expect(text, "no Interrupt text leaks into a Stop").not.toMatch(/next unfinished step|continue from the next step|The person interrupted your previous turn|Answer their new message first|before you run it again/i);
    }
  });

  it("Interrupt without a new message: the base receipts wording, none of the new-message wording", () => {
    const { comments: _c, commentIds: _i, latestCommentId: _l, ...noMessageWake } = interruptWake;
    for (const previousRun of [null, prior(successor(noMessageWake, sessionId, false, firstRun))]) {
      const { text } = request({ ...noMessageWake, reason: "issue_assigned" }, previousRun);
      expect(text).toContain("Do not run them again; continue from the next step. A call marked interrupted was cut mid-flight: check whether it took effect before you run it again.");
      expect(text).not.toContain("new message first");
      expect(text).not.toContain("next unfinished step");
    }
  });
});
