import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityMarkPrecisionInputs } from "../../../../packages/paperclip-runner/src/secret-shapes-identity.test-fixture.js";
import { leakedPemWindows, secretShapePemVectors } from "../../../../packages/paperclip-runner/src/secret-shapes-pem.test-fixture.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { redactRunnerApiEvent, redactRunnerApiPayloads } from "./runner-api-log-redaction.js";

// Data-safety and precision at the actual identity -> persisted event boundary.
// Also run this suite on the exact efe82e8f merge, not a regex projection of it.
describe("composed identity/shape persistence", () => {
  it.each(identityMarkPrecisionInputs)("O1: keeps $name in both orders", ({ text }) => {
    const identity = createAgentIdentityRedactor();
    const secret = "fake-registered-value";
    identity.values.push(secret);
    const input = { eventType: "item.completed", sourceKind: "runner", payload: { text: text.replaceAll("***REDACTED***", secret) } };
    const expected = { ...input, payload: { text } };
    expect(redactRunnerApiEvent(identity.redact(input))).toEqual(expected);
    // In the reverse order a named assignment is already shape-masked before
    // the exact-value redactor sees it. Its mark kind may differ; its complete
    // surrounding transcript must still survive byte-for-byte.
    expect(identity.redact(redactRunnerApiEvent(input))).toEqual({ ...expected, payload: {
      text: text.replace("GH_TOKEN=***REDACTED***", "GH_TOKEN=[REDACTED:assignment]"),
    } });
    expect(redactRunnerApiEvent(expected)).toEqual(expected);
    expect(input.payload.text).toContain(secret);
  });
  it("keeps a SHA and mixed-case path after an actual configured key", () => {
    const key = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const suffix = "\n6e90f3f0ebcec3fcc70ffcf22056eac2c32ec699\n/SomeMixedCase/Repository/SourceTree/Runtime\nls\nPASS\n";
    const identity = createAgentIdentityRedactor(key);
    const input = { text: key.trim() + suffix };
    // Exact-value identity redaction consumes the PEM's final newline too:
    // the SHA is therefore directly attached to its mark in production order.
    expect(redactRunnerApiPayloads(identity.redact(input))).toEqual({ text: "***REDACTED***" + suffix.slice(1) });
    expect(input.text).toContain(key.trim());
  });
  it.each([false, true])("hides all supported PEM vectors in both orders (configured=%s)", configured => {
    const key = configured ? generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString() : undefined;
    for (const { text, body, keyType, name } of secretShapePemVectors().filter(vector => vector.supported)) {
      const identity = createAgentIdentityRedactor(key);
      const input = { eventType: "item.completed", sourceKind: "runner", payload: { text } };
      for (const output of [redactRunnerApiEvent(identity.redact(input)), identity.redact(redactRunnerApiEvent(input))]) {
        expect(leakedPemWindows(output.payload.text, body), `${keyType} ${name}`).toBe(0);
        expect(output.payload.text).not.toMatch(/-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY-----/);
        expect(redactRunnerApiEvent(output)).toEqual(output);
      }
      expect(input.payload.text).toBe(text);
    }
  });
});

describe("API payload persistence redaction", () => {
  it.each(["POST /api/agents/me/secrets/{key}/value", "POST /api/companies/{companyId}/exports", "GET /api/projects/{id}"])("preserves private HTTP results on the wire, but omits %s from history", operationId => {
    const result = { operationId: "call_api", apiOperationId: operationId, status: 200, ok: true, data: { value: "private-fixture-value" } };
    const event = { item: { type: "tool_result", result } };
    const saved = redactRunnerApiPayloads(event);
    expect(saved.item.result).toMatchObject({ operationId: "call_api", apiOperationId: operationId, status: 200, apiPayloadRedacted: true });
    expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    expect(event.item.result.data.value).toBe("private-fixture-value");
    expect(redactRunnerApiPayloads(event)).toEqual(saved);
    expect(redactRunnerApiPayloads(saved)).toEqual(saved);
    expect((redactRunnerApiPayloads({ ...result, data: { value: "another-fixture-value" } }) as any).apiPayloadSha256)
      .not.toBe((saved.item.result as any).apiPayloadSha256);
  });
  it("redacts serialized legacy receipts and API request arguments", () => {
    const value = { text: JSON.stringify({ result: { operationId: "POST /api/agents/me/secrets/{key}/value", data: { value: "private-fixture-value" } } }),
      input: { operationId: "POST /api/agents/me/secret-proposals", body: { value: "proposal-fixture-value" } } };
    const saved = redactRunnerApiPayloads(value);
    expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    expect(JSON.stringify(saved)).not.toContain("proposal-fixture-value");
    expect(JSON.parse(saved.text).result.apiPayloadRedacted).toBe(true);
  });
  it.each([{ query: { token: "private-fixture-value" } }, { operationId: "GET /issues/{id}", query: { token: "private-fixture-value" } }])("redacts malformed save_api_response arguments before history: %j", input => {
    const saved = redactRunnerApiPayloads({ item: { type: "tool_use", name: "save_api_response", input } });
    expect(saved.item.input).toMatchObject({ apiPayloadRedacted: true });
    expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    const result = redactRunnerApiPayloads({ result: { operationId: "save_api_response", data: { value: "private-fixture-value" } } });
    expect(JSON.stringify(result)).not.toContain("private-fixture-value");
  });
  it("preserves unrelated tool output and JSON text formatting", () => {
    const value = { result: { operationId: "get_task_context", data: { title: "Work" } }, text: '{ "ordinary": "output" }' };
    expect(redactRunnerApiPayloads(value)).toEqual(value);
  });
  it.each(["call_api", "create_case"])("keeps %s denial metadata out of the API-body exception", operationId => {
    const payload = {
      provider: "codex", operationId, callId: "schema-denied", code: "semantic_tool_denied",
      paperclipExecuted: false, message: "Provider arguments failed JSON Schema validation.",
      inputSchemaGuidance: "Invalid tool arguments. Check these input schema locations: /properties/title/type.",
    };
    const event = { sourceKind: "runner", eventType: "harness.diagnostic", payload };
    expect(redactRunnerApiEvent(event)).toEqual(event);
    const debugEvent = { ...event, debug: { operationId, data: { value: "private-debug-value" } } };
    const savedDebug = redactRunnerApiEvent(debugEvent);
    expect(savedDebug.payload).toEqual(payload);
    expect(savedDebug.debug).toMatchObject({ apiPayloadRedacted: true });
    expect(JSON.stringify(savedDebug)).not.toContain("private-debug-value");
    expect(redactRunnerApiEvent(savedDebug)).toEqual(savedDebug);
    for (const value of [
      { ...event, eventType: "item.completed" },
      { ...event, sourceKind: "control_plane" },
      { ...event, payload: { ...payload, arguments: { value: "private-fixture-value" } } },
      { ...event, payload: { ...payload, inputSchemaGuidance: "x".repeat(513) } },
      { ...event, payload: { ...payload, inputSchemaGuidance: "unsafe\nmetadata" } },
      { ...event, payload: { ...payload, inputSchemaGuidance: { value: "private-fixture-value" } } },
    ]) {
      const saved = redactRunnerApiEvent(value);
      expect(saved.payload).toMatchObject({ apiPayloadRedacted: true });
      expect(saved.payload).not.toHaveProperty("inputSchemaGuidance");
      expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    }
    const nested = { sourceKind: "runner", eventType: "item.completed", payload: {
      operationId, data: { ...event, payload: { ...payload, inputSchemaGuidance: "private-fixture-value" } },
    } };
    expect(JSON.stringify(redactRunnerApiEvent(nested))).not.toContain("private-fixture-value");
    expect(redactRunnerApiPayloads(payload)).not.toHaveProperty("inputSchemaGuidance");
  });
  it("redacts unknown shapes even in the bounded schema-denial exception", () => {
    const token = `ghp_${"FakeShapeToken9".repeat(3)}`;
    const event = { sourceKind: "runner", eventType: "harness.diagnostic", payload: {
      provider: "pi", operationId: "call_api", callId: "denied", code: "semantic_tool_denied", paperclipExecuted: false,
      message: `Invalid input ${token}`, inputSchemaGuidance: "Check /properties/title/type.",
    } };
    const saved = redactRunnerApiEvent(event);
    expect(saved.payload.message).toBe("Invalid input [REDACTED:github]");
    expect(saved.payload.inputSchemaGuidance).toBe(event.payload.inputSchemaGuidance);
    expect(event.payload.message).toContain(token);
    expect(redactRunnerApiEvent(saved)).toEqual(saved);
  });
  it("redacts JSON argument copies without collapsing private API replay hashes", () => {
    const text = JSON.stringify({ command: '"privateMaterial": "fake-shaped-assignment"' });
    expect(redactRunnerApiPayloads({ text }).text).not.toContain("fake-shaped-assignment");
    const first = { operationId: "call_api", data: { token: `sk-${"FakeShape9".repeat(3)}` } };
    const second = { ...first, data: { token: `sk-${"OtherShape9".repeat(3)}` } };
    const a = redactRunnerApiPayloads(first) as any, b = redactRunnerApiPayloads(second) as any;
    expect(a.apiPayloadSha256).not.toBe(b.apiPayloadSha256);
    expect(redactRunnerApiPayloads(a)).toEqual(a);
    expect(redactRunnerApiPayloads(b)).toEqual(b);
  });
  it("omits malformed API arguments and semantic result envelopes", () => {
    const value = { item: { type: "tool_use", name: "call_api", input: { operationId: "invalid", body: { value: "private-fixture-value" } } },
      result: { operationId: "call_api", result: { data: "private-fixture-value" } } };
    expect(JSON.stringify(redactRunnerApiPayloads(value))).not.toContain("private-fixture-value");
    expect(redactRunnerApiPayloads(redactRunnerApiPayloads(value))).toEqual(redactRunnerApiPayloads(value));
  });
  it.each(["create_case", "read_case", "update_case", "read_case_document", "write_case_document"])("keeps %s data on the wire while redacting persisted input and output", name => {
    const value = {
      item: { type: "tool_use", name, input: { caseId: "private-case", fields: { customer: "private-customer" }, body: "private-body", kickoff: { instructions: "private-kickoff" }, initialDocuments: [{ key: "brief", title: "Brief", body: "private-document" }] } },
      result: { operationId: name, result: { data: { fields: { customer: "private-customer" } } } },
    };
    const saved = redactRunnerApiPayloads(value);
    expect(JSON.stringify(saved)).not.toMatch(/private-case|private-customer|private-body|private-kickoff|private-document/);
    expect(saved.item.input).toMatchObject({ apiPayloadRedacted: true, apiPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(value.item.input.body).toBe("private-body");
    expect(redactRunnerApiPayloads(saved)).toEqual(saved);
  });
});
