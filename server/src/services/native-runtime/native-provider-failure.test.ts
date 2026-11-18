import { describe, expect, it } from "vitest";
import type { PrpEvent, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { createNativeProviderFailureObservation, NATIVE_MODEL_NOT_FOUND_DIAGNOSTIC, NATIVE_MODEL_REJECTION_DIAGNOSTIC, NATIVE_MODEL_REJECTION_MESSAGE, NATIVE_PROVIDER_OVERLOADED_MESSAGE, readNativeTurnFailureDiagnostic } from "./native-provider-failure.js";

const model = "test-model";
const response = {
  type: "error", status: 400,
  error: { type: "invalid_request_error", message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` },
};
const event: PrpEvent = {
  schema: "paperclip.prp.event.v1", runId: "run", normalizedSessionId: "session", turnId: "turn",
  sourceInstanceId: "runner", sourceEventId: "failure", sourceSeq: 1, sourceKind: "runner",
  eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: "2026-01-01T00:00:00.000Z",
  payload: { status: "failed", error: { message: JSON.stringify(response), codexErrorInfo: "other" } },
};
const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "blocked",
};
const observation = () => createNativeProviderFailureObservation({ kind: "codex", model });

describe("native provider failure observation", () => {
  // KEEP: never-OK account-risk guard. Neither assistant/tool prose nor a
  // different turn, provider, source or successful terminal may stop retries.
  const policyEvent: PrpEvent = { ...event, payload: { status: "failed", error: {
    code: "pi_provider_error", message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your request was flagged by our usage policy."}}',
  } } };
  it("classifies only the bound Pi provider refusal, with closed diagnostics", () => {
    const observed = createNativeProviderFailureObservation({ kind: "pi_rpc" });
    observed.observe(policyEvent);
    expect(observed.forTerminal("turn", terminal)).toEqual({ errorCode: "provider_policy_refusal",
      errorMessage: "The model provider refused this request under its policies; it won't be retried automatically.",
      diagnostic: { provider: "pi_rpc", category: "policy_refusal" } });
    expect(observed.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    expect(observed.forTerminal("other-turn", terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, turnTerminalState: "cancelled" })).toBeNull();
  });
  it.each([
    // Exact live provider texts from Gate 2 N23c and run 021eddf2.
    { message: "This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy…" },
    { message: "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs" },
    { message: "The request was declined.", rawStopReason: "refusal" },
    { rawStopReason: "refusal" },
    { stop_details: { type: "refusal", category: null } },
    { stop_details: { category: "reasoning_extraction" } },
    { message: "This request was blocked under the commercial terms." },
    { message: "Your request was refused under our terms of use." },
    { message: "The request was declined.", stop_reason: "refusal" },
    { message: "The request was declined.", stop_details: { type: "refusal", category: "reasoning_extraction" } },
    ...["cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms"].map(category => ({
      message: "The request was declined.", stop_details: { category },
    })),
    { message: "The request was declined.", stopDetails: { type: "refusal", category: null } },
  ])("classifies live text or native refusal details without resending: %j", error => {
    const observed = createNativeProviderFailureObservation({ kind: "pi_rpc" });
    observed.observe({ ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", ...error } } });
    expect(observed.forTerminal("turn", terminal)?.errorCode).toBe("provider_policy_refusal");
    expect.soft(observed.forTerminal("turn", terminal)?.errorMessage).not.toContain("usage policy");
    expect(observed.forTerminal("turn", terminal)?.errorMessage).toBe("The model provider refused this request under its policies; it won't be retried automatically.");
  });
  it.each([
    { ...policyEvent, sourceKind: "control_plane" as const },
    { ...policyEvent, eventType: "item.failed" as const },
    { ...policyEvent, eventType: "harness.diagnostic" as const },
    { ...policyEvent, turnId: undefined },
    { ...policyEvent, payload: { ...policyEvent.payload, status: "completed" } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_rpc_transport_failed", message: "Request blocked by usage policy" } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "400 invalid_request_error: blocked tool schema; field content_policy is unknown" } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "400 invalid_request_error: usage policy parameter is missing" } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "529 overloaded_error: Overloaded" } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "Connection refused" } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "Here is an ordinary answer mentioning usage policy." } } },
    { ...policyEvent, payload: { status: "failed", error: { code: "pi_provider_error", message: "Unavailable", stop_details: { category: "unknown" } } } },
    { ...policyEvent, eventType: "item.completed" as const, payload: { status: "completed", text: "Your request was blocked by usage policy." } },
  ])("does not mistake non-refusal evidence for policy refusal %#", candidate => {
    const observed = createNativeProviderFailureObservation({ kind: "pi_rpc" });
    observed.observe(candidate);
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });
  it.each(["codex", "opencode", "acpx"])("does not infer Pi policy evidence for %s", kind => {
    const observed = createNativeProviderFailureObservation({ kind });
    observed.observe(policyEvent);
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });
  it.each(["acpx", "codex", "opencode"])("retains a typed explanation for %s without granting recovery authority", kind => {
    const observed = createNativeProviderFailureObservation({ kind });
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "new-provider", phase: "turn",
      category: "unknown", message: "An unfamiliar provider rejection.", retryability: "unknown" };
    const failed = { ...event, payload: { status: "failed", error: { providerFailure } } };
    observed.observe({ ...failed, sourceKind: "control_plane" });
    expect(observed.providerFailureForTerminal("turn", terminal)).toBeNull();
    observed.observe(failed);
    expect(observed.providerFailureForTerminal("turn", terminal)).toEqual(providerFailure);
    expect(observed.forTerminal("turn", terminal)).toBeNull();
    expect(observed.providerFailureForTerminal("other-turn", terminal)).toBeNull();
    expect(observed.providerFailureForTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
  });
  it.each(["opencode", "codex"])("classifies an action-required model_unavailable failure from %s as a model rejection", kind => {
    const observed = createNativeProviderFailureObservation({ kind });
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "openrouter", phase: "turn",
      category: "model_unavailable", message: "vendor/private-model is not a valid model ID", retryability: "requires_action", httpStatus: 400 };
    observed.observe({ ...event, payload: { status: "failed", error: { providerFailure } } });
    const result = observed.forTerminal("turn", terminal);
    expect(result).toMatchObject({ errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE });
    expect(JSON.stringify(result)).not.toContain("private-model");
    // A closed diagnostic only, and the classified turn is not also reported as unclassified.
    expect(result?.diagnostic).toEqual(expect.objectContaining({ provider: kind }));
    expect(JSON.stringify(result?.diagnostic)).not.toContain("not a valid model");
    expect(observed.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    expect(observed.forTerminal("other-turn", terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
  });
  it.each(["transient", "unknown"])("does not treat a %s model_unavailable failure as a model rejection", retryability => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode" });
    observed.observe({ ...event, payload: { status: "failed", error: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openrouter", phase: "turn", category: "model_unavailable", message: "busy", retryability } } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });
  it("classifies the API-key 404 for the configured model as a model rejection (codex 0.160.0 shape)", () => {
    const apiKeyFailure = (message: string, info: unknown = { httpConnectionFailed: { httpStatusCode: 404 } }) => ({ ...event, payload: { status: "failed", error: {
      message, codexErrorInfo: info, additionalDetails: null, misalignment: null } } });
    const real = `unexpected status 404 Not Found: The model \`${model}\` does not exist or you do not have access to it., url: https://api.openai.com/v1/responses, cf-ray: a5833f01da2716ce-IAH, request id: req_584e320775c34b2c9c6d98af40e0ea3d`;
    const observed = observation();
    observed.observe(apiKeyFailure(real));
    const result = observed.forTerminal("turn", terminal);
    expect(result).toEqual({ errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE, diagnostic: NATIVE_MODEL_NOT_FOUND_DIAGNOSTIC });
    expect(JSON.stringify(result)).not.toContain(model);
    expect(observed.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    expect(observed.forTerminal("other-turn", terminal)).toBeNull();
    // Another model's 404, another status, or a retryable turn is not this rejection.
    for (const [message, info, recoverable] of [
      [real.replace(model, "other-model"), undefined, false],
      [real, { httpConnectionFailed: { httpStatusCode: 500 } }, false],
      [real, "other", false],
      // Codex reports its retried 404s with this kind and willRetry; they never end the turn.
      [real, { responseStreamDisconnected: { httpStatusCode: 404 } }, false],
      [real, undefined, true],
    ] as const) {
      const other = observation();
      const failed = apiKeyFailure(message, info);
      other.observe(recoverable ? { ...failed, payload: { ...failed.payload, recoverable: true } } : failed);
      expect(other.forTerminal("turn", terminal)).toBeNull();
    }
  });
  it("surfaces a structured capacity failure without copying arbitrary provider text", () => {
    const observed = createNativeProviderFailureObservation({ kind: "codex" });
    observed.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded", message: "Private arbitrary response" } } });
    expect(observed.forTerminal("turn", terminal)).toEqual({ errorCode: "native_provider_overloaded", errorMessage: NATIVE_PROVIDER_OVERLOADED_MESSAGE, diagnostic: { provider: "codex", category: "server_overloaded" } });
    expect(observed.forTerminal("different-turn", terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
  });

  it.each(["usageLimitExceeded", "other", "unauthorized", undefined])("does not retry unrelated provider errors (%s)", (codexErrorInfo) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo, message: NATIVE_PROVIDER_OVERLOADED_MESSAGE } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });
  it("binds the structured rejection to the failed turn and emits no response or model text", () => {
    const observed = observation();
    observed.observe(event);
    observed.observe(event); // A byte-identical committed replay remains idempotent.
    const result = observed.forTerminal("turn", terminal);
    expect(result).toEqual({ errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE, diagnostic: NATIVE_MODEL_REJECTION_DIAGNOSTIC });
    expect(JSON.stringify(result)).not.toContain(model);
    expect(JSON.stringify(result)).not.toContain("invalid_request_error");
    expect(observed.forTerminal("later-turn", terminal)).toBeNull();
    expect(observed.forTerminal(null, terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, turnTerminalState: "cancelled" })).toBeNull();
  });

  it.each([
    { ...event, sourceKind: "control_plane" as const },
    { ...event, eventType: "item.completed" as const },
    { ...event, eventType: "harness.diagnostic" as const },
    { ...event, turnId: undefined },
    { ...event, payload: { ...event.payload, status: "completed" } },
    { ...event, payload: { ...event.payload, recoverable: true } },
    { ...event, payload: { status: "failed", error: { message: JSON.stringify(response), recoverable: true } } },
  ])("ignores non-authoritative or retryable evidence %#", (unrelated) => {
    const observed = observation();
    observed.observe(unrelated);
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });

  it.each([
    response.error.message, "malformed JSON", " ".repeat(4_097),
    JSON.stringify({ ...response, status: 401 }),
    JSON.stringify({ ...response, status: "400" }),
    JSON.stringify({ ...response, type: "notice" }),
    JSON.stringify({ ...response, error: { ...response.error, type: "server_error" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: "Private arbitrary provider text" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: response.error.message + " Private suffix" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: response.error.message.replace(model, "another-model") } }),
    JSON.stringify([response]), "null",
  ])("leaves unknown failures unchanged %#", (message) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error: { message } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });

  it.each([
    [{ codexErrorInfo: "contextWindowExceeded", message: "Private provider text" }, { codexErrorInfo: "contextWindowExceeded" }],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, message: "Private" }, { codexErrorInfo: "responseStreamDisconnected", httpStatus: 502 }],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: "502" } } }, { codexErrorInfo: "httpConnectionFailed" }],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 9_999 } } }, { codexErrorInfo: "httpConnectionFailed" }],
    [{ codexErrorInfo: "privateUnknownKind" }, { codexErrorInfo: "unrecognized" }],
    [{ codexErrorInfo: { privateUnknownKind: {} } }, { codexErrorInfo: "unrecognized" }],
    [{ codexErrorInfo: { other: {}, badRequest: {} } }, { codexErrorInfo: "unrecognized" }],
    [{ code: "provider_event_type_invalid", message: "Unknown canonical provider event type.", recoverable: false }, { codexErrorInfo: "absent", runnerFailureCode: "provider_event_type_invalid" }],
    [{ code: "Private Code With Spaces", message: "Private" }, { codexErrorInfo: "absent", runnerFailureCode: "unrecognized" }],
    [{ code: "private_prompt_slug", message: "Private" }, { codexErrorInfo: "absent", runnerFailureCode: "unrecognized" }],
    [{ code: 42, message: "Private" }, { codexErrorInfo: "absent" }],
    [{ message: NATIVE_PROVIDER_OVERLOADED_MESSAGE }, { codexErrorInfo: "absent" }],
  ])("describes an unclassified failed turn with closed vocabulary only %#", (error, expected) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
    const diagnostic = observed.unclassifiedTurnFailure("turn", terminal);
    expect(diagnostic).toEqual({ provider: "codex", category: "turn_failed", ...expected });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private/i);
    expect(readNativeTurnFailureDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it("does not describe a classified, unfailed, or unrelated turn as unclassified", () => {
    const rejected = observation();
    rejected.observe(event);
    expect(rejected.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    const overloaded = observation();
    overloaded.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded" } } });
    expect(overloaded.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    const other = observation();
    other.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "sandboxError" } } });
    expect(other.unclassifiedTurnFailure("later-turn", terminal)).toBeNull();
    expect(other.unclassifiedTurnFailure(null, terminal)).toBeNull();
    expect(other.unclassifiedTurnFailure("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
    expect(other.unclassifiedTurnFailure("turn", { ...terminal, turnTerminalState: "cancelled" })).toBeNull();
    const claude = createNativeProviderFailureObservation({ kind: "claude", model });
    claude.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "sandboxError" } } });
    expect(claude.unclassifiedTurnFailure("turn", terminal)).toBeNull();
  });

  it.each([
    null, [], "turn_failed",
    { provider: "codex", category: "turn_failed", codexErrorInfo: "private-kind" },
    { provider: "claude", category: "turn_failed", codexErrorInfo: "other" },
    { provider: "codex", category: "server_overloaded", codexErrorInfo: "other" },
  ])("rejects a persisted turn-failure diagnostic outside the vocabulary %#", (value) => {
    expect(readNativeTurnFailureDiagnostic(value)).toBeNull();
  });

  it("drops unbounded fields from a persisted turn-failure diagnostic", () => {
    expect(readNativeTurnFailureDiagnostic({
      provider: "codex", category: "turn_failed", codexErrorInfo: "badRequest", httpStatus: 1.5,
      runnerFailureCode: "private_prompt_slug", message: "private provider response",
    })).toEqual({ provider: "codex", category: "turn_failed", codexErrorInfo: "badRequest", runnerFailureCode: "unrecognized" });
  });

  it("names a lost OpenCode server without copying provider text", () => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode", model });
    observed.observe({ ...event, payload: { status: "failed", providerTerminalObserved: false, error: {
      code: "opencode_server_exited", message: "Private provider message",
      opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED", detail: "private" },
    } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
    const diagnostic = observed.unclassifiedTurnFailure("turn", terminal);
    expect(diagnostic).toEqual({
      provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_server_exited",
      streamFailure: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private/i);
    expect(readNativeTurnFailureDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it("still identifies an OpenCode turn that failed with no structured cause", () => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode", model });
    observed.observe({ ...event, payload: { status: "failed", error: null } });
    expect(observed.unclassifiedTurnFailure("turn", terminal)).toEqual({ provider: "opencode", category: "turn_failed" });
    const providerError = createNativeProviderFailureObservation({ kind: "opencode", model });
    providerError.observe({ ...event, payload: { status: "failed", error: { code: "private_provider_code", name: "APIError" } } });
    expect(providerError.unclassifiedTurnFailure("turn", terminal)).toEqual({
      provider: "opencode", category: "turn_failed", runnerFailureCode: "unrecognized",
    });
  });

  it("drops values outside the OpenCode stream-failure vocabulary", () => {
    expect(readNativeTurnFailureDiagnostic({
      provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_event_stream_lost",
      streamFailure: "connection_failed", connectionError: "EPRIVATE", exitCode: 300, signal: "private signal", httpStatus: 42,
    })).toEqual({
      provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_event_stream_lost", streamFailure: "connection_failed",
    });
    expect(readNativeTurnFailureDiagnostic({
      provider: "opencode", category: "turn_failed", streamFailure: "private", exitCode: 137,
    })).toEqual({ provider: "opencode", category: "turn_failed" });
    expect(readNativeTurnFailureDiagnostic({ provider: "opencode", category: "server_overloaded" })).toBeNull();
  });

  it("records only known signal names for a lost OpenCode server", () => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode", model });
    observed.observe({ ...event, payload: { status: "failed", error: {
      code: "opencode_server_exited", opencodeFailure: { kind: "server_exited", signal: "SIGPRIVATE" },
    } } });
    const expected = { provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_server_exited", streamFailure: "server_exited" };
    expect(observed.unclassifiedTurnFailure("turn", terminal)).toEqual(expected);
    expect(readNativeTurnFailureDiagnostic({ ...expected, signal: "SIGPRIVATE" })).toEqual(expected);
    expect(readNativeTurnFailureDiagnostic({ ...expected, signal: "SIGTERM" })).toEqual({ ...expected, signal: "SIGTERM" });
  });

  it("records an OpenCode upstream provider failure's closed fields without its message or code", () => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode", model });
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "openrouter", phase: "turn",
      category: "unknown", message: "Private upstream explanation", providerCode: "private_provider_type",
      httpStatus: 502, retryability: "unknown" };
    observed.observe({ ...event, payload: { status: "failed", error: {
      name: "UnknownError", data: { message: "Private upstream body" }, providerFailure,
    } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
    expect(observed.providerFailureForTerminal("turn", terminal)).toEqual(providerFailure);
    const diagnostic = observed.unclassifiedTurnFailure("turn", terminal);
    expect(diagnostic).toEqual({
      provider: "opencode", category: "turn_failed",
      providerFailureCategory: "unknown", providerFailureRetryability: "unknown", httpStatus: 502,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private/i);
    expect(readNativeTurnFailureDiagnostic(diagnostic)).toEqual(diagnostic);
    // A malformed provider failure adds nothing, and a persisted record keeps only known values.
    const malformed = createNativeProviderFailureObservation({ kind: "opencode", model });
    malformed.observe({ ...event, payload: { status: "failed", error: { providerFailure: { ...providerFailure, category: "private" } } } });
    expect(malformed.unclassifiedTurnFailure("turn", terminal)).toEqual({ provider: "opencode", category: "turn_failed" });
    expect(readNativeTurnFailureDiagnostic({ provider: "opencode", category: "turn_failed",
      providerFailureCategory: "private", providerFailureRetryability: "unknown", httpStatus: 502 }))
      .toEqual({ provider: "opencode", category: "turn_failed" });
    expect(readNativeTurnFailureDiagnostic({ provider: "opencode", category: "turn_failed",
      providerFailureCategory: "overloaded", providerFailureRetryability: "private", httpStatus: 42 }))
      .toEqual({ provider: "opencode", category: "turn_failed", providerFailureCategory: "overloaded" });
  });

  it("names the OpenCode empty-response failure the driver writes", () => {
    const observed = createNativeProviderFailureObservation({ kind: "opencode", model });
    observed.observe({ ...event, payload: { status: "failed", error: {
      code: "opencode_empty_response", message: "OpenCode ended the turn without a final response.", retryable: false,
    } } });
    const diagnostic = observed.unclassifiedTurnFailure("turn", terminal);
    expect(diagnostic).toEqual({ provider: "opencode", category: "turn_failed", runnerFailureCode: "opencode_empty_response" });
    expect(readNativeTurnFailureDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it.each([{ kind: "claude", model }, { kind: "codex" }, { kind: "codex", model: "other" }])(
    "does not apply a rejection to another selected provider/model (%j)", (provider) => {
      const observed = createNativeProviderFailureObservation(provider);
      observed.observe(event);
      expect(observed.forTerminal("turn", terminal)).toBeNull();
    },
  );
});
