import { describe, expect, it } from "vitest";
import { projectTaskInterruption } from "./task-interruption-presentation.js";
import { NativeTurnPromptExceedsCommandBoundError, nativePromptCauseFromError, nativePromptRefusalCause, nativePromptRefusalRemedies, assertNativeTurnCommandBound, assertNativeQueuedTurnBound, nativeQueuedTurnUpperBound, nativeSessionHandoffMaxBytes, NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, type NativePromptRefusalCause } from "./native-runtime/native-turn-budget.js";
import { renderNativeSessionHandoff } from "./native-runtime/native-session-handoff.js";

const issue = { id: "task", companyId: "11111111-1111-4111-8111-111111111111", status: "blocked", assigneeAgentId: "agent", projectId: "22222222-2222-4222-8222-222222222222" };
const run = { id: "run", agentId: "agent", status: "failed", scheduledRetryAt: null,
  errorCode: "project_access_denied", error: null, livenessState: null,
  resultJson: { projectAccessDenied: { projectId: "22222222-2222-4222-8222-222222222222" } } };
const agent = { status: "idle", pauseReason: null };

// Unit test agreed in task: pure refusal projection and measurement must truthfully
// name the compared data and an existing edit/escalation path; no provider needed.
describe("C31 v10 refusal measures and supported exits", () => {
  const projectCause = (cause: Omit<NativePromptRefusalCause, "remedies"> & { remedies?: NativePromptRefusalCause["remedies"] }) => projectTaskInterruption(issue, {
    run: { ...run, errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, resultJson: { nativeTurnPromptRefusalCause: cause } },
    agent, paused: false, approval: false,
  });
  const refusal = (work: () => void) => {
    try { work(); } catch (error) {
      expect(error).toBeInstanceOf(NativeTurnPromptExceedsCommandBoundError);
      return (error as NativeTurnPromptExceedsCommandBoundError).promptCause!;
    }
    throw new Error("expected a measured refusal");
  };

  it.each([
    { kind: "future-input_v12", bytes: 25, remedies: [] },
    { kind: "command", bytes: 123, measure: "future-measure_v12", remedies: [] },
    { kind: "stale_copy", bytes: 25, measure: "future_measure", remedies: [] },
  ])("C31 v11 preserves readable fields through version skew: %j", cause => {
    expect(nativePromptRefusalCause(cause)).toEqual(cause);
    const parsed = nativePromptCauseFromError(new Error(`native_prompt_cause=${cause.kind}:${cause.bytes}${"measure" in cause ? `:measure=${cause.measure}` : ""}`));
    expect(parsed).toEqual(cause);
    const presentation = projectCause(parsed!);
    expect(presentation).toMatchObject({ canRetry: false, failure: { cause } });
    if (cause.kind === "future-input_v12") {
      expect(presentation?.failure?.title).toBe("Task input could not be sent");
      expect(presentation?.failure?.detail).not.toMatch(/too large|Edit the description/);
    } else if (cause.kind === "stale_copy") {
      expect(presentation?.failure?.title).toBe("Session input contains stale history");
      expect(presentation?.failure?.detail).not.toMatch(/too large|Edit the description/);
    } else {
      expect(presentation?.failure?.detail).toContain("no recognized measurement label");
      expect(presentation?.failure?.detail).not.toContain("1 KB");
    }
  });

  it.each(["protected_parts", "envelope_with_reserve"] as const)("C31 v11 labels protected-input bytes: %s", measure => {
    const cause = { kind: "protected_inputs" as const, bytes: 750_000, measure, remedies: nativePromptRefusalRemedies("protected_inputs") };
    expect(nativePromptRefusalCause(cause)).toEqual(cause);
    const presentation = projectCause(cause);
    expect(presentation?.failure?.detail).toContain(measure === "protected_parts" ? "located required inputs total 733 KB before command encoding" : "encoded task envelope, including reserved room, is 733 KB");
    expect(presentation?.failure).toMatchObject({ cause });
  });

  it("reports the whole serialized guard command, not only its payload", () => {
    const payload = { text: "x".repeat(500_000), lateMetadata: "whole field" };
    const cause = refusal(() => assertNativeTurnCommandBound("turn.start", payload, "measured-command"));
    const compared = { schema: "paperclip.prp.command.v1", commandId: "measured-command", controllerSeq: Number.MAX_SAFE_INTEGER,
      type: "turn.start", issuedAt: new Date().toISOString(), payload, status: "pending", result: null };
    expect(cause).toEqual({ kind: "command", bytes: Buffer.byteLength(JSON.stringify(compared)), measure: "command", remedies: ["edit_task_description", "new_followup_task", "report_defect"] });
    expect(cause.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(payload)));
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(cause))))).toEqual(cause);
    expect(projectCause(cause)?.failure?.detail).toContain("serialized command measured by the guard");
  });

  it.each(["prompt", "envelope"] as const)("names the encoded %s measurement when no handoff room remains", measure => {
    const text = '"'.repeat(140_000);
    const cause = refusal(() => nativeSessionHandoffMaxBytes(measure === "prompt" ? text : { task: { prompt: text } }));
    const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(measure === "prompt" ? text : { task: { prompt: text } }))) - (measure === "prompt" ? 6 : 2);
    expect(cause).toEqual({ kind: "command", bytes, measure, remedies: ["edit_task_description", "new_followup_task", "report_defect"] });
    expect(projectCause(cause)?.failure?.detail).toContain(measure === "prompt" ? "encoded prompt" : "encoded envelope");
    expect(projectCause(cause)?.failure?.detail).not.toContain("complete encoded turn");
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(cause))))).toEqual(cause);
  });

  it("names a handoff note as a note, not a complete turn", () => {
    const cause = refusal(() => { renderNativeSessionHandoff({ issueId: "task", generation: null, entries: [], omittedEntriesAtLeast: 0, maxBytes: 1 }); });
    expect(cause).toMatchObject({ kind: "command", measure: "handoff_note" });
    expect(cause.bytes).toBeLessThan(256);
    expect(projectCause(cause)?.failure?.detail).toContain("encoded history-omission note");
    expect(projectCause(cause)?.failure?.detail).not.toContain("complete encoded turn");
  });

  it("names the pre-seal whole-command upper bound, including its reserves", () => {
    const envelope = { task: { prompt: "x".repeat(510_000) } };
    const cause = refusal(() => assertNativeQueuedTurnBound("run", envelope, "short queued message"));
    expect(cause).toEqual({ kind: "command", bytes: nativeQueuedTurnUpperBound("run", envelope, "short queued message"), measure: "command_upper_bound", remedies: ["edit_task_description", "new_followup_task", "report_defect"] });
    expect(projectCause(cause)?.failure?.detail).toContain("command upper bound, including reserved room");
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(cause))))).toEqual(cause);
  });

  it("keeps an under-cap stale copy distinct from every size refusal", () => {
    const cause: NativePromptRefusalCause = { kind: "stale_copy", bytes: 25, remedies: ["report_defect"] };
    expect(nativePromptRefusalCause(cause)).toEqual(cause);
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(cause))))).toEqual(cause);
    const presentation = projectCause(cause);
    expect(presentation).toMatchObject({ canRetry: false, failure: { cause, title: "Session input contains stale history" } });
    expect(presentation?.failure?.detail).toContain("defect in the agent's runtime or Paperclip");
    expect(presentation?.failure?.detail).not.toMatch(/too large|\bKB\b|shorten|split/);
  });

  it("reads old causes without inventing a measurement and retains future labels", () => {
    const legacy = { kind: "command" as const, bytes: 123, remedies: [] };
    expect(nativePromptRefusalCause(legacy)).toEqual(legacy);
    expect(nativePromptCauseFromError(new Error("native_prompt_cause=command:123"))).toEqual(legacy);
    expect(projectCause(legacy)?.failure?.detail).not.toMatch(/123|1 KB|complete encoded turn/);
    expect(nativePromptRefusalCause({ ...legacy, measure: "payload_masquerading_as_command" })).toEqual({ ...legacy, measure: "payload_masquerading_as_command" });
    expect(nativePromptCauseFromError(new Error("native_prompt_cause=unknown:123"))).toEqual({ kind: "unknown", bytes: 123, remedies: [] });
    expect(nativePromptCauseFromError(new Error("native_prompt_cause=command:123:measure=unknown"))).toEqual({ ...legacy, measure: "unknown" });
  });

  it.each([
    ["task_description", "Edit the description on the task page"],
    ["newest_message", "edit it in the task's message queue"],
    ["unread_message", "edit it in the task's message queue"],
    ["unread_messages", "new short follow-up task"],
    ["queued_input", "edit it in the task's message queue"],
    ["human_response", "new short follow-up task"],
    ["protected_input", "task instructions other than the description"],
    ["protected_inputs", "new short follow-up task"],
    ["command", "edit the description on the task page"],
    ["unmeasured_composition", "defect in the agent's runtime or Paperclip"],
    ["stale_copy", "defect in the agent's runtime or Paperclip"],
  ] as const)("gives %s a supported edit or named escalation path", (kind, wayOut) => {
    const cause: NativePromptRefusalCause = { kind, remedies: nativePromptRefusalRemedies(kind), bytes: kind === "unmeasured_composition" ? 0 : kind === "stale_copy" ? 25 : 750_000,
      ...(kind === "unread_messages" ? { count: 3 } : {}), ...(kind === "command" ? { measure: "command" as const } : {}) };
    const presentation = projectCause(cause);
    expect(presentation).toMatchObject({ canRetry: false, failure: { cause } });
    expect(presentation?.failure?.detail).toContain(wayOut);
    expect(presentation?.failure?.detail).not.toMatch(/\bcompact\b|\/new|new session|Paperclip operator|owner in the task's comments/i);
    if (["newest_message", "unread_message"].includes(kind)) expect(presentation?.failure?.detail).toContain("If you wrote it");
    if (["unmeasured_composition", "stale_copy"].includes(kind)) {
      expect(presentation?.failure?.detail).toContain("this run and the task title");
      expect(presentation?.failure?.detail).toContain("After the fix is installed, send a message to continue");
    }
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(cause))))).toEqual(cause);
  });
});

// Unit test agreed in task: closed pure-data repair routes and legacy validation
// cannot be proven more cheaply through a provider or UI flow.
describe("C31 server-owned remedies", () => {
  it.each([
    ["task_description", ["edit_task_description", "new_followup_task"]],
    ["newest_message", ["edit_message", "delete_own_message", "new_followup_task"]],
    ["unread_message", ["edit_message", "delete_own_message", "new_followup_task"]],
    ["unread_messages", ["edit_message", "delete_own_message", "new_followup_task"]],
    ["queued_input", ["edit_message", "new_followup_task"]],
    ["human_response", ["new_followup_task"]],
    ["protected_input", ["new_followup_task"]],
    ["protected_inputs", ["new_followup_task"]],
    ["command", ["edit_task_description", "new_followup_task", "report_defect"]],
    ["unmeasured_composition", ["report_defect"]],
    ["stale_copy", ["report_defect"]],
  ] as const)("persists and serializes %s supported routes without reading prose", (kind, expected) => {
    const cause: NativePromptRefusalCause = { kind, bytes: 123, remedies: nativePromptRefusalRemedies(kind),
      ...(kind === "unread_messages" ? { count: 3 } : {}), ...(kind === "command" ? { measure: "command" as const } : {}) };
    expect(cause.remedies).toEqual(expected);
    const error = new NativeTurnPromptExceedsCommandBoundError(cause);
    expect(nativePromptCauseFromError(error)).toEqual(cause);
    expect(error.message).toContain(`:remedies=${expected.join(",")}]`);
    expect(nativePromptCauseFromError(new Error(String(error)))).toEqual(cause);
    const resultJson = JSON.parse(JSON.stringify({ nativeTurnPromptRefusalCause: nativePromptCauseFromError(error) }));
    const presentation = projectTaskInterruption(issue, {
      run: { ...run, errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, resultJson }, agent, paused: false, approval: false,
    });
    expect(presentation?.failure).toMatchObject({ cause });
  });

  it("keeps legacy structured and serialized causes empty, without inferring actions", () => {
    const legacy = { kind: "newest_message", bytes: 123, count: 2 };
    expect(nativePromptRefusalCause(legacy)).toEqual({ ...legacy, remedies: [] });
    expect(nativePromptCauseFromError({ promptCause: legacy })).toEqual({ ...legacy, remedies: [] });
    expect(nativePromptCauseFromError(new Error("native_prompt_cause=newest_message:123:count=2")))
      .toEqual({ ...legacy, remedies: [] });
    const empty: NativePromptRefusalCause = { kind: "command", bytes: 123, measure: "prompt", remedies: [] };
    expect(nativePromptCauseFromError(new Error(String(new NativeTurnPromptExceedsCommandBoundError(empty))))).toEqual(empty);
  });

  it.each(["compact", "new_session", "unknown", "edit_task_description,unknown", null, "ask_task_owner", [42], ["bad:route"], [""]].map(remedies => ({ remedies })))(
    "rejects malformed remedies: $remedies", ({ remedies }) => {
      expect(nativePromptRefusalCause({ kind: "command", bytes: 123, remedies })).toBeUndefined();
    },
  );
  it.each([",", "edit_message,", ",edit_message", "edit_message,,report_defect", "bad:route", "edit_message:extra"])(
    "rejects malformed serialized remedies instead of parsing a legacy prefix: %s", remedies => {
      expect(nativePromptCauseFromError(new Error(`native_prompt_cause=command:123:remedies=${remedies}`))).toBeUndefined();
    },
  );
  it("keeps readable evidence when a future writer names an unsupported route", () => {
    const expected = { kind: "command", bytes: 123, remedies: ["new_followup_task"] };
    expect(nativePromptRefusalCause({ ...expected, remedies: ["future_route", "new_followup_task"] })).toEqual(expected);
    expect(nativePromptCauseFromError(new Error("native_prompt_cause=command:123:remedies=future_route,new_followup_task"))).toEqual(expected);
  });
  it("does not guess a version-skewed input's edit route", () => {
    expect(nativePromptRefusalRemedies("future-input_v12")).toEqual(["check_versions"]);
    expect(nativePromptRefusalRemedies("task_description", "future-measure_v12")).toEqual(["new_followup_task"]);
    expect(nativePromptRefusalRemedies("stale_copy", "future-measure_v12")).toEqual(["report_defect"]);
  });
  it("does not share remedy arrays between causes", () => {
    const first = nativePromptRefusalRemedies("command");
    first.length = 0;
    expect(nativePromptRefusalRemedies("command")).toEqual(["edit_task_description", "new_followup_task", "report_defect"]);
  });
});

// Unit test agreed in task: pure projection must name the failed stage without provider text.
describe("classified failure of an unanswered message", () => {
  const owedInput = { commentId: "message", createdAt: new Date(100), deliveryOwner: false };
  const failed = { ...run, errorCode: "native_session_interrupted", resultJson: null,
    createdAt: new Date(200), error: "Boat returned an invalid private preview URL. https://private.example/secret" };
  const project = (change = {}) => projectTaskInterruption(issue, { run: { ...failed, ...change }, agent,
    paused: false, approval: false, owedInput });

  it.each(["runner.ingress.acquire", "runner.transport.connect"])("names the %s connection failure", failedStage => {
    const presentation = project({ failedStage });
    expect(presentation).toMatchObject({ state: "failed", canRetry: true, unansweredCommentId: "message",
      failure: { code: "agent_machine_unreachable", title: "Couldn't connect to the agent's machine",
        detail: "No agent work started. Your message is saved." } });
    expect(JSON.stringify(presentation)).not.toMatch(/Boat|private\.example|saved files|saved work/i);
  });
  it.each(["environment.acquire", "environment.resume"])("names the %s availability failure", failedStage => {
    expect(project({ failedStage })?.failure).toMatchObject({ code: "agent_machine_unavailable",
      title: "The agent's machine was unavailable" });
  });
  it("keeps a predecessor fence distinct from an unavailable machine", () => {
    expect(project({ failedStage: "environment.acquire", previousSessionUnconfirmed: true })?.failure)
      .toMatchObject({ code: "previous_session_unconfirmed", title: "Couldn't confirm the previous session stopped" });
    expect(project({ errorCode: "native_predecessor_retirement_unproven" })?.failure)
      .toMatchObject({ code: "previous_session_unconfirmed" });
  });
  it("carries the size-refusal reason without offering a futile Retry, including owed input", () => {
    const refused = { ...failed, errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND };
    for (const owed of [undefined, owedInput]) {
      const presentation = projectTaskInterruption(issue, { run: refused, agent, paused: false, approval: false, owedInput: owed });
      expect(presentation).toMatchObject({ state: "failed", canRetry: false,
        failure: { code: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, title: "Task input could not be sent", detail: expect.stringContaining("no readable explanation") } });
      expect(JSON.stringify(presentation)).not.toContain("private.example");
    }
  });
  it.each(["task_description", "newest_message", "unread_message", "queued_input", "human_response"] as const)("keeps the protected %s cause and never offers Retry", kind => {
    const cause = { kind, bytes: 600000 };
    const presentation = project({ errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND,
      resultJson: { nativeTurnPromptRefusalCause: cause } });
    expect(presentation).toMatchObject({ canRetry: false, failure: { cause } });
    expect(presentation?.failure?.title).not.toBe("Task history is too large");
    if (kind === "human_response") {
      expect(presentation?.failure?.detail).not.toMatch(/shorten|split/i);
      expect(presentation?.failure?.detail).toContain("a submitted answer cannot be edited here");
      expect(presentation?.failure?.detail).not.toContain("task's owner in the task's comments");
      expect(presentation?.failure?.detail).toContain("new short follow-up task");
    } else expect(presentation?.failure?.detail).toMatch(/shorten|short request/i);
    expect(presentation?.failure?.detail).not.toMatch(/new session|compact/i);
  });
  it.each(["unread_messages", "protected_input", "protected_inputs", "command"] as const)("supplies specific safe copy and serialized cause for %s", kind => {
    const cause = { kind, remedies: nativePromptRefusalRemedies(kind), bytes: 750000, ...(kind === "unread_messages" ? { count: 3 } : {}), ...(kind === "command" ? { measure: "command" as const } : {}) };
    const error = new NativeTurnPromptExceedsCommandBoundError(cause);
    expect(nativePromptCauseFromError(new Error(String(error)))).toEqual(cause);
    const presentation = project({ errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND, resultJson: { nativeTurnPromptRefusalCause: cause } });
    expect(presentation?.failure?.title).not.toBe("Task history is too large");
    if (kind !== "protected_inputs") expect(presentation?.failure?.detail).toContain("733 KB");
    else expect(presentation?.failure?.detail).toContain("no recognized measurement label");
    if (kind === "unread_messages") expect(presentation?.failure?.detail).toContain("3 unread messages total");
    if (kind === "protected_input") expect(presentation?.failure?.title).toBe("Required task input is too large");
  });
  it("presents an unmeasured handback refusal truthfully, not as an oversized request", () => {
    const cause = { kind: "unmeasured_composition" as const, bytes: 0, remedies: nativePromptRefusalRemedies("unmeasured_composition") };
    const error = new NativeTurnPromptExceedsCommandBoundError(cause);
    expect(nativePromptCauseFromError(new Error(String(error)))).toEqual(cause);
    const presentation = project({ errorCode: NATIVE_TURN_PROMPT_EXCEEDS_COMMAND_BOUND,
      resultJson: { nativeTurnPromptRefusalCause: cause } });
    expect(presentation).toMatchObject({ state: "failed", canRetry: false, failure: { cause,
      title: "Queued input cannot be measured for this turn", detail: expect.stringContaining("No queued messages or answers were consumed; they remain saved.") } });
    expect(presentation?.failure?.detail).toContain("this run and the task title");
    expect(presentation?.failure?.detail).toContain("defect in the agent's runtime or Paperclip");
    expect(JSON.stringify(presentation)).not.toMatch(/too large|shorten|split|Reduce the request/);
  });
  it("uses existing stock titles, and a safe fallback for an unmapped classified code", () => {
    expect(project({ errorCode: "provider_quota" })?.failure).toMatchObject({ code: "provider_quota", title: "Error: usage limit reached" });
    expect(project({ errorCode: "unmapped_error" })?.failure).toEqual({ code: "unmapped_error",
      title: "The agent's run failed", detail: "This attempt did not finish. Your message is saved." });
  });
  it("does not borrow an old failure or expose one while a delivery owner is working", () => {
    expect(project({ createdAt: new Date(0) })?.failure).toBeUndefined();
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      owedInput: { ...owedInput, deliveryOwner: true } })?.failure).toBeUndefined();
  });
});

describe("pending question presentation", () => {
  const failed = { ...run, errorCode: "native_session_interrupted", resultJson: null };
  const input = { run: failed, agent, paused: false, approval: false, question: true };
  it("names the unanswered question instead of a historical failure, preserving an available manual Retry", () => {
    for (const previousRun of [failed, { ...failed, status: "succeeded" }, undefined]) {
      const presentation = projectTaskInterruption(issue, { ...input, run: previousRun });
      expect(presentation).toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: "question",
        canRetry: previousRun?.status === "failed" });
      expect(presentation?.providerFailure).toBeUndefined();
    }
  });
  it("does not offer another Retry while saved input or a Retry is pending", () => {
    const wait = { id: "saved-input", requestedAt: new Date(), sourceRunId: failed.id };
    for (const pending of [{ wait }, { retryWait: wait }])
      expect(projectTaskInterruption(issue, { ...input, ...pending })).toMatchObject({ canRetry: false });
  });
  it("shows the question while automatic continuation waits, without offering to move it forward", () => {
    for (const pendingSince of [undefined, Date.now() - 16 * 60_000])
      expect(projectTaskInterruption(issue, { ...input, freshContinuation: { state: "continuing", pendingSince } }))
        .toMatchObject({ state: "waiting_for_user", userAction: "question", canRetry: false });
  });
  it("preserves other current user gates", () => {
    for (const [gate, userAction] of [[{ approval: true }, "approval"], [{ paused: true }, "resume"],
      [{ ownerStopRequired: true }, "confirm_owner_stop"]] as const)
      expect(projectTaskInterruption(issue, { ...input, ...gate })).toMatchObject({ state: "waiting_for_user", userAction, canRetry: false });
  });
  it("preserves live work and terminal task states", () => {
    expect(projectTaskInterruption(issue, { ...input, run: { ...run, status: "running", errorCode: null } }))
      .toMatchObject({ state: "working" });
    expect(projectTaskInterruption({ ...issue, status: "done" }, input)).toMatchObject({ state: "resolved" });
  });
});

describe("saved governed wait shutdown", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const pending = { ...run, runtimeMode: "native", errorCode: "native_governed_wait_settlement_pending", resultJson: null };
  it("names automatic shutdown settlement without offering a duplicate Retry", () => {
    expect(projectTaskInterruption(issue, { run: { ...pending, nativeResumeAt: new Date(now + 30_000) }, agent,
      paused: false, approval: false }, now)).toMatchObject({ state: "working", canRetry: false,
        retryWait: { reason: "governed_wait_settlement", message: "Your work is saved. Paperclip is finishing shutdown." } });
  });
  it("explains exhausted shutdown recovery while preserving the saved work", () => {
    expect(projectTaskInterruption(issue, { run: pending, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "governed_wait_settlement",
        message: "Paperclip couldn’t confirm shutdown. Your work is saved; continuation is paused." } });
  });
  it("keeps genuine approvals authoritative", () => {
    expect(projectTaskInterruption(issue, { run: pending, agent, paused: false, approval: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
  });
});

describe("queued dependency wait presentation", () => {
  const waitingRun = { ...run, status: "cancelled", runtimeMode: "legacy" as const, startedAt: null,
    errorCode: "issue_dependencies_blocked", resultJson: {
      stopReason: "issue_dependencies_blocked", timeoutSource: "dependency_gate",
      cancellation: { source: "unknown", expected: false },
    } };

  it("keeps a dependency-gated wake out of the failed-attempt UI, including retained input", () => {
    for (const wait of [undefined, { id: "saved-input", requestedAt: new Date(0) }]) {
      expect(projectTaskInterruption(issue, { run: waitingRun, agent, wait, paused: false, approval: false }))
        .toMatchObject({ state: "resolved", canRetry: false });
    }
  });

  it.each(["legacy", "native"])("keeps an unstarted %s dispatcher dependency wait neutral", runtimeMode => {
    const dispatchedWait = { ...waitingRun, runtimeMode,
      resultJson: { ...waitingRun.resultJson, timeoutSource: "stale_queued_run_gate" } };
    expect(projectTaskInterruption(issue, { run: dispatchedWait, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(issue, { run: { ...dispatchedWait, startedAt: new Date() }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps genuine failures and current user gates visible", () => {
    for (const changed of [{ status: "failed" }, { runtimeMode: "native" }, { startedAt: new Date() },
      { errorCode: "setup_failed" }, { resultJson: {} }, { resultJson: { ...waitingRun.resultJson, timeoutFired: true } }]) {
      expect(projectTaskInterruption(issue, { run: { ...waitingRun, ...changed }, agent, paused: false, approval: false }))
        .toMatchObject({ state: "failed", canRetry: true });
    }
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      action: { evidence: {}, status: "active" } as never })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waitingRun, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: waitingRun.id, requestedAt: new Date(), preparationStatus: "failed" } }))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("never-started task refused by admission", () => {
  const todo = { ...issue, status: "todo" };
  const admissionWait = { id: "wake", status: "skipped", reason: "budget.blocked", agentId: "agent" };
  it("names an accounting hold as an automatic wait without a Retry", () => {
    expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false })).toMatchObject({
      responsibility: "system", state: "working", canRetry: false,
      retryWait: { reason: "budget.blocked", message: expect.stringContaining("starts automatically") } });
  });
  it("keeps pauses and budget stops as user actions instead of promising an automatic start", () => {
    for (const [state, action] of [
      [{ project: { pausedAt: new Date(), pauseReason: null } }, "resume"],
      [{ company: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ paused: true }, "resume"],
      [{ agent: { status: "paused", pauseReason: "manual" } }, "resume"],
      [{ company: { status: "paused", pauseReason: "budget" } }, "budget"],
      [{ approval: true }, "approval"],
    ] as const) {
      expect(projectTaskInterruption(todo, { agent, admissionWait, paused: false, approval: false, ...state }))
        .toMatchObject({ responsibility: "user", state: "waiting_for_user", userAction: action });
    }
  });
  it("shows nothing for other refusals, started tasks or another assignee", () => {
    for (const changed of [{ reason: "agent.not_invokable" }, { status: "queued" }, { agentId: "other" }]) {
      expect(projectTaskInterruption(todo, { agent, admissionWait: { ...admissionWait, ...changed }, paused: false, approval: false }))
        .toBeNull();
    }
    expect(projectTaskInterruption({ ...todo, status: "cancelled" }, { agent, admissionWait, paused: false, approval: false })).toBeNull();
  });
});

describe("unadmitted chat Retry presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: run.id,
    preparationStatus: "issued", preparationRetryAt: now + 250 };
  const input = { run: failed, agent, wait, paused: false, approval: false };

  it.each(["issued", "processing"])("uses the persisted %s outbox deadline without implying provider work", status => {
    for (const offset of [0, 20_000]) expect(projectTaskInterruption(issue, {
      ...input, wait: { ...wait, preparationStatus: status },
    }, now + offset)).toMatchObject({ state: "retry_scheduled", canRetry: false,
      nextRetryAt: new Date(wait.preparationRetryAt).toISOString() });
  });

  it.each(["failed", "cancelled"])("keeps terminal %s preparation out of the working state", status => {
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, preparationStatus: status,
      preparationRetryAt: null } }, now)).toMatchObject({ state: "failed", nextRetryAt: null });
  });

  it("keeps current gates and admitted execution authoritative", () => {
    expect(projectTaskInterruption(issue, { ...input, paused: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { ...input, approval: true }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    for (const status of ["queued", "running"]) expect(projectTaskInterruption(issue, {
      ...input, run: { ...failed, id: "successor", status },
    }, now)).toMatchObject({ state: "working", nextRetryAt: null });
    expect(projectTaskInterruption(issue, { ...input, wait: { ...wait, sourceRunId: "old-run" } }, now))
      .toMatchObject({ state: "working", nextRetryAt: null });
  });
});

// The native coordinator resumes the same run itself after an attach failure.
// A manual Retry offered meanwhile would race that automatic resume.
it("shows a pending native same-run resume instead of a competing Retry", () => {
  const now = Date.parse("2026-11-06T15:25:50.000Z");
  const failed = { ...run, runtimeMode: "native" as const, errorCode: "native_session_interrupted", resultJson: null };
  const resumeAt = new Date("2026-11-06T15:26:18.687Z");
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: resumeAt }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: resumeAt.toISOString() });
  // A due resume is being dispatched; it is still not the user's turn.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 30_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "working", canRetry: false });
  // A resume that never ran, or no resume at all, leaves exactly one Retry.
  expect(projectTaskInterruption(issue, { run: { ...failed, nativeResumeAt: new Date(now - 10 * 60_000) }, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false }, now))
    .toMatchObject({ state: "failed", canRetry: true });
});

it("explains a persisted Retry wait without exposing the saved payload", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(), sourceRunId: failed.id,
    executionWaitReason: "workspace_repair_required" };
  const presentation = projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true,
    retryWait: { reason: "workspace_repair_required", message: "Retry is waiting for Paperclip to recover the saved files. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, sourceRunId: "another-run" }, paused: false, approval: false }))
    .not.toHaveProperty("retryWait");
  expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, executionWaitReason: "secret-payload" }, paused: false, approval: false }))
    .toMatchObject({ retryWait: { reason: "execution_recovery", message: "Retry is waiting for execution checks. Your message is saved." } });
  expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: true, approval: false }))
    .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
});

it("names a budget gate instead of generic execution checks for a refused Retry", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "budget.blocked" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "budget.blocked",
      message: "Retry is waiting for the budget to allow new work. Check Costs for unrecorded or unpriced usage." } });
});

it.each(["cancelled_by_operator", "retry_source_changed"])("does not offer Retry for terminal Retry waits: %s", reason => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: reason } }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason } });
});

it("holds a Retry on a cleanup gate only while an owner settles it", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  const wait = { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "cleanup_quarantined" };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, wait, cleanupSettling: true }))
    .toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "cleanup_quarantined" } });
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, wait }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "cleanup_quarantined" } });
});

it("keeps Retry for a Retry declined for its requester's access, since a new click replaces it", () => {
  const failed = { ...run, errorCode: "native_provider_terminal_failed", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
    wait: { id: "retry", requestedAt: new Date(), sourceRunId: failed.id, executionWaitReason: "retry_authority_denied" } }))
    .toMatchObject({ state: "failed", canRetry: true, retryWait: { reason: "retry_authority_denied" } });
});

it("preserves the actual workspace preparation error without changing retry authority", () => {
  const failedRun = { ...run, errorCode: "workspace_validation_failed",
    error: "The selected project has no repository source for a remote workspace.", resultJson: null };
  expect(projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false }))
    .toMatchObject({ state: "failed", canRetry: true, workspaceFailure: { message: failedRun.error } });
  for (const status of ["done", "cancelled"]) expect(projectTaskInterruption({ ...issue, status },
    { run: failedRun, agent, paused: false, approval: false })).not.toHaveProperty("workspaceFailure");
  expect(projectTaskInterruption(issue, { run: { ...failedRun, errorCode: "unrelated_failure" }, agent, paused: false, approval: false }))
    .not.toHaveProperty("workspaceFailure");
});

describe("setup command failure presentation (CF1)", () => {
  const setupError = "Execution workspace provision command \"bash ./scripts/provision-worktree.sh\" failed: bash: ./scripts/provision-worktree.sh: No such file or directory";
  const setupRun = { ...run, errorCode: "setup_failed", error: setupError, resultJson: { setupCommandFailure: {
    step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
    output: "bash: ./scripts/provision-worktree.sh: No such file or directory" } } };

  it("names the broken setup command on the task without changing retry authority", () => {
    const withCause = projectTaskInterruption(issue, { run: setupRun, agent, paused: false, approval: false });
    const withoutCause = projectTaskInterruption(issue, { run: { ...setupRun, error: "x", resultJson: null }, agent, paused: false, approval: false });
    expect(withCause).toMatchObject({ state: "failed", canRetry: true, userAction: null, setupFailure: {
      step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh", exitCode: 127,
      message: "The project's workspace provision command \"bash ./scripts/provision-worktree.sh\" failed with exit code 127: bash: ./scripts/provision-worktree.sh: No such file or directory" } });
    const { setupFailure: _named, ...rest } = withCause!;
    expect(rest).toEqual(withoutCause);
    expect(withCause).not.toHaveProperty("workspaceFailure");
  });

  it("recognizes a setup failure recorded before the structured cause existed", () => {
    expect(projectTaskInterruption(issue, { run: { ...setupRun, resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", setupFailure: { step: "workspace_provision", command: "bash ./scripts/provision-worktree.sh",
        exitCode: null, output: "bash: ./scripts/provision-worktree.sh: No such file or directory" } });
  });

  it("keeps a transient setup retry scheduled and only adds the name", () => {
    const retrying = { ...setupRun, status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60_000), scheduledRetryReason: "transient_failure" };
    const named = projectTaskInterruption(issue, { run: retrying, agent, paused: false, approval: false });
    const unnamed = projectTaskInterruption(issue, { run: { ...retrying, error: "x", resultJson: null }, agent, paused: false, approval: false });
    expect(named?.setupFailure?.command).toBe("bash ./scripts/provision-worktree.sh");
    const { setupFailure: _named, ...rest } = named!;
    expect(rest).toEqual(unnamed);
  });

  it("bounds the output tail and strips credentials from the command", () => {
    const noisy = { ...setupRun, resultJson: { setupCommandFailure: { step: "workspace_provision",
      command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ./setup.sh --password hunter22", exitCode: 1,
      output: `${"x".repeat(5_000)}\nfinal line` } } };
    const failure = projectTaskInterruption(issue, { run: noisy, agent, paused: false, approval: false })?.setupFailure;
    expect(failure?.command).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(failure?.command).not.toContain("hunter22");
    expect(failure?.output?.length).toBeLessThanOrEqual(300);
    expect(failure?.output).toMatch(/final line$/);
  });

  it("recognizes older quoted and multiline commands", () => {
    for (const command of ['bash "./scripts/provision-worktree.sh"', "set -e\n./setup.sh"]) {
      expect(projectTaskInterruption(issue, { run: { ...setupRun, resultJson: null,
        error: `Execution workspace provision command "${command}" failed with exit code 2` }, agent, paused: false, approval: false })?.setupFailure)
        .toMatchObject({ command, exitCode: 2 });
    }
  });

  it("does not name setup for other failures or settled tasks", () => {
    expect(projectTaskInterruption(issue, { run: { ...setupRun, errorCode: "adapter_failed" }, agent, paused: false, approval: false }))
      .not.toHaveProperty("setupFailure");
    expect(projectTaskInterruption({ ...issue, status: "done" }, { run: setupRun, agent, paused: false, approval: false }))
      .not.toHaveProperty("setupFailure");
  });
});

function operatorStoppedRun() {
  return { ...run, status: "cancelled", runtimeMode: "native" as const, companyId: issue.companyId,
    nativeIssueId: issue.id, errorCode: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "board",
      executionCancellation: { state: "requested" },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: run.id,
        companyId: issue.companyId, issueId: issue.id, scope: "run",
        reasonCode: "cancellation_run_only", dispatched: true, dispatchState: "acknowledged",
        intentAuditId: "intent", acknowledgementAuditId: "ack" },
    } };
}

describe("intentional native Stop presentation", () => {
  const workingIssue = { ...issue, status: "in_progress" };
  it("does not offer a failed-attempt Retry for an audited operator Stop that keeps its task in progress", () => {
    expect(projectTaskInterruption(workingIssue, { run: operatorStoppedRun(), agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false, userAction: null });
    expect(workingIssue.status).toBe("in_progress");
  });

  it.each([{ runId: "foreign" }, { companyId: "foreign" }, { issueId: "foreign" },
    { dispatchState: "pending" }, { dispatched: false }, { acknowledgementAuditId: undefined },
    { intentAuditId: 123 }, { acknowledgementAuditId: {} },
    { scope: "subtree" }])("retains failure presentation without the matching operator receipt %j", change => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: { ...stopped.resultJson,
      nativeCancellation: { ...stopped.resultJson.nativeCancellation, ...change } } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
  });

  it("keeps pause, approval, non-user cancellation and new input authoritative", () => {
    const stopped = operatorStoppedRun();
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: true, approval: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: true }))
      .toMatchObject({ state: "waiting_for_user", userAction: "approval" });
    expect(projectTaskInterruption(workingIssue, { run: { ...stopped, resultJson: {
      ...stopped.resultJson, cancelledByActorType: "system" } }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(workingIssue, { run: stopped, agent, paused: false, approval: false,
      wait: { id: "new-input", requestedAt: new Date() } }))
      .toMatchObject({ state: "working", canRetry: false });
  });
});

describe("intentional legacy Stop presentation", () => {
  it("clears the failed-attempt notice only after the requested Stop is acknowledged", () => {
    const stopped = { ...run, runtimeMode: "legacy" as const, status: "cancelled", finishedAt: new Date(), resultJson: {
      cancellation: { source: "operator", expected: true, initiator: { type: "user" }, reason: "Stop", recordedAt: new Date().toISOString() },
      executionCancellation: { state: "acknowledged", proof: "preparation_settled" },
    } };
    const input = { run: stopped, agent, paused: false, approval: false };
    expect(projectTaskInterruption(issue, input)).toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(issue, { ...input, run: { ...stopped, resultJson: { ...stopped.resultJson,
      executionCancellation: { state: "requested" } } } })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { ...input, paused: true })).toMatchObject({ userAction: "resume" });
    expect(projectTaskInterruption(issue, { ...input, approval: true })).toMatchObject({ userAction: "approval" });
  });
});

it("preserves a provider explanation on a failed task without changing retry authority", () => {
  const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
    category: "rate_limit", message: "API error: 429 This request would exceed your account's rate limit.",
    httpStatus: 429, retryability: "unknown" };
  const failedRun = { ...run, errorCode: "native_session_interrupted", resultJson: { providerFailure } };
  const presentation = projectTaskInterruption(issue, { run: failedRun, agent, paused: false, approval: false });
  expect(presentation).toMatchObject({ state: "failed", canRetry: true, providerFailure });
  expect(projectTaskInterruption({ ...issue, status: "done" }, { run: failedRun, agent, paused: false, approval: false }))
    .not.toHaveProperty("providerFailure");
});

describe("task project-access interruption", () => {
  it("explains a project denial without offering a futile retry", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: false })).toMatchObject({
      state: "waiting_for_user", responsibility: "user", userAction: "project_access", canRetry: false,
      projectAccess: { agentId: "agent", projectId: "22222222-2222-4222-8222-222222222222", ready: false },
    });
  });

  it("projects the historical setup denial without requiring another failed run", () => {
    expect(projectTaskInterruption(issue, { run: { ...run, errorCode: "setup_failed",
      error: "Project is outside this low-trust boundary.", resultJson: null }, agent, paused: false, approval: false }))
      .toMatchObject({ userAction: "project_access", canRetry: false });
  });

  it("offers an explicit retry after the project is added, without changing the failed run", () => {
    expect(projectTaskInterruption(issue, { run, agent, projectAccessAllowed: true, paused: false, approval: false }))
      .toMatchObject({ state: "failed", canRetry: true, projectAccess: { ready: true } });
    expect(run.status).toBe("failed");
  });

  it("shows an accepted retry as working after access is repaired", () => {
    const input = { run, agent, paused: false, approval: false, wait: { id: "request", requestedAt: new Date() } };
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true }))
      .toMatchObject({ state: "working", canRetry: false });
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: true })).not.toHaveProperty("projectAccess");
    expect(projectTaskInterruption(issue, { ...input, projectAccessAllowed: false }))
      .toMatchObject({ state: "waiting_for_user", userAction: "project_access", canRetry: false });
  });

  it("does not reinterpret unrelated failures or an old assignee's denial", () => {
    for (const otherRun of [{ ...run, errorCode: "setup_failed", error: "Disk full", resultJson: null },
      { ...run, agentId: "previous-agent" }]) {
      expect(projectTaskInterruption(issue, { run: otherRun, agent, paused: false, approval: false }))
        .not.toHaveProperty("projectAccess");
    }
  });

  it("keeps approval, pause, running and completed states authoritative", () => {
    expect(projectTaskInterruption(issue, { run, agent, paused: false, approval: true })).toMatchObject({ userAction: "approval" });
    expect(projectTaskInterruption(issue, { run, agent, paused: true, approval: false })).toMatchObject({ userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: { ...run, status: "running" }, agent, paused: false, approval: false }))
      .toMatchObject({ state: "working" });
    expect(projectTaskInterruption({ ...issue, status: "done" }, { run, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved" });
  });
});

describe("saved-work recovery step", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const failed = { ...run, errorCode: "setup_failed", resultJson: null };
  const system = (phase: string, state: string, nextAttemptAt: number | null) => ({
    schema: "paperclip.system-recovery.v1", policyVersion: 1, sourceRunId: "33333333-3333-4333-8333-333333333333", revision: 3,
    generationId: "44444444-4444-4444-8444-444444444444", intentId: null, phase, state, attemptId: null, attempts: 2,
    retriesUsed: 1, firstFailureAt: now - 60_000, nextAttemptAt, deadlineAt: now + 600_000, providerCooldownAt: null,
    failure: null, preservationOperationIds: [], freshAttemptRunId: null });
  const action = (evidence: Record<string, unknown>) => ({ evidence }) as never;

  it("names the step a scheduled recovery will retry", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) }) }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run" });
  });

  it("names the step a running recovery is on", () => {
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false,
      action: action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 }) }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
  });

  it("names recovery over a pending chat preparation and keeps failed preparation authoritative", () => {
    const wait = { id: "retry", requestedAt: new Date(now), sourceRunId: failed.id, preparationStatus: "issued", preparationRetryAt: now + 250 };
    const running = action({ systemRecovery: system("preserve_files", "running", null), systemRecoveryActiveAt: now - 1_000 });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: running }, now))
      .toMatchObject({ state: "working", recoveryStep: "saving_previous_files" });
    const scheduled = action({ systemRecovery: system("verify_execution", "scheduled", now + 30_000) });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", recoveryStep: "checking_previous_run", canRetry: false });
    expect(projectTaskInterruption(issue, { run: failed, agent, paused: false, approval: false, action: scheduled }, now))
      .toMatchObject({ state: "retry_scheduled", canRetry: true });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait: { ...wait, preparationStatus: "failed" },
      paused: false, approval: false, action: running }, now)).toMatchObject({ state: "failed" });
    expect(projectTaskInterruption(issue, { run: failed, agent, wait, paused: false, approval: false }, now))
      .toMatchObject({ state: "retry_scheduled", nextRetryAt: new Date(now + 250).toISOString() });
  });

  it("does not name a step for an ordinary scheduled retry", () => {
    expect(projectTaskInterruption(issue, { run: { ...failed, scheduledRetryAt: new Date(now + 30_000) }, agent,
      paused: false, approval: false }, now)).not.toHaveProperty("recoveryStep");
  });
});

describe("scheduled resource wait presentation", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const waiting = { ...run, status: "scheduled_retry", errorCode: null, resultJson: null,
    scheduledRetryReason: "workspace_busy", scheduledRetryAt: new Date(now - 60_000) };

  it("keeps an overdue workspace wait out of the failed-attempt UI", () => {
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "working", canRetry: false });
  });

  it("keeps failure retries, user gates and failed Retry preparation authoritative", () => {
    expect(projectTaskInterruption(issue, { run: { ...waiting, scheduledRetryReason: "transient_failure",
      scheduledRetryAt: new Date(now - 10 * 60_000) }, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: true, approval: false }, now))
      .toMatchObject({ state: "waiting_for_user", userAction: "resume" });
    expect(projectTaskInterruption(issue, { run: waiting, agent, paused: false, approval: false,
      retryWait: { id: "retry", sourceRunId: run.id, requestedAt: new Date(now), preparationStatus: "failed" } }, now))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("saved Retry held by dependencies", () => {
  const failedRun = { ...run, status: "failed", errorCode: "native_session_interrupted", resultJson: {} };
  const retryWait = { id: "retry", requestedAt: new Date(0), sourceRunId: "run" };
  const project = (retryDependencies: { count: number; blocked: boolean; cancelled: boolean; savingFilesOnly: boolean }) =>
    projectTaskInterruption(issue, { run: failedRun, agent, retryWait, paused: false, approval: false, retryDependencies });

  it.each([
    [{ count: 1, blocked: true, cancelled: false, savingFilesOnly: false }, "Retry or unblock it"],
    [{ count: 1, blocked: false, cancelled: true, savingFilesOnly: false }, "Remove or replace that dependency"],
    [{ count: 1, blocked: false, cancelled: false, savingFilesOnly: true }, "to save its files"],
    [{ count: 2, blocked: false, cancelled: false, savingFilesOnly: false }, "to finish"],
  ])("names what the saved Retry waits on (%o)", (dependencies, text) => {
    const presentation = project(dependencies);
    expect(presentation).toMatchObject({ state: "working", canRetry: false, intentId: "retry",
      retryWait: { reason: "dependency_blocked" } });
    expect(presentation?.retryWait?.message).toContain(text);
  });
});

describe("setup command failure evidence", () => {
  it("removes a registered secret that crosses the output cut before shortening", async () => {
    const { setupCommandFailureResultJson } = await import("./workspace-setup-command-failure.js");
    const secret = "registered-private-value-0123456789";
    const failure = Object.assign(new Error("setup failed"), { step: "workspace_provision", command: "./setup.sh", exitCode: 1,
      // The cut keeps the last 299 characters; it lands inside the secret.
      output: `${secret}${"y".repeat(299 - 10)}` });
    const recorded = setupCommandFailureResultJson(failure, [secret]);
    expect(recorded).toMatchObject({ setupCommandFailure: { step: "workspace_provision", exitCode: 1 } });
    const text = JSON.stringify(recorded);
    for (let index = 0; index + 8 <= secret.length; index += 1) expect(text).not.toContain(secret.slice(index, index + 8));
  });
});

describe("saved result that ran out of finalization retries", () => {
  const review = { ...issue, status: "in_review" };
  const succeeded = { ...run, status: "succeeded", runtimeMode: "native" as const, errorCode: null, resultJson: null };

  it("offers Retry for a succeeded run whose accepted result could not be finalized", () => {
    expect(projectTaskInterruption(review, { run: { ...succeeded, nativeFinalizationRetry: true }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true, observedRunId: "run" });
  });

  it("shows the saved result being applied after Retry", () => {
    expect(projectTaskInterruption(review, { run: { ...succeeded, nativeFinalizationRetryPending: true }, agent,
      paused: false, approval: false })).toMatchObject({ state: "working", canRetry: false, recoveryStep: "finishing_recovery" });
  });

  it("keeps ordinary succeeded and failed runs unchanged", () => {
    expect(projectTaskInterruption(review, { run: succeeded, agent, paused: false, approval: false }))
      .toMatchObject({ state: "resolved", canRetry: false });
    expect(projectTaskInterruption(review, { run: { ...succeeded, status: "failed", errorCode: "adapter_failed" }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption({ ...review, status: "done" }, { run: { ...succeeded, nativeFinalizationRetry: true },
      agent, paused: false, approval: false })).toMatchObject({ state: "resolved", canRetry: false });
  });
});

// Remote native run shape: the provider turn completed and its work was
// saved, then a same-run recovery was refused by the cleanup gate. The task
// showed "Couldn't finish this attempt" with a Retry the server refuses (409).
describe("native cleanup quarantine presentation", () => {
  const quarantined = { ...run, runtimeMode: "native" as const, errorCode: "native_session_cleanup_quarantined",
    error: "native_session_cleanup_quarantined: prior session cleanup requires operator recovery; verify its retained process ownership and checkpoint before a controlled restart. Clearing a task session does not resolve this quarantine.",
    resultJson: null, finishedAt: new Date("2026-11-10T14:39:31.873Z") };

  it("shows the task's blocker wait, not a failed attempt, after a completed turn", () => {
    expect(projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup: true }, agent,
      waitingOnBlockers: true, paused: false, approval: false })).toMatchObject({ state: "resolved", canRetry: false });
  });

  it("waits without Retry while an owner settles the gate", () => {
    for (const completedTurnCleanup of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        cleanupSettling: true, paused: false, approval: false });
      expect(presentation).toMatchObject({ state: "failed", canRetry: false, retryWait: { reason: "cleanup_quarantined" } });
      expect(presentation?.retryWait?.message).not.toMatch(/operator|admin/i);
    }
    const preparation = { id: "retry", requestedAt: new Date(0), sourceRunId: quarantined.id, preparationStatus: "failed" };
    expect(projectTaskInterruption(issue, { run: quarantined, agent, retryWait: preparation, cleanupSettling: true,
      paused: false, approval: false })).toMatchObject({ canRetry: false });
  });

  it("offers Retry when nothing settles the gate by itself (s9107 t04/t05)", () => {
    // An operator-required gate, or one lost with a restarted process, has no
    // owner. Waiting would never end, so Retry is the way forward.
    for (const completedTurnCleanup of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        paused: false, approval: false });
      expect(presentation).toMatchObject({ state: "failed", canRetry: true });
      expect(presentation).not.toHaveProperty("retryWait");
    }
  });

  it("never leaves a failed task without Retry, a scheduled retry or a settling owner", () => {
    // Invariant: a failed presentation without Retry must name a wait that an
    // owner is settling. Enumerate the quarantine-related inputs.
    const waits = [undefined, ...["cleanup_quarantined", "local_cleanup", "execution_settling"].map(reason =>
      ({ id: "retry", requestedAt: new Date(0), sourceRunId: quarantined.id, executionWaitReason: reason }))];
    for (const completedTurnCleanup of [true, false]) for (const wait of waits) for (const settling of [true, false]) {
      const presentation = projectTaskInterruption(issue, { run: { ...quarantined, completedTurnCleanup }, agent,
        retryWait: wait, cleanupSettling: settling, paused: false, approval: false });
      if (presentation?.state !== "failed" || presentation.canRetry) continue;
      expect(presentation.retryWait, JSON.stringify({ completedTurnCleanup, wait: wait?.executionWaitReason, settling }))
        .toBeDefined();
      if (presentation.retryWait?.reason === "cleanup_quarantined") expect(settling).toBe(true);
    }
  });

  it("keeps Retry for ordinary failed native attempts", () => {
    expect(projectTaskInterruption(issue, { run: { ...quarantined, errorCode: "native_session_interrupted" }, agent,
      paused: false, approval: false })).toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("automatic scheduled retry", () => {
  const now = Date.parse("2026-11-12T23:00:00Z");
  const scheduled = { ...run, status: "scheduled_retry", runtimeMode: "legacy", errorCode: null, resultJson: null,
    scheduledRetryReason: "transient_failure", scheduledRetryAt: new Date(now + 60_000) };

  it("shows a pending transient-failure retry as scheduled without a competing Retry", () => {
    expect(projectTaskInterruption(issue, { run: scheduled, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "retry_scheduled", canRetry: false, nextRetryAt: new Date(now + 60_000).toISOString() });
  });

  it.each(["transient_failure", "native_environment_blocker"])(
    "keeps a just-due %s retry working while the dispatcher promotes it", scheduledRetryReason => {
      for (const overdueMs of [0, 1_000, 30_000, 119_000]) {
        expect(projectTaskInterruption({ ...issue, status: "in_progress" }, { run: { ...scheduled, runtimeMode: "native",
          scheduledRetryReason, scheduledRetryAt: new Date(now - overdueMs) }, agent, paused: false, approval: false }, now))
          .toMatchObject({ state: "working", canRetry: false });
      }
    });

  it("offers Retry once the scheduled retry is past due with nothing else pending", () => {
    expect(projectTaskInterruption(issue, { run: { ...scheduled, scheduledRetryAt: new Date(now - 10 * 60_000) }, agent,
      paused: false, approval: false }, now)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("offers Retry once the scheduled retries are exhausted", () => {
    expect(projectTaskInterruption(issue, { run: { ...scheduled, status: "failed", errorCode: "transient_failure_retry_exhausted",
      scheduledRetryAt: new Date(now - 60_000) }, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});

describe("hand-off of a run that failed before any provider work", () => {
  const now = Date.parse("2026-11-13T15:08:12Z");
  const failed = { ...run, runtimeMode: "native" as const, errorCode: "adapter_failed", finishedAt: new Date(now - 3_000),
    resultJson: { failureCause: "native_predecessor_retirement_unproven", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  const inProgress = { ...issue, status: "in_progress" };

  it("shows the task as working while its fresh-sandbox continuation is being queued", () => {
    for (const failureCause of ["native_predecessor_retirement_unproven", "native_failed_before_provider_turn"]) {
      expect(projectTaskInterruption(inProgress, { run: { ...failed, resultJson: { ...failed.resultJson, failureCause } },
        agent, paused: false, approval: false }, now)).toMatchObject({ state: "working", canRetry: false });
    }
  });

  it("keeps the task working after the fallback is recorded while its continuation is still being scheduled", () => {
    const recorded = { ...failed, resultJson: { ...failed.resultJson, predecessorRetirementFallback: { version: 1, providerWorkStarted: false } } };
    expect(projectTaskInterruption(inProgress, { run: recorded, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "working", canRetry: false });
  });

  it("offers Retry when the continuation was refused or never queued", () => {
    const refused = { ...failed, resultJson: { ...failed.resultJson, predecessorRetirementFallback: { version: 1, providerWorkStarted: false },
      continuationScheduling: "refused" } };
    expect(projectTaskInterruption(inProgress, { run: refused, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: true });
    expect(projectTaskInterruption(inProgress, { run: { ...failed, finishedAt: new Date(now - 31_000) }, agent, paused: false, approval: false }, now))
      .toMatchObject({ state: "failed", canRetry: true });
  });
});
