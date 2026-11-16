import { describe, expect, it } from "vitest";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { canonicalNativeRunLogRedactionForms, redactCanonicalNativeRunLogChunk } from "../services/heartbeat/run-log.js";
import { redactRegisteredSecretValues } from "../services/run-secret-redaction.js";
import { agentIdentityRedactionVectors } from "./fixtures/agent-identity-redaction-vectors.js";

// Data-safety regression: transformed identity output escaped the real run log (#20832).
describe("identity material and PEM structure", () => {
  const fixture = agentIdentityRedactionVectors();
  const unrelated = fixture.precision[0]!;
  const unknownBody = "z".repeat(80);

  function assertHidden(output: string) {
    for (const window of fixture.windows) expect(output).not.toContain(window);
    expect(output).not.toMatch(/-----BEGIN[^\r\n]*PRIVATE KEY-----|-----END[^\r\n]*PRIVATE KEY-----/);
  }

  it.each(fixture.vectors)("redacts complete $name values recursively", ({ chunks }) => {
    const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
    const date = new Date("2026-01-01Z");
    const result = redactor.redact({ date, nested: [chunks.join("")] });
    expect(result.date).toBe(date);
    assertHidden(result.nested[0]!);
    expect(redactor.redact(unrelated)).toBe(unrelated);
  });

  it("redacts unknown material in PEM context and closes context at END", () => {
    const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
      const text = `-----BEGIN ${label}-----\n${unknownBody}\n-----END ${label}-----\n${unrelated}\n`;
      const output = redactor.chunk(label, text) + redactor.finish(label);
      expect(output).not.toContain(unknownBody);
      expect(output).not.toContain("PRIVATE KEY-----");
      expect(output).toContain(unrelated);
    }
  });

  it("tracks known body context through chunks without contaminating another stream", () => {
    const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
    let output = redactor.chunk("stdout", fixture.body.slice(9, 49) + "\n");
    output += redactor.chunk("stdout", unknownBody.slice(0, 23));
    expect(redactor.chunk("stderr", unrelated + "\n")).toBe(unrelated + "\n");
    output += redactor.chunk("stdout", unknownBody.slice(23) + "\n-----END PRIVATE KEY-----\n");
    output += redactor.chunk("stdout", unrelated + "\n");
    output += redactor.finish("stdout");
    expect(output).not.toContain(unknownBody);
    assertHidden(output);
    expect(output).toContain(unrelated);
  });

  it("redacts marker and material splits at every boundary", () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${unknownBody}\n-----END RSA PRIVATE KEY-----\n`;
    for (let split = 1; split < text.length; split++) {
      const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
      const output = redactor.chunk("out", text.slice(0, split)) + redactor.chunk("out", text.slice(split)) + redactor.finish("out");
      expect(output, `split ${split}`).not.toContain(unknownBody);
      assertHidden(output);
    }
  });

  it("matches key-body windows supplied by the existing mutable values API", () => {
    const redactor = createAgentIdentityRedactor();
    redactor.values.push(...createAgentIdentityRedactor(fixture.privateKeyPem).values);
    const output = redactor.redact(fixture.body.slice(13, 77));
    assertHidden(output);
    expect(output).toContain("REDACTED");
  });

  it("keeps safe exact-PEM archive projections verifiable after an upgrade", () => {
    const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
    const source = JSON.stringify({ type: "paperclip.prp.event", event: {
      payload: { text: `prefix\n${fixture.privateKeyPem}\nsuffix` },
    } });
    const currentUser = { enabled: false };
    const archived = redactCanonicalNativeRunLogChunk(source, {
      currentUser, redactIdentity: value => redactRegisteredSecretValues(value, redactor.values),
    });
    expect([...canonicalNativeRunLogRedactionForms(source, { currentUser, redactIdentity: redactor.redact })]).toContain(archived);
  });

  it("matches bare transformed key material at every chunk boundary", () => {
    const text = fixture.body.slice(9, 89);
    for (let split = 1; split < text.length; split++) {
      const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
      const output = redactor.chunk("out", text.slice(0, split)) + redactor.chunk("out", text.slice(split)) + redactor.finish("out");
      assertHidden(output);
    }
  });

  it("uses the structural 40-character threshold even without a configured key", () => {
    const redactor = createAgentIdentityRedactor();
    const text = `-----BEGIN PRIVATE KEY-----\n${"z".repeat(39)}\n${"y".repeat(40)}\n-----END PRIVATE KEY-----\n${unrelated}\n`;
    const output = redactor.chunk("out", text) + redactor.finish("out");
    expect(output).toContain("z".repeat(39));
    expect(output).not.toContain("y".repeat(40));
    expect(output).not.toContain("PRIVATE KEY-----");
    expect(output).toContain(unrelated);
  });

  it("does not mask unrelated base64 outside any identity context", () => {
    const redactor = createAgentIdentityRedactor(fixture.privateKeyPem);
    for (const text of fixture.precision) {
      expect(text).toHaveLength(44);
      expect(redactor.redact(text)).toBe(text);
      const output = redactor.chunk("precision", text.slice(0, 19)) + redactor.chunk("precision", text.slice(19) + "\n") + redactor.finish("precision");
      expect(output).toBe(text + "\n");
    }
  });
});
