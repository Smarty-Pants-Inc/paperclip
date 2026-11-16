import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addRunSecretMaterial, createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";
import { canonicalNativeRunLogRedactionForms, redactCanonicalNativeRunLogChunk } from "../services/heartbeat/run-log.js";
import { redactRegisteredSecretValues } from "../services/run-secret-redaction.js";
import { agentIdentityRedactionVectors, pemBodyWindows, pemTransformForms } from "./fixtures/agent-identity-redaction-vectors.js";

// Fixed budget for 1 MB of streamed output; measured well below this on a
// shared CI-class host. Do not raise it to hide a quadratic path.
const PERF_BUDGET_MS = 3_000;

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

// Gate 5 row 5.5 (M2h3 490ed240, run fd281998): a FAKE PEM bound as a run
// secret leaked through fold/cut/tr/json transforms, and a fold split the END
// marker. Each key here is a throwaway generated in the test.
describe("run-secret and identity PEMs printed through shell transforms", () => {
  const identity = agentIdentityRedactionVectors();
  const runSecretPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const keys = [
    { name: "run secret", pem: runSecretPem, windows: pemBodyWindows(runSecretPem) },
    { name: "agent identity", pem: identity.privateKeyPem, windows: identity.windows },
  ];
  // The run secret enters through the same appendable values API that live
  // preparation and native log recovery use for a run's secrets.
  const redactorWithRunSecret = () => {
    const redactor = createAgentIdentityRedactor(identity.privateKeyPem);
    redactor.values.push(...createAgentIdentityRedactor(runSecretPem).values);
    redactor.values.sort((left, right) => right.length - left.length);
    return redactor;
  };
  function assertNoKeyText(output: string, windows: string[]) {
    // Whitespace cannot hide a window: the gate measured the joined output.
    const compact = output.replace(/\s+/g, "");
    const leaked = windows.filter(window => compact.includes(window));
    expect(leaked.length, `${leaked.length}/${windows.length} key-body windows survived`).toBe(0);
    expect(output.replace(/\r?\n/g, "")).not.toMatch(/(?:BEGIN|END)[A-Z ]*PRIVATE KEY/);
  }
  const cases = keys.flatMap(key => pemTransformForms(key.pem).map(form => ({ key: key.name, form: form.name, text: form.text, windows: key.windows })));

  it.each(cases)("hides the $key through $form as one value and as a stream", ({ text, windows }) => {
    const redactor = redactorWithRunSecret();
    assertNoKeyText(redactor.redact(text), windows);
    let streamed = "";
    for (let index = 0; index < text.length; index += 7) streamed += redactor.chunk("stdout", text.slice(index, index + 7));
    assertNoKeyText(streamed + redactor.finish("stdout"), windows);
  });

  it("hides a folded run secret at every chunk boundary", () => {
    const text = pemTransformForms(runSecretPem).find(form => form.name === "fold -w 20")!.text;
    const redactor = redactorWithRunSecret();
    for (let split = 1; split < text.length; split++) {
      const stream = `split-${split}`;
      const output = redactor.chunk(stream, text.slice(0, split)) + redactor.chunk(stream, text.slice(split)) + redactor.finish(stream);
      assertNoKeyText(output, keys[0]!.windows);
    }
  });

  it("leaves ordinary base64, hash lists and diffs untouched", () => {
    const blob = randomBytes(1536).toString("base64");
    const sums = Array.from({ length: 24 }, (_, index) =>
      `${createHash("sha256").update(`file-${index}`).digest("hex")}  src/file-${index}.ts`).join("\n") + "\n";
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts", "index 3b18e51..a4f2c9d 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@", "-const token = readToken();", "+const token = await readToken();",
      `+const fixture = "${randomBytes(48).toString("base64")}";`, " export default token;", "",
    ].join("\n");
    const redactor = redactorWithRunSecret();
    for (const text of [blob, blob.match(/.{1,76}/g)!.join("\n") + "\n", blob.match(/.{1,20}/g)!.join("\n"), sums, diff]) {
      expect(redactor.redact(text)).toBe(text);
      let streamed = "";
      for (let index = 0; index < text.length; index += 13) streamed += redactor.chunk("guard", text.slice(index, index + 13));
      expect(streamed + redactor.finish("guard")).toBe(text);
    }
  });

  it("streams 1 MB of mixed output in linear time", () => {
    const redactor = redactorWithRunSecret();
    const lines: string[] = [];
    let size = 0;
    for (let index = 0; size < 1024 * 1024; index++) {
      const line = index % 3 === 0 ? randomBytes(57).toString("base64")
        : index % 3 === 1 ? `${createHash("sha256").update(String(index)).digest("hex")}  file-${index}`
          : `step ${index}: wrote ${index * 7} bytes to out/${index}.bin`;
      lines.push(line);
      size += line.length + 1;
    }
    const text = lines.join("\n") + "\n";
    const started = performance.now();
    let output = "";
    for (let index = 0; index < text.length; index += 4096) output += redactor.chunk("bulk", text.slice(index, index + 4096));
    output += redactor.finish("bulk");
    const elapsed = performance.now() - started;
    expect(output).toBe(text);
    expect(elapsed, `1 MB took ${Math.round(elapsed)} ms`).toBeLessThan(PERF_BUDGET_MS);
  });
});

// Integrity: a run secret indexes ordinary text only when it can be told
// apart from it; short values and identifiers never mask stored log text.
describe("run secret material: short values and identifiers keep ordinary text byte-equal (redact-meta)", () => {
  const stream = (redactor: ReturnType<typeof createAgentIdentityRedactor>, text: string) => {
    let output = "";
    for (let index = 0; index < text.length; index += 7) output += redactor.chunk("stdout", text.slice(index, index + 7));
    return output + redactor.finish("stdout");
  };
  const agentId = "7f3c2a10-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
  const ordinary = `test 1 passed in v1.2.3 (11 files)\nagent ${agentId} on api.internal.example.com in us-east-1\n`;

  it("(5) a short env secret leaves an ordinary log line byte-equal", () => {
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, ["1", "v1", "abc1234"]);
    expect(stream(redactor, ordinary)).toBe(ordinary);
    expect(redactor.redact(ordinary)).toBe(ordinary);
  });

  it("(6) a long secret in the same run is still masked in the log and in events", () => {
    const secret = randomBytes(30).toString("base64");
    const eight = "Zq8#rT2!";
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, ["1", "v1", agentId, secret, eight]);
    const text = `${ordinary}token=${secret}\npass=${eight}\n`;
    for (const output of [stream(redactor, text), redactor.redact(text), JSON.stringify(redactor.redact({ text }))]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(eight);
      expect(output).toContain(ordinary.trimEnd().replace(/\n/g, output.startsWith("{") ? "\\n" : "\n"));
    }
  });

  it("(8) an identifier-valued secret (UUID, a known id, a host name, a region) is not indexed and stays visible", () => {
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [agentId, agentId.toUpperCase(), "api.internal.example.com", "us-east-1", "europe-west4", "env-prod-blue"],
      ["env-prod-blue"]);
    expect(redactor.values).toEqual([]);
    const text = `${ordinary}environment env-prod-blue\n`;
    expect(stream(redactor, text)).toBe(text);
    expect(redactor.redact({ text })).toEqual({ text });
  });

  it("(8) the identifier guard never drops secret-shaped values", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [jwt, "sk-live-abcdef0123456789", "postgres://u:p4ss@db.example.com/x"]);
    for (const value of [jwt, "sk-live-abcdef0123456789", "postgres://u:p4ss@db.example.com/x"]) {
      expect(redactor.redact(`x ${value} y`)).not.toContain(value);
    }
  });
});

// A guard must never unmask a real credential: many API keys are bare UUIDs,
// host- or region-shaped. Only a value EQUAL to one of the run's own ids is left
// unindexed; an all-digit secret masks only where it stands as a whole number.
describe("run secret material: only the run's own ids are skipped (redact-meta4)", () => {
  const stream = (redactor: ReturnType<typeof createAgentIdentityRedactor>, text: string, size = 7) => {
    let output = "";
    for (let index = 0; index < text.length; index += size) output += redactor.chunk("stdout", text.slice(index, index + size));
    return output + redactor.finish("stdout");
  };
  const agentId = "7f3c2a10-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
  const runId = "0d6e9b52-31aa-4c1f-9e2d-5b7c8a9f0e1d";

  it("(1) a UUID-shaped secret that is not a known id is masked in output", () => {
    const uuidKey = "c3a1f0e2-9b8d-4c7e-a6f5-1d2e3f4a5b6c"; // test-only, shaped like many API keys
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [uuidKey, uuidKey.toUpperCase()], [agentId, runId]);
    const text = `agent ${agentId} run ${runId}\nkey ${uuidKey}\nKEY ${uuidKey.toUpperCase()}\n`;
    for (const output of [stream(redactor, text), stream(redactor, text, 1), redactor.redact(text), JSON.stringify(redactor.redact({ text }))]) {
      expect(output).not.toContain(uuidKey);
      expect(output).not.toContain(uuidKey.toUpperCase());
      expect(output).toContain(`agent ${agentId} run ${runId}`);
    }
  });

  it("(1) an id-valued secret equal to the agent's id is not indexed and output keeps it", () => {
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [agentId, ` ${runId}\n`], [agentId, runId, null, undefined]);
    expect(redactor.values).toEqual([]);
    const text = `agent ${agentId} run ${runId}\n`;
    expect(stream(redactor, text)).toBe(text);
    expect(redactor.redact({ text })).toEqual({ text });
  });

  it("(1) host- and region-shaped secrets that are not known values are masked", () => {
    const host = "k7q2-tenant.vault-proxy.example.net";
    const region = "us-west-2";
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [host, region], [agentId, "api.internal.example.com", "eu-central-1"]);
    const text = `connect ${host} in ${region}; public api.internal.example.com in eu-central-1\n`;
    for (const output of [stream(redactor, text), redactor.redact(text)]) {
      expect(output).not.toContain(host);
      expect(output).not.toContain(region);
      expect(output).toContain("public api.internal.example.com in eu-central-1");
    }
  });

  it("(2) a 9-digit secret is masked as a whole number; ordinary numbers, and longer numbers containing it, stay intact", () => {
    const pin = "482916375";
    const redactor = createAgentIdentityRedactor();
    addRunSecretMaterial(redactor, [pin], [agentId]);
    const ordinary = `took 1763297669123 ms; id 1${pin}0 and ${pin}7; 4829163 files; count 12345678\n`;
    const text = `${ordinary}account=${pin}\n${pin}`;
    for (const output of [stream(redactor, text), stream(redactor, text, 1), stream(redactor, text, 9), redactor.redact(text)]) {
      expect(output.startsWith(ordinary)).toBe(true);
      expect(output.slice(ordinary.length)).toBe("account=***REDACTED***\n***REDACTED***");
    }
    expect(stream(redactor, ordinary)).toBe(ordinary);
    expect(redactRegisteredSecretValues({ ordinary, text: `pin ${pin}.` }, [pin])).toEqual({ ordinary, text: "pin ***REDACTED***." });
  });
});
