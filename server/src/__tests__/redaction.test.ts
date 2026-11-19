import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("explicit diagnostic credential forms", () => {
  it("masks qualified credential fields while preserving metadata", () => {
    expect(redactEventPayload({ authorizationHeader: "abcdefghijkl", apiKeyProduction: "sensitivevalue", credentialHandling: "harness", tokenPolicy: "least privilege" }))
      .toEqual({ authorizationHeader: "***REDACTED***", apiKeyProduction: "***REDACTED***", credentialHandling: "harness", tokenPolicy: "least privilege" });
  });
  it("masks standalone bearer values and whitespace-prefixed JSON token headers", () => {
    const jwt = `${Buffer.from(' {"alg":"HS256","typ":"JWT"}').toString("base64url")}.abcdefghijk.abcdefghijkl`;
    // supersedes("provider said Bearer abcdefghijkl" masked; RFL record SUPERSEDE-BEARER-PROSE-1117): an all-letter word is prose under the allowlist (the accepted residual); a credential-shaped value with digits stays masked.
    expect(redactSensitiveText("provider said Bearer abc123def456")).not.toContain("abc123def456");
    expect(redactEventPayload({ diagnostic: jwt })?.diagnostic).toBe("***REDACTED***");
    expect(redactSensitiveText("Use bearer authentication and bearer tokens.")).toBe("Use bearer authentication and bearer tokens.");
  });
});
import {
  PRP_V1_EVENT_TYPES,
  PRP_V2_EVENT_TYPES,
  REDACTED_EVENT_VALUE,
  redactAgentAdapterConfig,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

import { createCopilotToolEvidence } from "../../../packages/paperclip-runner/src/drivers/acpx/copilot-tool-evidence.js";
import { appendSemanticToolReceipt } from "../../../packages/paperclip-runner/src/drivers/semantic-tool-receipt.js";

function receiptNotice(version: 1 | 2 = 1): Record<string, any> {
  return {
    schema: "paperclip.provider.notice.v1", noticeId: `copilot-evidence-${"a".repeat(24)}-1`,
    severity: "info", category: `paperclip_semantic_tool_receipt_v${version}`, scope: "turn",
    recoverable: true, userActionable: false, summary: "Paperclip returned a semantic tool result.",
    provenance: { method: "paperclip/semantic_tool_result", eventType: "semantic_result", sessionId: "session", turnId: "turn" },
    details: Object.entries({ stage: "semantic_result", schema: `paperclip.semantic_tool_receipt.v${version}`,
      operationId: "finish_task", callIdentitySha256: "a".repeat(64), inputSha256: "b".repeat(64),
      resultSha256: "c".repeat(64), outcome: "returned", ...(version === 2 ? { normalizedInputSha256: "d".repeat(64) } : {}),
    }).map(([name, value]) => ({ name, value })),
  };
}
const receiptSchemaValue = (notice: Record<string, any>) => notice.details.find((detail: any) => detail.name === "schema").value;

describe("redaction", () => {
  it.each([1, 2, 3] as const)("preserves structured panel activation and redacts adjacent secrets in PRP v%s", version => {
    const event = { schema: `paperclip.prp.event.v${version}`, schemaVersion: version,
      eventType: "runtime.activity.recorded", payload: { namespace: "example.runtime", activityKey: "desktop.used" } };
    expect(redactEventPayload({ prpEvent: event })).toEqual({ prpEvent: event });
    expect(redactEventPayload({ prpEvent: { ...event, payload: { ...event.payload, apiKey: "secret-sentinel" } } }))
      .toEqual({ prpEvent: { ...event, payload: { ...event.payload, apiKey: REDACTED_EVENT_VALUE } } });
  });
  it.each([1, 2, 3] as const)("preserves credential update metadata and masks adjacent secrets in PRP v%s", version => {
    const event = { schema: `paperclip.prp.event.v${version}`, schemaVersion: version,
      eventType: "auth.credentials.updated", payload: { schema: "paperclip.auth.credentials.updated.v1",
        provider: "codex", bindingId: "harness-auth", revision: 1, detection: "credential_store" } };
    expect(redactEventPayload({ prpEvent: event })).toEqual({ prpEvent: event });
    expect(redactEventPayload({ prpEvent: { ...event, payload: { ...event.payload, refresh_token: "secret-sentinel" } } }))
      .toEqual({ prpEvent: { ...event, payload: { ...event.payload, refresh_token: REDACTED_EVENT_VALUE } } });
  });

  it("preserves the actual Copilot receipt producer discriminator through nested durable redaction", () => {
    const events: Array<Record<string, any>> = [];
    const projector = createCopilotToolEvidence({ sessionId: "session", turnId: "turn", workingDirectory: "/workspace",
      active: () => true, emit: event => events.push(event) });
    const receipt = appendSemanticToolReceipt({ tool: "finish_task", callId: "call", arguments: {} },
      { content: [{ type: "text", text: "accepted" }] }).receipt;
    expect(receipt.schema).toBe("paperclip.semantic_tool_receipt.v2");
    projector.captureSemanticReceipt()!(receipt);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.category).toBe("paperclip_semantic_tool_receipt_v2");
    expect(events[0]!.payload.details).toHaveLength(8);
    const input = { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1,
      eventType: "provider.notice.recorded", payload: events[0]!.payload } };
    expect(redactEventPayload(input)).toEqual(input);
    expect(redactEventPayload(redactEventPayload(input))).toEqual(input);
  });

  it.each([1, 2] as const)("preserves public v%s receipt identifiers as text", version => {
    const notice = receiptNotice(version);
    expect(redactEventPayload(notice)).toEqual(notice);
    // Master's JWT detector recognizes encoded headers, so a dotted public
    // identifier needs no receipt-shaped exemption to survive redaction.
    expect(redactEventPayload({ value: `paperclip.semantic_tool_receipt.v${version}` }))
      .toEqual({ value: `paperclip.semantic_tool_receipt.v${version}` });
  });

  it("redacts credentials in receipt-shaped data and every adjacent field", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345678";
    const notice = receiptNotice();
    notice.details.find((d: any) => d.name === "operationId").value = jwt;
    notice.provenance.sessionId = jwt;
    const redacted = redactEventPayload(notice)! as Record<string, any>;
    expect(receiptSchemaValue(redacted)).toBe("paperclip.semantic_tool_receipt.v1");
    expect(redacted.details.find((d: any) => d.name === "operationId").value).toBe(REDACTED_EVENT_VALUE);
    expect(redacted.provenance.sessionId).toBe(REDACTED_EVENT_VALUE);
    expect(redactEventPayload({ notice, password: "canary", arbitrary: jwt }))
      .toMatchObject({ password: REDACTED_EVENT_VALUE, arbitrary: REDACTED_EVENT_VALUE });
    notice.details.find((d: any) => d.name === "schema").value = jwt;
    notice.summary = "Authorization: Bearer canary-token";
    const hostile = redactEventPayload(notice)!;
    expect(receiptSchemaValue(hostile)).toBe(REDACTED_EVENT_VALUE);
    expect(JSON.stringify(hostile)).not.toContain("canary-token");
  });

  it("keeps the discriminator allowlist in exact PRP v1 schema parity", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/schemas/event.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { eventType: { enum: string[] } } };
    expect([...PRP_V1_EVENT_TYPES]).toEqual(schema.properties.eventType.enum);
  });

  it("keeps the v2 additions in parity with the canonical v2 schema", () => {
    const v1 = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/schemas/event.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { eventType: { enum: string[] } } };
    const v2 = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/schemas/event-v2.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { eventType: { enum: string[] } } };
    const v1Types = new Set(v1.properties.eventType.enum);
    expect([...PRP_V2_EVENT_TYPES]).toEqual(
      v2.properties.eventType.enum.filter((eventType) => !v1Types.has(eventType)),
    );
  });

  it("preserves every discriminator in the cross-language replay stream", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/fixtures/replay/duplicate-event.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    for (const event of fixture.events) {
      const sanitized = redactEventPayload({ prpEvent: event });
      const envelope = sanitized?.prpEvent as Record<string, unknown>;
      expect(envelope.eventType).toBe(event.eventType);
      expect(envelope.sourceEventId).toBe(event.sourceEventId);
      expect(envelope.payload).toEqual(event.payload);
    }
  });

  it("preserves current PRP v2 session discriminators", () => {
    const schema = JSON.parse(readFileSync(
      new URL("../../../packages/paperclip-runner/protocol/schemas/event-v2.schema.json", import.meta.url),
      "utf8",
    )) as { properties: { eventType: { enum: string[] } } };
    for (const eventType of schema.properties.eventType.enum) {
      const event = {
        schema: "paperclip.prp.event.v2",
        schemaVersion: 2,
        eventType,
        payload: { safe: true },
      };
      const sanitized = redactEventPayload({ prpEvent: event });
      expect(sanitized?.prpEvent).toEqual(event);
    }
  });

  it("preserves diagnostic PRP discriminators while redacting their credential payloads", () => {
    const unknown = redactEventPayload({
      prpEvent: {
        schema: "paperclip.prp.event.v2",
        schemaVersion: 2,
        eventType: "session.not-a-real.event",
      },
    });
    expect((unknown?.prpEvent as Record<string, unknown>).eventType).toBe(
      "session.not-a-real.event",
    );

    const mismatched = redactEventPayload({
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 2,
        eventType: "session.capabilities.updated",
      },
    });
    expect((mismatched?.prpEvent as Record<string, unknown>).eventType).toBe(
      "session.capabilities.updated",
    );

    const secretPayload = redactEventPayload({
      prpEvent: {
        schema: "paperclip.prp.event.v2",
        schemaVersion: 2,
        eventType: "session.capabilities.updated",
        payload: { authorization: "Bearer secret-value" },
      },
    });
    expect(
      ((secretPayload?.prpEvent as Record<string, unknown>).payload as Record<string, unknown>)
        .authorization,
    ).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "aaa.bbb.ccc",
          projectionAllowlistKey: "aaa.bbb.ccc",
          token: "must-not-survive-reference-shape",
        },
        USER_API_KEY_REF: {
          type: "user_secret_ref",
          key: "OPENAI_API_KEY",
          password: "must-not-survive-user-reference-shape",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      USER_API_KEY_REF: {
        type: "user_secret_ref",
        key: "OPENAI_API_KEY",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = {
      session: jwt,
      opaque: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.opaque).toBe("aaa.bbb.ccc");
    expect(result.normal).toBe("plain");
  });

  it("preserves Paperclip protocol schema identifiers", () => {
    expect(
      sanitizeRecord({
        schema: "paperclip.question_set.v1",
        nested: {
          schema: "paperclip.question_response.v1",
          runtimeSchema: "paperclip.runtime_request.v2",
          arbitraryProviderValue: "paperclip.question_set.v1",
        },
      }),
    ).toEqual({
      schema: "paperclip.question_set.v1",
      nested: {
        schema: "paperclip.question_response.v1",
        runtimeSchema: "paperclip.runtime_request.v2",
        arbitraryProviderValue: "paperclip.question_set.v1",
      },
    });
  });

  it("preserves native execution v5 and model envelope v3 schema identifiers", () => {
    const input = {
      schema: "paperclip.native-execution-input.v5",
      nested: {
        runtimeSchema: "paperclip.native-model-envelope.v3",
        providerValue: "paperclip.native-execution-input.v5",
      },
    };
    expect(sanitizeRecord(input)).toEqual({
      schema: input.schema,
      nested: {
        runtimeSchema: input.nested.runtimeSchema,
        providerValue: input.nested.providerValue,
      },
    });
    expect(sanitizeRecord({ schema: "paperclip.native-execution-input.v9" })).toEqual({ schema: "paperclip.native-execution-input.v9" });
    expect(sanitizeRecord({ schema: "paperclip.native-execution-input.v7", runtimeSchema: "paperclip.native-execution-input.v8" })).toEqual({
      schema: "paperclip.native-execution-input.v7",
      runtimeSchema: "paperclip.native-execution-input.v8",
    });
    expect(sanitizeRecord({ schema: "paperclip.native-execution-input.v4", runtimeSchema: "paperclip.native-model-envelope.v2" })).toEqual({
      schema: "paperclip.native-execution-input.v4",
      runtimeSchema: "paperclip.native-model-envelope.v2",
    });
  });

  it("preserves only known PRP v1 event discriminators inside validated envelopes", () => {
    const payload = {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: "run.result.accepted",
          credential: "aaa.bbb.ccc",
        },
      },
      unrelated: {
        eventType: "workspace.file.referenced",
      },
    };

    const sanitized = redactEventPayload(payload);

    expect(sanitized).toEqual({
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: "run.result.accepted",
          credential: REDACTED_EVENT_VALUE,
        },
      },
      unrelated: {
        eventType: "workspace.file.referenced",
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("preserves unknown dotted event values instead of treating them as JWTs", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "attacker.supplied.token",
      })?.eventType,
    ).toBe("attacker.supplied.token");
  });

  it("preserves dotted schema identifiers without interpreting their authority", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.attacker.control.v1",
        runtimeSchema: "paperclip.attacker.runtime.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
      }),
    ).toEqual({
      schema: "paperclip.attacker.control.v1",
      runtimeSchema: "paperclip.attacker.runtime.v1",
      schemaVersion: 1,
      eventType: "tool.execution.started",
    });
  });

  it("preserves native run span identities and ordinary hostnames", () => {
    const spanNames = [
      "environment.workspace.realize",
      "native.coordinator.claim",
      "runner.transport.selected",
      "runner.prp.authenticate",
      "runner.prp.route.register",
      "runner.transport.connect",
      "runner.transport.attach",
      "runner.pi.attach",
      "runner.pi.bind",
      "runner.pi.begin_turn",
      "runner.pi.interrupt_wait",
      "runner.pi.prompt_to_started",
      "runner.pi.admission.get_state",
      "runner.pi.admission.set_model",
      "runner.pi.admission.get_available_thinking_levels",
      "runner.pi.admission.set_thinking_level",
      "runner.session.bootstrap",
      "runner.runtime.stage",
      "runner.process.launch",
      "provider.session.load",
      "runner.turn.submit",
      "runner.session.startup",
      "provider_pack.select",
      "provider_pack.discover",
      "provider_pack.verify_uploaded",
      "provider_pack.upload",
      "provider.turn.queue",
      "question_response.to_run_created",
      "native.session.execute",
      "native.result.finalize",
      "task.run.measured",
    ];

    for (const span of spanNames) {
      const input = {
        schema: "paperclip.run-performance-span.v1",
        span,
        parentSpan: "native.session.execute",
        providerHostname: "api.openai.com",
      };
      const sanitized = redactEventPayload(input);

      expect(sanitized).toMatchObject({
        schema: input.schema,
        span,
        parentSpan: "native.session.execute",
        providerHostname: "api.openai.com",
      });
      expect(redactEventPayload(sanitized)).toEqual(sanitized);
    }

    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "api.openai.com",
      })?.span,
    ).toBe("api.openai.com");
    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "runner.example.com",
      })?.span,
    ).toBe("runner.example.com");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts credentials in ordinary nested diagnostic strings", () => {
    const sanitized = redactEventPayload({
      message: "request failed with Authorization: Basic dXNlcjpwYXNz",
      diagnostic: {
        reason: "upstream returned Bearer live-provider-token",
        details: [
          "safe context",
          "proxyAuthorization Basic nested-proxy-secret",
          "aaa.bbb.ccc",
          ["Bearer nested-array-secret"],
        ],
      },
    });

    expect(sanitized).toEqual({
      message: `request failed with Authorization: ${REDACTED_EVENT_VALUE}`,
      diagnostic: {
        reason: `upstream returned Bearer ${REDACTED_EVENT_VALUE}`,
        details: [
          "safe context",
          `proxyAuthorization ${REDACTED_EVENT_VALUE}`,
          "aaa.bbb.ccc",
          [`Bearer ${REDACTED_EVENT_VALUE}`],
        ],
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("preserves authorization decision reasons in audit payloads", () => {
    expect(
      redactEventPayload({
        authorizationReason: "allow_scoped_agent_write",
        authorization: "Bearer secret",
        surface: "issue.comment.create",
      }),
    ).toEqual({
      authorizationReason: "allow_scoped_agent_write",
      authorization: REDACTED_EVENT_VALUE,
      surface: "issue.comment.create",
    });
  });

  /**
   * A removal receipt (PAP-17119) has to show what it revoked, so a fixed set of
   * count keys is exempt from the secret-key guard — but only while the value is
   * a number. The second half of this test is the point: the same key carrying
   * anything else is still blanked, so the exemption cannot be used to smuggle
   * material out under a familiar name.
   */
  it("keeps numeric removal-receipt counts but still redacts non-numeric values on the same keys", () => {
    expect(
      sanitizeRecord({
        secretsRevoked: 2,
        secretsRetainedShared: 0,
        credentialRefsCleared: 3,
        secretBindingsRemoved: 3,
        tokenIssuanceHashesCleared: 1,
        gatewayTokensRevoked: 0,
        appProfile: "deleted",
      }),
    ).toEqual({
      secretsRevoked: 2,
      secretsRetainedShared: 0,
      credentialRefsCleared: 3,
      secretBindingsRemoved: 3,
      tokenIssuanceHashesCleared: 1,
      gatewayTokensRevoked: 0,
      appProfile: "deleted",
    });

    expect(
      sanitizeRecord({
        secretsRevoked: "pasted-api-key-value",
        secretBindingsRemoved: { name: "tool_app.abc.headers_authorization" },
        tokenIssuanceHashesCleared: Number.NaN,
        gatewayTokensRevoked: ["pcgw_live_token"],
      }),
    ).toEqual({
      secretsRevoked: REDACTED_EVENT_VALUE,
      secretBindingsRemoved: REDACTED_EVENT_VALUE,
      tokenIssuanceHashesCleared: REDACTED_EVENT_VALUE,
      gatewayTokensRevoked: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts authorization variants and standalone bearer credentials from diagnostic text", () => {
    const input = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Authorization Basic uncolonized-secret",
      "proxyAuthorization Basic compound-secret",
      'Authorization Bearer abc"embedded-tail',
      'Authorization "Bearer quoted-secret"',
      'request failed with Bearer standalone"embedded-tail',
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(`Authorization: ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`proxyAuthorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization "${REDACTED_EVENT_VALUE}"`);
    expect(result).toContain(`Bearer ${REDACTED_EVENT_VALUE}`);
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("uncolonized-secret");
    expect(result).not.toContain("compound-secret");
    expect(result).not.toContain("embedded-tail");
    expect(result).not.toContain("quoted-secret");
    expect(result).not.toContain("standalone-secret");
    expect(redactSensitiveText(result)).toBe(result);
  });

  it("redacts raw and escaped quote-delimited authorization values without leaking nested content", () => {
    const cases = [
      {
        input: 'prefix Authorization: Bearer "two word secret" suffix',
        expected: `prefix Authorization: ${REDACTED_EVENT_VALUE} suffix`,
      },
      {
        input: "prefix Authorization: Basic 'two word secret' suffix",
        expected: `prefix Authorization: ${REDACTED_EVENT_VALUE} suffix`,
      },
      {
        input: String.raw`prefix {\"Authorization\":\"Basic dXNlcjpwYXNz\"} suffix`,
        expected: String.raw`prefix {\"Authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: String.raw`prefix Authorization: \"Bearer \\\"nested two word secret\\\"\" suffix`,
        expected: String.raw`prefix Authorization: \"***REDACTED***\" suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("two word secret");
      expect(result).not.toContain("dXNlcjpwYXNz");
      expect(redactSensitiveText(result)).toBe(result);
    }
  });

  it("redacts raw and serialized standalone bearer values without leaking quoted content", () => {
    const cases = [
      {
        input: 'prefix Bearer "two word secret" suffix',
        expected: `prefix Bearer "${REDACTED_EVENT_VALUE}" suffix`,
      },
      {
        input: "prefix Bearer 'two word secret' suffix",
        expected: `prefix Bearer '${REDACTED_EVENT_VALUE}' suffix`,
      },
      {
        input: String.raw`prefix Bearer \"two word secret\" suffix`,
        expected: String.raw`prefix Bearer \"***REDACTED***\" suffix`,
      },
      {
        input: String.raw`prefix Bearer \"outer \\\"nested secret\\\" value\" suffix`,
        expected: String.raw`prefix Bearer \"***REDACTED***\" suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("two word secret");
      expect(result).not.toContain("nested secret");
      expect(redactSensitiveText(result)).toBe(result);
    }
  });

  it("redacts token tails attached to raw and escaped closing credential quotes", () => {
    const cases = [
      {
        input: 'Authorization: Basic "abc"defg retry',
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: String.raw`Authorization: Basic \"abc\"defg retry`,
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: 'Bearer "abc"defg retry',
        expected: `Bearer "${REDACTED_EVENT_VALUE}"`,
      },
      {
        input: String.raw`Bearer \"abc\"defg retry`,
        expected: String.raw`Bearer \"***REDACTED***\"`,
      },
      {
        input: 'Authorization: Basic "abc"defg retry\nsafe context',
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input:
          String.raw`Authorization: Basic \"abc\"defg retry` + "\nsafe context",
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: 'authorization="Bearer abc\ndef" status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}" status=401`,
      },
      {
        input: String.raw`authorization=\"Bearer abc
def\" status=401`,
        expected: String.raw`authorization=\"***REDACTED***\" status=401`,
      },
      {
        input: 'authorization="Bearer abc"\ndef" status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}" status=401`,
      },
      {
        input: String.raw`authorization=\"Bearer abc\"
def\" status=401`,
        expected: String.raw`authorization=\"***REDACTED***\" status=401`,
      },
      {
        input: 'authorization="Bearer abc"\ndef status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}"`,
      },
      {
        input: String.raw`authorization=\"Bearer abc\"
def status=401`,
        expected: String.raw`authorization=\"***REDACTED***\"`,
      },
      {
        input:
          'authorization="Bearer first-line"\nrequest failed with Bearer standalone"embedded-tail',
        expected: `authorization="${REDACTED_EVENT_VALUE}"\nrequest failed with Bearer ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: String.raw`authorization=\"Bearer first-line\"
request failed with Bearer standalone\"embedded-tail`,
        expected: String.raw`authorization=\"***REDACTED***\"
request failed with Bearer ***REDACTED***`,
      },
      {
        input: String.raw`{\"authorization\":\"Bearer a\"b c\"} suffix`,
        expected: String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: `{"authorization":"Bearer a"b c"} suffix`,
        expected: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      },
      {
        input: String.raw`{\"authorization\":\"Bearer a\" b c\"} suffix`,
        expected: String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: `{"authorization":"Bearer a" b c"} suffix`,
        expected: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("abc");
      expect(result).not.toContain("defg");
      expect(result).not.toContain('a"b c');
      expect(result).not.toContain('a" b c');
      expect(redactSensitiveText(result)).toBe(result);
    }

    const sanitized = redactEventPayload({
      message: 'Authorization: Basic "abc"defg retry',
      malformedProviderText: '{"authorization":"Bearer a" b c"} suffix',
      authorization: 'Bearer a"b c"',
      nested: {
        diagnostics: [
          String.raw`Bearer \"abc\"defg retry`,
          String.raw`{\"authorization\":\"Bearer a\"b c\"} suffix`,
          String.raw`authorization=\"Bearer first-line
second-line\" status=401`,
          String.raw`authorization=\"Bearer first-line\"
second-line\" status=401`,
        ],
      },
    });
    expect(sanitized).toEqual({
      message: `Authorization: ${REDACTED_EVENT_VALUE}`,
      malformedProviderText: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      authorization: REDACTED_EVENT_VALUE,
      nested: {
        diagnostics: [
          String.raw`Bearer \"***REDACTED***\"`,
          String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
          String.raw`authorization=\"***REDACTED***\" status=401`,
          String.raw`authorization=\"***REDACTED***\" status=401`,
        ],
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command:
        "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: [
        "--safe",
        "ok",
        "--token",
        "ghp_arg_secret",
        "--api-key=sk-inline-example",
      ],
      env: {
        PAPERCLIP_RESOLVED_COMMAND:
          "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND: `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual([
      "--api-key",
      REDACTED_EVENT_VALUE,
      "safe-next",
    ]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });

  it("redacts every plaintext agent env binding while preserving secret references", () => {
    const plaintextValue = "adapter-env-value-must-not-leak";

    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: plaintextValue,
        NEW_VALUE: { type: "plain", value: plaintextValue },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });

    expect(result).toEqual({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        NEW_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(plaintextValue);
  });

  it("redacts non-env adapter keys while leaving env binding shapes intact", () => {
    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      apiKey: "adapter-level-secret",
      env: {
        API_KEY: "env-level-secret",
        AUTH_TOKEN: { type: "plain", value: "another-env-secret" },
      },
    });

    // Non-env keys still go through the shared payload sanitizer.
    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.command).toBe("pnpm agent:run");

    // Env bindings keep their binding shape rather than collapsing to a bare
    // sentinel string, which is what a second sanitizer pass would produce for
    // these sensitive-looking key names.
    expect(result.env).toEqual({
      API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
      AUTH_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
    });
  });

  it("redacts adapter configs that have no env block", () => {
    expect(redactAgentAdapterConfig({ command: "pnpm agent:run", apiKey: "secret" })).toEqual({
      command: "pnpm agent:run",
      apiKey: REDACTED_EVENT_VALUE,
    });
  });
});

describe("redaction of long letter/digit runs", () => {
  const typescriptSource = [
    "export function compactRunLogChunk(chunk: string, maxChars = 65536) {",
    "  const normalized = redactSensitiveText(chunk);",
    "  if (normalized.length <= maxChars) return normalized;",
    "  return normalized.slice(0, maxChars);",
    "}",
    "",
  ].join("\n");

  function base64OfTypeScriptSource(length: number) {
    const repeatedSource = typescriptSource.repeat(Math.ceil(length / typescriptSource.length));
    return Buffer.from(repeatedSource).toString("base64").slice(0, length);
  }

  function redactWithinTimeBudget(input: string) {
    const startedAt = performance.now();
    const output = redactSensitiveText(input);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    return output;
  }

  it("redacts secret field names that carry a prefix in plain and escaped JSON", () => {
    const cases = [
      [`{"myApiKey": "plain-prefixed-secret"}`, `{"myApiKey": "${REDACTED_EVENT_VALUE}"}`],
      [`{"x_auth_token":"snake-prefixed-secret","status":"ok"}`, `{"x_auth_token":"${REDACTED_EVENT_VALUE}","status":"ok"}`],
      [`GITHUB_TOKEN: "upper-prefixed-secret"`, `GITHUB_TOKEN: "${REDACTED_EVENT_VALUE}"`],
      [`{'db_password': 'single-quoted-secret'}`, `{'db_password': '${REDACTED_EVENT_VALUE}'}`],
      [`text"apiKey":"glued-quote-secret"`, `text"apiKey":"${REDACTED_EVENT_VALUE}"`],
      [`aGVsbG8apiKey:"glued-run-secret"`, `aGVsbG8apiKey:"${REDACTED_EVENT_VALUE}"`],
      [String.raw`{\"myApiKey\":\"escaped-prefixed-secret\"}`, String.raw`{\"myApiKey\":\"${REDACTED_EVENT_VALUE}\"}`],
      [
        String.raw`{\"x_auth_token\":\"escaped-snake-secret\",\"status\":\"ok\"}`,
        String.raw`{\"x_auth_token\":\"${REDACTED_EVENT_VALUE}\",\"status\":\"ok\"}`,
      ],
      [String.raw`aGVsbG8\"GITHUB_TOKEN\":\"escaped-glued-secret\"`, String.raw`aGVsbG8\"GITHUB_TOKEN\":\"${REDACTED_EVENT_VALUE}\"`],
    ];

    for (const [input, expected] of cases) {
      expect(redactSensitiveText(input)).toBe(expected);
      expect(redactSensitiveText(expected)).toBe(expected);
    }
  });

  it("keeps base64 of source text intact and fast while redacting a secret glued to its end", () => {
    const blob = base64OfTypeScriptSource(48 * 1024);
    expect(blob).toMatch(/^[A-Za-z0-9]+$/);

    const shellCommand = `printf '%s' '${blob}' | base64 -d > src/compact.ts`;
    expect(redactWithinTimeBudget(shellCommand)).toBe(shellCommand);

    const toolCallLine = JSON.stringify({ type: "tool_use", input: { command: shellCommand } });
    expect(redactWithinTimeBudget(toolCallLine)).toBe(toolCallLine);
    const serializedToolCallLine = JSON.stringify(toolCallLine);
    expect(redactWithinTimeBudget(serializedToolCallLine)).toBe(serializedToolCallLine);

    const gluedSecret = redactWithinTimeBudget(`${blob}apiKey:"run-glued-secret"`);
    expect(gluedSecret).toBe(`${blob}apiKey:"${REDACTED_EVENT_VALUE}"`);
  });

  it("scans long dash-separated runs in linear time", () => {
    for (const run of ["a-".repeat(60_000), "a--".repeat(40_000)]) {
      expect(redactWithinTimeBudget(`${run} Authorization: Bearer dash-run-secret`))
        .toBe(`${run} Authorization: ${REDACTED_EVENT_VALUE}`);
      expect(redactWithinTimeBudget(`${run}Authorization: Bearer glued-run-secret`))
        .toBe(`${run}Authorization: ${REDACTED_EVENT_VALUE}`);
    }
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
// Keep reason: credential non-disclosure and preservation of ordinary terminal output.
describe("ANSI-stripped credential view", () => {
  const colour = "\u001b[31m";
  const reset = "\u001b[0m";
  const shapes = [
    ["sk-proj-", "sk-proj-", "rf2SyntheticOnly0123456789ABCDEF"],
    ["sk-ant-", "sk-ant-", "rf2SyntheticOnly0123456789ABCDEF"],
    ["ghp_", "ghp_", "rf2SyntheticOnly0123456789ABCDEF"],
    ["github_pat_", "github_pat_", "rf2SyntheticOnly0123456789ABCDEF"],
    ["AKIA", "AKIA", "RF2SYNTH01234567"],
    ["JWT", "eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl"],
    ["Bearer", "Bearer ", "rf2SyntheticOnly0123456789ABCDEF"],
  ] as const;

  function masked(prefix: string) {
    return prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
  }

  it.each(shapes)("(a) masks %s with a colour immediately after its prefix", (_shape, prefix, body) => {
    expect(redactSensitiveText(`${prefix}${colour}${body}${reset}`))
      .toBe(`${prefix === "Bearer " ? `Bearer ${colour}${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE}${reset}`);
  });

  it("(a) masks a realistic grep --color pty line, including erase-line CSI", () => {
    expect(redactSensitiveText("\u001b[01;31m\u001b[Ksk-proj-\u001b[m\u001b[Krf2SyntheticOnly0123456789ABCDEF"))
      .toBe(`\u001b[01;31m\u001b[K${REDACTED_EVENT_VALUE}`);
  });

  const ordinary = [
    "completed work successfully", "request id rf2-run-218 finished", "/srv/workspaces/rf2/src/main.ts",
    `sha256:${"0123456789abcdef".repeat(4)}`, "612a1fce4e6bc5e4693461070b20eb24c56e55b5",
    "123e4567-e89b-42d3-a456-426614174000", "bearer of good news",
    "standard bearer marks every room", "Authorization policy passed", "aws_region=us-east-1",
  ].flatMap(text => [
    `${colour}${text}${reset}`, `INFO ${colour}${text}${reset} done`,
    `${text.slice(0, 3)}${colour}${text.slice(3)}${reset}`,
  ]);
  it.each(ordinary)("(b) keeps ordinary coloured output byte-equal: %j", input => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it.each(shapes)("(c) masks %s with codes before and after the token", (_shape, prefix, body) => {
    expect(redactSensitiveText(`${colour}${prefix}${body}${reset}`))
      .toBe(`${colour}${masked(prefix)}${reset}`);
    expect(redactSensitiveText(`${prefix}${body}${colour}${reset}`))
      .toBe(`${masked(prefix)}${colour}${reset}`);
  });

  it.each(shapes)("(d/e) masks all of %s with codes between body characters, without an ESC fragment", (_shape, prefix, body) => {
    const result = redactSensitiveText(`${colour}${prefix}${body.slice(0, 3)}\u001b[01;31m\u001b[K${body.slice(3)}${reset}`);
    expect(result).toBe(`${colour}${masked(prefix)}${reset}`);
    expect(result.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")).toBe(masked(prefix));
  });

  const corpus = JSON.parse(readFileSync(
    new URL("./fixtures/redact-store-corpus.json", import.meta.url), "utf8",
  )) as Array<{ input: string; expected: string }>;
  it.each(corpus)("keeps the range-aware scanner in parity with the shared patterns: $input", ({ input, expected }) => {
    expect(redactSensitiveText(`${colour}${input}${reset}`)).toBe(`${colour}${expected}${reset}`);
  });

  it.each([`API_KEY=""`, `API_KEY=''`, String.raw`API_KEY=\"\"`])("maps an empty credential without consuming adjacent codes: %s", input => {
    expect(redactSensitiveText(`${colour}${input}${reset}`))
      .toBe(`${colour}${redactSensitiveText(input)}${reset}`);
  });

  it("keeps colour codes between quoted credentials containing repeated text", () => {
    const input = `Bearer "first1\" foo c Bearer \"middle2",${colour} foo c Bearer ${reset}"second3\" foo c Bearer \"last4"`;
    expect(redactSensitiveText(input))
      .toBe(`Bearer "${REDACTED_EVENT_VALUE}",${colour} foo c Bearer ${reset}"${REDACTED_EVENT_VALUE}"`);
  });

  it("preserves literal masks, Unicode context and separate colour boundaries around two secrets", () => {
    const input = `🙂 ${REDACTED_EVENT_VALUE} ${colour}sk-proj-rf2SyntheticOnly0123456789ABCDEF${reset} middle \u001b[32mgithub_pat_rf2SyntheticOnly0123456789ABCDEF${reset}`;
    expect(redactSensitiveText(input))
      .toBe(`🙂 ${REDACTED_EVENT_VALUE} ${colour}${REDACTED_EVENT_VALUE}${reset} middle \u001b[32m${REDACTED_EVENT_VALUE}${reset}`);
  });

  it.each([["", ""], [colour, reset]])("keeps decoded JSON leaf quote context with external CSI %j", (before, after) => {
    expect(redactSensitiveText(`${before}bearer abc${after}`, { quotedLeaf: true }))
      .toBe(`${before}bearer ${REDACTED_EVENT_VALUE}${after}`);
  });

  const sweep = [
    ...corpus.filter(row => row.input === row.expected).map(row => `${colour}${row.input}${reset}`),
    `the ${colour}bearer of${reset} good news`,
    `Use ${colour}bearer authentication${reset} here`,
    `a ${colour}bearer bond${reset} matured`,
    `${colour}bearer A${reset}`, `${colour}bearer word.${reset}`, `${colour}bearer Well-known${reset}`,
  ];
  it.each(sweep)("(f) preserves accepted ANSI prose and every reset: %j", input => {
    expect(redactSensitiveText(input)).toBe(input);
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
// Keep reason: never disclose credentials; preserve short/prose tails at CSI boundaries.
describe("union of transparent and bare-token boundary ANSI views", () => {
  const colour = "\u001b[31m";
  const reset = "\u001b[0m";
  const body = "rf2SyntheticOnly0123456789ABCDEF";
  const shapes = [
    ["sk-proj-", "sk-proj-", body],
    ["sk-ant-", "sk-ant-", body],
    ["ghp_", "ghp_", body],
    ["github_pat_", "github_pat_", body],
    ["AKIA", "AKIA", "RF2SYNTH01234567"],
    ["JWT", "eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl"],
    ["Bearer", "Bearer ", body],
  ] as const;
  const codes = [colour, "\u001b[K", "\u001b[01;31m\u001b[K", "\u001b[1C"];
  const before = ["x", "7", "_", "-", "="];
  const matrix = shapes.flatMap(([shape, prefix, tail]) => before.flatMap(word => codes.map(code => ({
    shape, word, code, input: `${word}${code}${prefix}${tail}${reset}`,
    // A CSI immediately before Bearer admits only a strict token body on V2.
    expected: `${word}${code}${prefix === "Bearer " ? "Bearer " : ""}${REDACTED_EVENT_VALUE}${reset}`,
  }))));
  it.each(matrix)("(x) $shape after $word and CSI $code", ({ input, expected }) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  const witnesses = [
    ["standard\u001b[31mbearer abc123def\u001b[0m", "standard\u001b[31mbearer abc123def\u001b[0m"],
    [`prefix${colour}sk-proj-${body}${reset}`, `prefix${colour}${REDACTED_EVENT_VALUE}${reset}`],
    [`the ${colour}bearer of${reset} good news`, `the ${colour}bearer of${reset} good news`],
    [`Use ${colour}bearer authentication${reset} here`, `Use ${colour}bearer authentication${reset} here`],
  ];
  it.each(witnesses)("(w) ruled A2 witness %j", (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each(shapes)("(x) repeated CSI and line-start %s", (_shape, prefix, tail) => {
    const masked = prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
    const glued = `prefix${colour}\u001b[K${prefix}${tail}${reset}`;
    expect(redactSensitiveText(glued)).toBe(`prefix${colour}\u001b[K${masked}${reset}`);
    expect(redactSensitiveText(`${colour}${prefix}${tail}${reset}`)).toBe(`${colour}${masked}${reset}`);
  });

  it.each(shapes)("(y) %s retains transparent prefix/body matching", (_shape, prefix, tail) => {
    const masked = prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
    const insidePrefix = `${prefix.slice(0, 2)}${colour}${prefix.slice(2)}${tail}${reset}`;
    // CSI inside the Bearer word belongs to the preserved scheme, not its value.
    const expectedPrefix = prefix === "Bearer " ? `Be${colour}arer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
    expect(redactSensitiveText(insidePrefix)).toBe(`${expectedPrefix}${reset}`);
    expect(redactSensitiveText(`${colour}${prefix}${tail.slice(0, 3)}\u001b[K${tail.slice(3)}${reset}`))
      .toBe(`${colour}${masked}${reset}`);
  });

  it("keeps the actual whole-word grep capture unchanged, the pre-existing glued-key gap #21241", () => {
    // Exact bytes of inputs/real-grep-capture.bin, including its final newline.
    const capture = `\u001b[01;31m\u001b[Kprefixsk-proj-${body}\u001b[m\u001b[K\n`;
    expect(redactSensitiveText(capture)).toBe(capture);
    expect(redactSensitiveText(`prefixsk-proj-${body}`)).toBe(`prefixsk-proj-${body}`);
    expect(redactSensitiveText(`prefix\u001b[01;31m\u001b[Ksk-proj-${body}\u001b[m\u001b[K`))
      .toBe(`prefix\u001b[01;31m\u001b[K${REDACTED_EVENT_VALUE}\u001b[m\u001b[K`);
  });

  it("keeps real Bearer lines masked through transparent CSI beside the scheme-boundary negative", () => {
    expect(redactSensitiveText(`Authorization:${colour} Bearer\u001b[K abc123def${reset}`))
      .toBe(`Authorization:${colour} ${REDACTED_EVENT_VALUE}${reset}`);
    expect(redactSensitiveText(`Bearer${colour} abc123def${reset}`))
      .toBe(`Bearer${colour} ${REDACTED_EVENT_VALUE}${reset}`);
    expect(redactSensitiveText(`Bearer ${colour}abc123def${reset}`))
      .toBe(`Bearer ${colour}${REDACTED_EVENT_VALUE}${reset}`);
    expect(redactSensitiveText(`standard${colour}bearer abc123def${reset}`))
      .toBe(`standard${colour}bearer abc123def${reset}`);
  });

  const shortTails = ["sk-1", "sk-proj-123", "sk-ant-1234", "ghp_123", "github_pat_123", "AKIA12", "eyJ123"];
  it.each(shortTails)("keeps a short non-key after CSI: %s", tail => {
    const input = `task${colour}${tail}${reset}`;
    expect(redactSensitiveText(input)).toBe(input);
  });
  it.each(["gho_", "ghu_", "ghs_", "ghr_"])("uses the existing GitHub prefix %s", prefix => {
    expect(redactSensitiveText(`x${colour}${prefix}${body}${reset}`))
      .toBe(`x${colour}${REDACTED_EVENT_VALUE}${reset}`);
  });

  const gatedShapes = [
    ["sk-", "a".repeat(11), false], ["sk-", "a".repeat(12), true],
    ["ghp_", "a".repeat(19), false], ["ghp_", "a".repeat(20), true],
    ["github_pat_", "a".repeat(19), false], ["github_pat_", "a".repeat(20), true],
    ["AKIA", "A".repeat(15), false], ["AKIA", "A".repeat(16), true],
    ["AKIA", "a".repeat(16), false], ["AKIA", "A".repeat(17), false],
    ["sk-", "a".repeat(5) + "/" + "a".repeat(6), false],
    ["ghp_", "a".repeat(10) + "-" + "a".repeat(9), false],
    ["github_pat_", "a".repeat(10) + "/" + "a".repeat(9), false],
    ["eyJ", "abcdefgh.abcdefgh.abcdefgh", true],
  ] as const;
  it.each(gatedShapes)("does not relax uncoloured shape rules: %s%s (%s)", (prefix, tail, masks) => {
    const token = prefix + tail;
    const expected = masks ? REDACTED_EVENT_VALUE : token;
    expect(redactSensitiveText(token)).toBe(expected);
    expect(redactSensitiveText(`x${colour}${token}${reset}`)).toBe(`x${colour}${expected}${reset}`);
  });

  it("unions overlapping transparent and boundary spans instead of leaving a body fragment", () => {
    const token = "sk-" + "a".repeat(16) + colour + "b".repeat(16);
    expect(redactSensitiveText(`${colour}${token}${reset}`)).toBe(`${colour}${REDACTED_EVENT_VALUE}${reset}`);
    // Existing sk- charset includes the hyphen and the following AKIA-shaped tail.
    expect(redactSensitiveText(`${colour}sk-${"a".repeat(12)}-AKIA${"A".repeat(16)}${reset}`))
      .toBe(`${colour}${REDACTED_EVENT_VALUE}${reset}`);
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
// Keep reason: credential non-disclosure without reopening the F1 prose regression.
describe("narrow Bearer recognition at an immediate CSI boundary", () => {
  const reset = "\u001b[0m";
  const token = "A1b2C3d4E5f6G7h8I9j0K1l2"; // 24 characters; no bare-prefix match.
  const codes = ["\u001b[31m", "\u001b[K", "\u001b[01;31m\u001b[K", "\u001b[1C"];
  const matrix = ["x", "7", "_", "-"].flatMap(before => codes.map(code => ({ before, code })));

  it.each(matrix)("masks only the token after $before and $code", ({ before, code }) => {
    const prefix = `prefix${before}${code}Bearer `;
    expect(redactSensitiveText(`${prefix}${token}${reset} done`))
      .toBe(`${prefix}${REDACTED_EVENT_VALUE}${reset} done`);
  });

  it("masks the real grep Bearer-only highlight after a word, preserving every CSI", () => {
    // LC_ALL=C GREP_COLORS='ms=01;31' grep --color=always 'Bearer .*'
    const prefix = "prefix\u001b[01;31m\u001b[KBearer ";
    const suffix = "\u001b[m\u001b[K\n";
    expect(redactSensitiveText(`${prefix}${token}${suffix}`))
      .toBe(`${prefix}${REDACTED_EVENT_VALUE}${suffix}`);
  });

  it.each(["Bearer", "bearer", "bEaReR", "BEARER"])("matches the uncoloured scheme's case handling: %s", scheme => {
    const prefix = `prefix\u001b[31m${scheme} `;
    expect(redactSensitiveText(`${prefix}${token}${reset}`))
      .toBe(`${prefix}${REDACTED_EVENT_VALUE}${reset}`);
  });

  it.each([
    "a".repeat(20), "a".repeat(19) + "1", "a".repeat(20) + "=",
    "Ab9._~+/-".repeat(3),
    "sk-" + "a".repeat(12), // Below 20 total: still covered by the existing bare-prefix rule.
    "ghp_" + "a".repeat(20), "github_pat_" + "a".repeat(20),
    "AKIA" + "A".repeat(16),
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl",
  ])("masks a strict body or existing JWT/bare-prefix token: %s", body => {
    expect(redactSensitiveText(`prefix\u001b[KBearer ${body}${reset}`))
      .toBe(`prefix\u001b[KBearer ${REDACTED_EVENT_VALUE}${reset}`);
  });

  it.each(codes)("keeps short and prose tails byte-for-byte after %j", code => {
    for (const tail of ["abc123def", "a".repeat(19), "of good news", "authentication", "bond matured", "A", "word.", "Well-known", "", "short-123"]) {
      const input = `standard${code}Bearer ${tail}${reset}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
    const witness = `standard${code}bearer abc123def${reset}`;
    expect(redactSensitiveText(witness)).toBe(witness);
    const prose = `the ${code}bearer of${reset} good news`;
    expect(redactSensitiveText(prose)).toBe(prose);
  });

  it.each([
    ["Bearer\n", token],
    ["minibearer ", token], ["Bearerish ", token],
  ])("does not broaden V2's scheme or cross-line spacing: %j %j", (scheme, body) => {
    const input = `prefix\u001b[31m${scheme}${body}${reset}`;
    expect(redactSensitiveText(input)).toBe(input);
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
  // Keep reason: RFL's two-space, tab and base64-padding credential leaks.
  const grammarForms = [
    { form: "two spaces", separator: "  ", padding: "" },
    { form: "tab", separator: "\t", padding: "" },
    { form: "double padding", separator: " ", padding: "==" },
  ];
  const grammarRows = grammarForms.flatMap(form => ["prefix", ""].flatMap(before =>
    codes.map(code => ({ ...form, before, code }))));

  it.each(grammarRows)("masks RFL $form after $before and $code", ({ separator, padding, before, code }) => {
    for (const body of ["a".repeat(20), token]) {
      const prefix = `${before}${code}bEaReR${separator}`;
      expect(redactSensitiveText(`${prefix}${body}${padding}${reset} done`))
        .toBe(`${prefix}${REDACTED_EVENT_VALUE}${reset} done`);
    }
  });

  it.each(grammarRows)("retains the short-body exception band for $form after $before and $code", ({ separator, padding, before, code }) => {
    const prefix = `${before}${code}Bearer${separator}`;
    const body = "a".repeat(19);
    const input = `${prefix}${body}${padding}${reset}`;
    // V1 already masks short padded tokens at line start. The V2 exception
    // must not undo that mask; a glued prefix leaves this short body untouched.
    const expected = before === "" && padding !== ""
      ? `${prefix}${REDACTED_EVENT_VALUE}${reset}` : input;
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each(codes)("keeps existing short numeric line-start masking after %j", code => {
    for (const { separator, padding } of grammarForms) {
      const prefix = `${code}Bearer${separator}`;
      expect(redactSensitiveText(`${prefix}abc123def${padding}${reset}`))
        .toBe(`${prefix}${REDACTED_EVENT_VALUE}${reset}`);
      const glued = `prefix${prefix}abc123def${padding}${reset}`;
      expect(redactSensitiveText(glued)).toBe(glued);
    }
  });

  it.each(codes)("shares all inline whitespace and unlimited trailing padding with uncoloured Bearer after %j", code => {
    for (const separator of ["   ", "\t\t", " \t "]) {
      for (const padding of ["", "=", "==", "==="]) {
        const prefix = `prefix${code}Bearer${separator}`;
        expect(redactSensitiveText(`${prefix}${token}${padding}${reset}`))
          .toBe(`${prefix}${REDACTED_EVENT_VALUE}${reset}`);
      }
    }
    for (const separator of ["\r", "\n", "\v", "\f", "\u00a0"]) {
      const input = `prefix${code}Bearer${separator}${token}${reset}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
  });

  it("keeps the exact short-token witness and responsibilities prose byte-identical", () => {
    for (const input of [
      "standard\u001b[31mbearer abc123def\u001b[0m",
      "bearer of the responsibilities",
      ...codes.map(code => `standard${code}bearer of the responsibilities${reset}`),
    ]) expect(redactSensitiveText(input)).toBe(input);
  });

  const anchorBody = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"; // 32 characters; no bare-prefix match.
  it.each([
    // CSI after the separator leaves prefixBearer glued in both views.
    `prefixBearer \u001b[31m${anchorBody}${reset}`,
    // CSI before the separator also leaves prefixBearer glued in both views.
    `prefixBearer\u001b[31m ${anchorBody}`,
  ])("preserves a glued Bearer with CSI after the scheme: %j", input => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("does not let CSI after Bearer create its only separator on V2", () => {
    // V1 sees Bearer glued to the body; V2 has a word boundary but no preceding CSI.
    const input = `prefix Bearer\u001b[31m${anchorBody}${reset}`;
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("requires CSI immediately before the scheme, not merely earlier on the line", () => {
    for (const input of [
      `\u001b[31mprefixBearer ${token}${reset}`,
      `prefix\u001b[31mxBearer ${token}${reset}`,
      `prefixBearer ${token}\u001b[31m${reset}`,
    ]) expect(redactSensitiveText(input)).toBe(input);
  });

  it("retains transparent Authorization and Bearer-prefix/body recognition", () => {
    expect(redactSensitiveText(`Authorization:\u001b[31m Bearer\u001b[K ${token}${reset}`))
      .toBe(`Authorization:\u001b[31m ${REDACTED_EVENT_VALUE}${reset}`);
    const bareToken = "sk-" + "a".repeat(12);
    expect(redactSensitiveText(`Bearer\u001b[31m${bareToken}${reset}`))
      .toBe(`Bearer\u001b[31m${REDACTED_EVENT_VALUE}${reset}`);
    expect(redactSensitiveText(`Bearer \u001b[31m${token}${reset}`))
      .toBe(`Bearer \u001b[31m${REDACTED_EVENT_VALUE}${reset}`);
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
// Keep reason: never disclose credentials through terminal controls or OSC URLs.
describe("ECMA-48 credential views beyond 7-bit CSI", () => {
  const body = "rf2SyntheticOnly0123456789ABCDEF";
  const shapes = [
    ["sk-proj-", "sk-proj-", body],
    ["sk-ant-", "sk-ant-", body],
    ["ghp_", "ghp_", body],
    ["github_pat_", "github_pat_", body],
    ["AKIA", "AKIA", "RF2SYNTH01234567"],
    ["JWT", "eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl"],
    ["Bearer", "Bearer ", body],
  ] as const;
  const escapes = [
    ["CSI7", "\u001b[31m", "\u001b[0m"],
    ["CSI8", "\u009b31m", "\u009b0m"],
    ["tput sgr0", "\u001b(B\u001b[m", "\u001b(B\u001b[m"],
    ["nF", "\u001b(B", "\u001b(B"],
    ["nF multi-intermediate", "\u001b( B", "\u001b(B"],
    ["Fp save", "\u001b7", "\u001b8"],
    ["Fp restore", "\u001b8", "\u001b7"],
    ["Fe", "\u001bM", "\u001bM"],
    ["Fs", "\u001bc", "\u001bc"],
    ["OSC BEL", "\u001b]8;;https://docs.example/guide\u0007", "\u001b]8;;\u0007"],
    ["OSC ST", "\u001b]8;;https://docs.example/guide\u001b\\", "\u001b]8;;\u001b\\"],
  ] as const;
  const rows = escapes.flatMap(([kind, open, close]) => shapes.flatMap(([shape, prefix, tail]) => {
    const masked = prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
    const key = prefix + tail;
    return [
      { kind, shape, position: "inside after prefix", input: `${prefix}${open}${tail}${close}`,
        expected: `${prefix === "Bearer " ? `Bearer ${open}${REDACTED_EVENT_VALUE}` : masked}${close}` },
      { kind, shape, position: "word+escape+key", input: `task${open}${key}${close}`,
        // Supersedes the non-CSI follow-up's glued-Bearer negative: an
        // immediate recognized escape now admits the same strict V2 body.
        expected: `task${open}${masked}${close}` },
      { kind, shape, position: "around key", input: `log ${open}${key}${close} done`, expected: `log ${open}${masked}${close} done` },
      { kind, shape, position: "line start", input: `${open}${key}`, expected: `${open}${masked}` },
      { kind, shape, position: "inside body", input: `${open}${prefix}${tail.slice(0, 3)}${open}${tail.slice(3)}${close}`,
        expected: `${open}${masked}${close}` },
    ];
  }));
  it.each(rows)("$kind / $shape / $position", ({ input, expected }) => {
    // Exact equality proves the whole original span is removed, including all
    // internal escape bytes, while external control bytes remain untouched.
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each(shapes)("masks %s after a lone ESC, including after a word", (_shape, prefix, tail) => {
    const masked = prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
    expect(redactSensitiveText(`\u001b${prefix}${tail}`)).toBe(`\u001b${masked}`);
    if (prefix !== "Bearer ") {
      expect(redactSensitiveText(`task\u001b${prefix}${tail}`)).toBe(`task\u001b${masked}`);
    }
  });

  it.each(["\u0007", "\u001b\\"])("masks existing shapes in original OSC URLs terminated by %j", terminator => {
    for (const [_shape, prefix, tail] of shapes) {
      const value = prefix + tail;
      const masked = prefix === "Bearer " ? `Bearer ${REDACTED_EVENT_VALUE}` : REDACTED_EVENT_VALUE;
      const input = `\u001b]8;;https://docs.example/?q=${value}${terminator}guide\u001b]8;;${terminator}`;
      expect(redactSensitiveText(input)).toBe(`\u001b]8;;https://docs.example/?q=${masked}${terminator}guide\u001b]8;;${terminator}`);
    }
    expect(redactSensitiveText(`\u001b]8;;https://docs.example/?token=sk-proj-${body}${terminator}guide\u001b]8;;${terminator}`))
      .toBe(`\u001b]8;;https://docs.example/?token=${REDACTED_EVENT_VALUE}${terminator}guide\u001b]8;;${terminator}`);
  });

  it.each(escapes)("%s leaves ordinary output and short tails byte-equal", (_kind, open, close) => {
    for (const text of ["completed work", "the bearer of good news", "Use bearer authentication here", "sk-proj-123", "sk-ant-1234", "ghp_123", "github_pat_123", "AKIA12", "eyJ123"]) {
      const input = `log ${open}${text}${close} done`;
      expect(redactSensitiveText(input)).toBe(input);
    }
    expect(redactSensitiveText(`standard${open}bearer abc123def${close}`))
      .toBe(`standard${open}bearer abc123def${close}`);
  });

  it.each(["\u0007", "\u001b\\"])("does not treat an OSC 8 URL as a credential by itself (%j)", terminator => {
    for (const url of ["https://docs.example/guide", "https://docs.example/very_long_documentation_reference_0123456789", "https://docs.example/?q=ordinary-prose"]) {
      const input = `\u001b]8;;${url}${terminator}ordinary prose\u001b]8;;${terminator}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
  });

  it("keeps unterminated OSC as text through the line, rather than stripping its introducer", () => {
    const text = "\u001b]8;;https://docs.example/unfinished";
    expect(redactSensitiveText(text)).toBe(text);
    // Even an apparent terminator on a later line must not erase the first line.
    const acrossLine = `sk-proj-\u001b]8;;unfinished\n${body}\u001b\\`;
    expect(redactSensitiveText(acrossLine)).toBe(acrossLine);
    for (const newline of ["\n", "\r", "\r\n"]) {
      const input = `${text}${newline}\u009b31msk-proj-${body}\u009b0m`;
      expect(redactSensitiveText(input)).toBe(`${text}${newline}\u009b31m${REDACTED_EVENT_VALUE}\u009b0m`);
    }
    expect(redactSensitiveText(`\u001b]8;;https://docs.example/?token=sk-proj-${body}`))
      .toBe(`\u001b]8;;https://docs.example/?token=${REDACTED_EVENT_VALUE}`);
  });

  it("accepts ESC bytes in OSC payloads that are not ST without leaking payload keys", () => {
    const input = `\u001b]8;;https://docs.example/a\u001b7?q=sk-proj-${body}\u001b\\guide\u001b]8;;\u001b\\`;
    expect(redactSensitiveText(input))
      .toBe(`\u001b]8;;https://docs.example/a\u001b7?q=${REDACTED_EVENT_VALUE}\u001b\\guide\u001b]8;;\u001b\\`);
  });

  it("unions original URL, transparent-key and boundary-key spans in one diagnostic", () => {
    const open = `\u001b]8;;https://docs.example/?token=sk-proj-${body}\u001b\\`;
    const close = "\u001b]8;;\u001b\\";
    expect(redactSensitiveText(`🙂 ${open}sk-proj-${body.slice(0, 8)}\u001b(B${body.slice(8)}${close} task\u009b31mgithub_pat_${body}\u009b0m`))
      .toBe(`🙂 \u001b]8;;https://docs.example/?token=${REDACTED_EVENT_VALUE}\u001b\\${REDACTED_EVENT_VALUE}${close} task\u009b31m${REDACTED_EVENT_VALUE}\u009b0m`);
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21230
// Keep reason: never disclose credentials at terminal boundaries, without
// promoting short non-keys or changing the whole-line V1 prose policy.
describe("strict V2 Bearer after any immediate recognized terminal escape", () => {
  const token = "0123456789".repeat(5);
  const controls = [
    ["CSI7", "\u001b[31m", "\u001b[0m"],
    ["CSI8", "\u009b31m", "\u009b0m"],
    ["tput sgr0", "\u001b(B\u001b[m", "\u001b(B\u001b[m"],
    ["nF", "\u001b(B", "\u001b(B"],
    ["nF multi-intermediate", "\u001b( B", "\u001b(B"],
    ["Fp save", "\u001b7", "\u001b8"],
    ["Fp restore", "\u001b8", "\u001b7"],
    ["Fe", "\u001bM", "\u001bM"],
    ["Fs", "\u001bc", "\u001bc"],
    ["OSC BEL", "\u001b]8;;https://docs.example/guide\u0007", "\u001b]8;;\u0007"],
    ["OSC ST", "\u001b]8;;https://docs.example/guide\u001b\\", "\u001b]8;;\u001b\\"],
    ["stray ESC before scheme", "\u001b", "\u001b[0m"],
  ] as const;
  const positions = [
    ["word boundary", "prefix", ""],
    ["line start", "", ""],
    ["wrapped", "log ", " done"],
  ] as const;
  const rows = controls.flatMap(([kind, open, close]) => positions.map(([position, before, after]) => ({
    kind, position, prefix: `${before}${open}Bearer `, suffix: `${close}${after}`,
  })));
  it.each(rows)("$kind / $position masks the complete 50-character body", ({ prefix, suffix }) => {
    expect(redactSensitiveText(`${prefix}${token}${suffix}`))
      .toBe(`${prefix}${REDACTED_EVENT_VALUE}${suffix}`);
  });

  it.each(controls)("%s preserves the strict body's threshold, charset, JWT and bare-prefix rules", (_kind, open, close) => {
    for (const body of [
      "a".repeat(20), "a".repeat(19) + "1", "a".repeat(20) + "=", "Ab9._~+/-".repeat(3),
      "sk-" + "a".repeat(12), "ghp_" + "a".repeat(20), "github_pat_" + "a".repeat(20),
      "AKIA" + "A".repeat(16),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl",
    ]) {
      expect(redactSensitiveText(`prefix${open}Bearer ${body}${close}`))
        .toBe(`prefix${open}Bearer ${REDACTED_EVENT_VALUE}${close}`);
    }
  });

  it.each(controls)("%s does not promote short bodies or prose at the V2 boundary", (_kind, open, close) => {
    for (const body of ["abc123def", "a".repeat(19), "of good news", "authentication", "bond matured", "A", "word.", "Well-known", "", "short-123"]) {
      const input = `standard${open}bearer ${body}${close}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
  });

  // Supersedes the earlier single-space/single-padding exclusions while
  // retaining those exact inputs: bv3 shares the uncoloured inline grammar.
  const grammarRows = controls.flatMap(([kind, open, close]) => [
    { form: "two spaces", separator: "  ", body: token },
    { form: "TAB", separator: "\t", body: token },
    { form: "double padding", separator: " ", body: "a".repeat(20) + "==" },
  ].map(form => ({ kind, open, close, ...form })));
  it.each(grammarRows)("$kind masks bv3 $form at the immediate escape boundary", ({ open, close, separator, body }) => {
    expect(redactSensitiveText(`prefix${open}Bearer${separator}${body}${close}`))
      .toBe(`prefix${open}Bearer${separator}${REDACTED_EVENT_VALUE}${close}`);
  });

  it.each(controls)("%s does not relax V2 newline or scheme exclusions", (_kind, open, close) => {
    for (const [scheme, body] of [
      ["Bearer\n", token], ["minibearer ", token], ["Bearerish ", token],
    ]) {
      const input = `prefix${open}${scheme}${body}${close}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
  });

  it.each(controls)("%s requires an escape immediately before Bearer, not elsewhere", (_kind, open, close) => {
    for (const input of [
      `${open}prefixBearer ${token}${close}`,
      `prefix${open}xxBearer ${token}${close}`,
      `prefixBearer ${token}${open}${close}`,
      `prefix${open} Bearer ${token}${close}`,
    ]) {
      // A complete control followed by whitespace retains a real V1 word
      // boundary. Raw ESC + space + B is instead one nF control, so it must
      // not be misreported as a standalone ESC before a complete scheme.
      const expected = _kind !== "stray ESC before scheme" && input === `prefix${open} Bearer ${token}${close}`
        ? `prefix${open} Bearer ${REDACTED_EVENT_VALUE}${close}` : input;
      expect(redactSensitiveText(input)).toBe(expected);
    }
  });
});

// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21257
// Keep reason: never disclose a key when a terminal control is both an edge
// before the key and transparent inside its body. Unit test agreed: exported
// pure-function secret-redaction guard; the independent RFL rows supplied REDs.
describe("escape edges and transparent interiors in the same credential span", () => {
  const controls = [
    ["CSI7", "\u001b[31m", "\u001b[0m"],
    ["CSI8", "\u009b31m", "\u009b0m"],
    ["tput sgr0", "\u001b(B\u001b[m", "\u001b(B\u001b[m"],
    ["nF", "\u001b(B", "\u001b(B"],
    ["nF multi-intermediate", "\u001b( B", "\u001b(B"],
    ["Fp save", "\u001b7", "\u001b8"],
    ["Fp restore", "\u001b8", "\u001b7"],
    ["Fe", "\u001bM", "\u001bM"],
    ["Fs", "\u001bc", "\u001bc"],
    ["OSC BEL", "\u001b]8;;https://docs.example/guide\u0007", "\u001b]8;;\u0007"],
    ["OSC ST", "\u001b]8;;https://docs.example/guide\u001b\\", "\u001b]8;;\u001b\\"],
  ] as const;
  const body = "AbCdEf0123456789AbCdEf0123456789";
  const shapes = [
    ["sk-proj-", "sk-proj-", body],
    ["sk-ant-", "sk-ant-", body],
    ["ghp_", "ghp_", body],
    ["github_pat_", "github_pat_", body],
    ["AKIA", "AKIA", "RF2SYNTH01234567"],
    ["JWT", "eyJ", "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZjJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl"],
    ["Bearer", "Bearer ", body],
  ] as const;
  const residuals = [
    ["R1 CSI/nF", `prefix\u001b[31msk-proj-AbCdEf0123\u001b(B456789AbCdEf0123456789\u001b[0m`, `prefix\u001b[31m${REDACTED_EVENT_VALUE}\u001b[0m`],
    ["R1 nF/nF", `prefix\u001b(Bsk-proj-AbCdEf0123\u001b(B456789AbCdEf0123456789\u001b(B`, `prefix\u001b(B${REDACTED_EVENT_VALUE}\u001b(B`],
    ["R1 CSI/CSI", `prefix\u001b[31msk-proj-AbCdEf0123\u001b[0m456789AbCdEf0123456789\u001b[0m`, `prefix\u001b[31m${REDACTED_EVENT_VALUE}\u001b[0m`],
    ["R1 early split", `prefix\u001b(Bsk-proj-A\u001b(BbCdEf0123456789AbCdEf0123456789\u001b(B`, `prefix\u001b(B${REDACTED_EVENT_VALUE}\u001b(B`],
    ["R2 OSC BEL", `prefix\u001b(Bsk-proj-AbCdEf0123\u001b]8;;https://docs.example/guide\u0007456789AbCdEf0123456789\u001b]8;;\u0007`, `prefix\u001b(B${REDACTED_EVENT_VALUE}\u001b]8;;\u0007`],
    ["R2 OSC ST", `prefix\u001b(Bsk-proj-AbCdEf0123\u001b]8;;https://docs.example/guide\u001b\\456789AbCdEf0123456789\u001b]8;;\u001b\\`, `prefix\u001b(B${REDACTED_EVENT_VALUE}\u001b]8;;\u001b\\`],
    ["R3 CSI8", `prefix\u009b31msk-proj-AbCdEf0123\u009b0m456789AbCdEf0123456789\u009b0m`, `prefix\u009b31m${REDACTED_EVENT_VALUE}\u009b0m`],
    ["grep partial match", `prefix\u001b[01;31m\u001b[Ksk-proj-AbCdEf0123\u001b[m\u001b[K456789AbCdEf0123456789`, `prefix\u001b[01;31m\u001b[K${REDACTED_EVENT_VALUE}`],
  ] as const;
  it.each(residuals)("%s removes the entire key and only interior controls", (_name, input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  const rows = controls.flatMap(([kind, open, close]) => shapes.flatMap(([shape, prefix, tail]) =>
    [1, Math.min(10, tail.length - 1), tail.length - 1].map(split => ({
      kind, shape, split,
      input: `prefix${open}${prefix}${tail.slice(0, split)}${open}${tail.slice(split)}${close}`,
      expected: `prefix${open}${prefix === "Bearer " ? prefix : ""}${REDACTED_EVENT_VALUE}${close}`,
    }))));
  it.each(rows)("$kind / $shape / interior split $split with a glued word", ({ input, expected }) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });

  it.each(controls)("%s keeps the same body thresholds and trailing word rules", (_kind, open, close) => {
    for (const key of ["sk-1", "sk-" + "a".repeat(11), "ghp_" + "a".repeat(19),
      "github_pat_" + "a".repeat(19), "AKIA" + "A".repeat(15), "AKIA" + "A".repeat(17),
      "AKIA" + "a".repeat(16), "eyJnot.a.jwt", "Bearer " + "a".repeat(19)]) {
      const split = Math.min(10, key.length - 1);
      const input = `task${open}${key.slice(0, split)}${open}${key.slice(split)}${close}`;
      expect(redactSensitiveText(input)).toBe(input);
    }
    const witness = `standard${open}bearer abc123def${close}`;
    expect(redactSensitiveText(witness)).toBe(witness);
  });

  it.each(controls)("%s keeps padding and inline separators for a split Bearer body", (_kind, open, close) => {
    for (const separator of [" ", "  ", "\t"]) {
      const input = `prefix${open}Bearer${separator}AbCdEf${open}0123456789AbCdEf0123456789==${close}`;
      expect(redactSensitiveText(input)).toBe(`prefix${open}Bearer${separator}${REDACTED_EVENT_VALUE}${close}`);
    }
  });

  it.each(["gho_", "ghu_", "ghs_", "ghr_"])("%s shares the span construction", prefix => {
    expect(redactSensitiveText(`word\u001b(B${prefix}Ab\u001b[0m${body}\u001b[0m`))
      .toBe(`word\u001b(B${REDACTED_EVENT_VALUE}\u001b[0m`);
  });

  it("retains the old boundary-view match when a control ends a fixed-length token", () => {
    // The following A makes the transparent AWS shape overlong, but the
    // control is still a valid edge after exactly 16 uppercase body bytes.
    expect(redactSensitiveText(`prefix\u001b(BAKIA${"A".repeat(16)}\u001b(BA\u001b(B`))
      .toBe(`prefix\u001b(B${REDACTED_EVENT_VALUE}\u001b(BA\u001b(B`);
    expect(redactSensitiveText(`prefix\u001b(BBearer ${"a".repeat(20)}=\u001b(BA\u001b(B`))
      .toBe(`prefix\u001b(BBearer ${REDACTED_EVENT_VALUE}\u001b(BA\u001b(B`);
  });

  it("uses only an immediate escape as the additional start, not one earlier on the line", () => {
    for (const input of [`prefixsk-proj-${body}`, `\u001b(Bprefixsk-proj-${body}\u001b(B`,
      `prefix\u001b(Bxxsk-proj-${body}\u001b(B`, `prefix\u001b(BxxBearer ${body}\u001b(B`]) {
      expect(redactSensitiveText(input)).toBe(input);
    }
    expect(redactSensitiveText(`word\u001bsk-proj-Ab\u001b(B${body}\u001b(B`))
      .toBe(`word\u001b${REDACTED_EVENT_VALUE}\u001b(B`);
  });
});
