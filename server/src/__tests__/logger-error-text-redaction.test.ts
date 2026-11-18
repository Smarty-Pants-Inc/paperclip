import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { baseLoggerOptions, createHttpLogger, maskSerializedLogLine } from "../middleware/logger.js";
import { errorHandler } from "../middleware/error-handler.js";
import { redactSensitiveText } from "../redaction.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk0";
const SECRETS = {
  openai: "sk-live-abcdefghijklmnopqrstuvwx",
  github: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  jwt: JWT,
  aws: "AKIAIOSFODNN7EXAMPLE",
};
const ALL = Object.values(SECRETS);

function capture() {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  // The production logger options, exactly as server/src/middleware/logger.ts builds them.
  return { log: pino({ ...baseLoggerOptions, level: "debug" }, stream), output: () => chunks.join("") };
}

describe("error text in logs", () => {
  it("masks credentials in err.message, err.stack, err.cause and enumerable extras, keeping the text", () => {
    const { log, output } = capture();
    const cause = new Error(`ssh exited 255: Authorization denied for ${SECRETS.github}`);
    const error = new Error(`provider call failed with key ${SECRETS.openai} and token ${SECRETS.jwt}`, { cause });
    (error as Error & { stderr?: string }).stderr = `aws: ${SECRETS.aws} rejected`;
    error.stack = `Error: provider call failed (${SECRETS.aws})\n    at callProvider (provider.ts:10:5)`;
    log.warn({ err: error, runId: "run-1" }, "provider call failed");
    const text = output();
    for (const secret of ALL) expect(text).not.toContain(secret);
    const record = JSON.parse(text.trim());
    expect(record.err.type).toBe("Error");
    expect(record.err.message).toBe(
      "provider call failed with key ***REDACTED*** and token ***REDACTED***: ssh exited 255: Authorization denied for ***REDACTED***");
    expect(record.err.stack).toContain("Error: provider call failed (***REDACTED***)\n    at callProvider (provider.ts:10:5)");
    expect(record.err.stack).toContain("caused by: Error: ssh exited 255: Authorization denied for ***REDACTED***");
    expect(record.err.stderr).toBe("aws: ***REDACTED*** rejected");
    expect(record.runId).toBe("run-1");
    // The caller's Error object is not mutated by the serializer.
    expect(error.message).toContain(SECRETS.openai);
  });

  it("masks a top-level stderr / stdout box slice and a bare Error / string err", () => {
    const { log, output } = capture();
    log.warn({ runId: "run-2", stderr: `fatal: could not read ${SECRETS.github} from box`, stdout: `token ${SECRETS.jwt} printed` }, "kept");
    log.error(new Error(`bare error ${SECRETS.openai}`));
    log.warn({ err: `string err ${SECRETS.aws}` }, "primitive err");
    log.warn({ err: new Error(`object err ${SECRETS.github}`) });
    const text = output();
    for (const secret of ALL) expect(text).not.toContain(secret);
    const [first, second, third, fourth] = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(first.stderr).toBe("fatal: could not read ***REDACTED*** from box");
    expect(first.stdout).toBe("token ***REDACTED*** printed");
    expect(second.err.message).toBe("bare error ***REDACTED***");
    expect(second.msg).toBe("bare error ***REDACTED***");
    expect(third.err).toBe("string err ***REDACTED***");
    expect(fourth.msg).toBe("object err ***REDACTED***");
  });

  it("masks error text in child loggers and in pino-http error records", async () => {
    const { log, output } = capture();
    log.child({ module: "x" }).warn({ err: new Error(`child ${SECRETS.github}`) }, "child");
    const app = express();
    app.use(createHttpLogger(log));
    app.get("/api/boom", () => { throw new Error(`upstream said ${SECRETS.openai}`); });
    app.use(errorHandler);
    await request(app).get("/api/boom");
    const text = output();
    expect(text).toContain("child ***REDACTED***");
    const httpRecord = text.trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.req);
    expect(httpRecord.err.type).toBe("Error");
    expect(httpRecord.err.message).toBe("upstream said ***REDACTED***");
    expect(JSON.stringify(httpRecord.err)).not.toContain(SECRETS.openai);
  });

  it("masks the HTTP 500 record's msg, errorContext and err, keeping the surrounding words", async () => {
    const { log, output } = capture();
    const app = express();
    app.use(createHttpLogger(log));
    app.get("/api/boom", () => {
      throw new Error(`upstream rejected key ${SECRETS.openai} for ${SECRETS.github} with ${SECRETS.jwt} via ${SECRETS.aws} today`);
    });
    app.use(errorHandler);
    const response = await request(app).get("/api/boom");
    expect(response.status).toBe(500);
    const httpRecord = output().trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.req);
    for (const secret of ALL) expect(JSON.stringify(httpRecord)).not.toContain(secret);
    const masked = "upstream rejected key ***REDACTED*** for ***REDACTED*** with ***REDACTED*** via ***REDACTED*** today";
    expect(httpRecord.msg).toBe(`GET /api/boom 500 — ${masked}`);
    expect(httpRecord.errorContext.message).toBe(masked);
    expect(httpRecord.errorContext.stack).toContain(`Error: ${masked}\n    at `);
    expect(httpRecord.err.message).toBe(masked);
  });

  it("masks a secret only in the innermost cause of a 3-deep cause chain", () => {
    const { log, output } = capture();
    const innermost = new Error(`git said: remote: invalid credentials ${SECRETS.github} for repo`);
    const middle = new Error("clone step failed", { cause: innermost });
    const outer = new Error("workspace prepare failed", { cause: middle });
    log.warn({ err: new Error("run setup failed", { cause: outer }) }, "setup");
    const text = output();
    expect(text).not.toContain(SECRETS.github);
    const record = JSON.parse(text.trim());
    expect(record.err.message).toBe(
      "run setup failed: workspace prepare failed: clone step failed: git said: remote: invalid credentials ***REDACTED*** for repo");
    expect(record.err.stack).toContain("caused by: Error: git said: remote: invalid credentials ***REDACTED*** for repo");
  });

  it("masks a secret only in AggregateError errors[1]", () => {
    const { log, output } = capture();
    const aggregate = new AggregateError(
      [new Error("first upstream: 503 unavailable"), new Error(`second upstream: bad key ${SECRETS.openai} sent`)],
      "all upstreams failed",
    );
    log.warn({ err: aggregate }, "fan-out");
    const text = output();
    expect(text).not.toContain(SECRETS.openai);
    const record = JSON.parse(text.trim());
    expect(record.err.type).toBe("AggregateError");
    expect(record.err.aggregateErrors[0].message).toBe("first upstream: 503 unavailable");
    expect(record.err.aggregateErrors[1].message).toBe("second upstream: bad key ***REDACTED*** sent");
    expect(record.err.aggregateErrors[1].stack).toContain("second upstream: bad key ***REDACTED*** sent");
  });
});

describe("redactSensitiveText AWS secret access key assignment", () => {
  const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  it.each([
    [`aws s3 ls failed: aws_secret_access_key=${AWS_SECRET} rejected`, "aws s3 ls failed: aws_secret_access_key=***REDACTED*** rejected"],
    [`config: AWS_SECRET_ACCESS_KEY = "${AWS_SECRET}" in env`, 'config: AWS_SECRET_ACCESS_KEY = "***REDACTED***" in env'],
    [`profile aws-secret-access-key: ${AWS_SECRET} (default)`, "profile aws-secret-access-key: ***REDACTED*** (default)"],
  ])("masks %s", (input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
  });
});

describe("error text that is not a credential stays as written", () => {
  // One token-hint word ("token") is in every row so the full scanner runs.
  const rows: Array<[kind: string, value: string]> = [
    ["uuid", "6f1c2b7e-3d4a-4f5b-9c8d-0e1f2a3b4c5d"],
    ["run id", "run_01JD8X4ZK7Q2M9N3P5R6S7T8V9"],
    ["file path", "/srv/paperclip/instances/default/workspaces/6f1c2b7e/src/index.ts"],
    ["sha256 hex", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["git sha", "a3c8a95e04a2758bf91c7980f999c2ceb10c8075"],
    ["short git sha", "523dfe753"],
    ["ISO timestamp", "2026-11-18T17:36:04.512Z"],
  ];
  it.each(rows)("keeps a %s", (_kind, value) => {
    const line = `token refresh failed for ${value} at step 3`;
    expect(redactSensitiveText(line)).toBe(line);
    const { log, output } = capture();
    log.warn({ err: new Error(line) }, `kept ${value}`);
    const record = JSON.parse(output().trim());
    expect(record.err.message).toBe(line);
    expect(record.msg).toBe(`kept ${value}`);
  });
});

// Six credential kinds in one line: provider key, GitHub token, JWT, AWS key id,
// AWS secret assignment and a bare Bearer credential.
const CANARIES = [
  SECRETS.openai,
  SECRETS.github,
  SECRETS.jwt,
  SECRETS.aws,
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "Q7x9A2b4C6d8E0f2G4h6",
];
const CANARY_LINE =
  `kept diagnostic ${CANARIES[0]} ${CANARIES[1]} ${CANARIES[2]} ${CANARIES[3]} aws_secret_access_key=${CANARIES[4]} Bearer ${CANARIES[5]} end`;
const MASKED_LINE =
  "kept diagnostic ***REDACTED*** ***REDACTED*** ***REDACTED*** ***REDACTED*** aws_secret_access_key=***REDACTED*** Bearer ***REDACTED*** end";

function records(text: string) {
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

function expectNoCanary(text: string) {
  for (const canary of CANARIES) expect(text).not.toContain(canary);
}

describe("every msg Pino emits is masked", () => {
  it("masks the msg Pino infers from err when the object's msg is undefined", () => {
    const { log, output } = capture();
    log.error({ err: new Error(CANARY_LINE), msg: undefined });
    const text = output();
    expectNoCanary(text);
    expect(records(text)[0].msg).toBe(MASKED_LINE);
  });

  it("masks an explicit message argument, with and without a merging object", () => {
    const { log, output } = capture();
    const err = new Error(CANARY_LINE);
    log.error({ err }, err.message);
    log.info(CANARY_LINE);
    log.warn(err, `wrapped: ${CANARY_LINE}`);
    const text = output();
    expectNoCanary(text);
    const [first, second, third] = records(text);
    expect(first.msg).toBe(MASKED_LINE);
    expect(second.msg).toBe(MASKED_LINE);
    expect(third.msg).toBe(`wrapped: ${MASKED_LINE}`);
  });

  it("masks %s / %o format arguments after Pino formats the message", () => {
    const { log, output } = capture();
    log.info("provider said %s", CANARY_LINE);
    log.warn({ runId: "run-3" }, "first %s then %s", CANARIES[0], `Bearer ${CANARIES[5]}`);
    log.error("details %o", { detail: CANARY_LINE });
    const text = output();
    expectNoCanary(text);
    const [first, second, third] = records(text);
    expect(first.msg).toBe(`provider said ${MASKED_LINE}`);
    expect(second.msg).toBe("first ***REDACTED*** then Bearer ***REDACTED***");
    expect(second.runId).toBe("run-3");
    expect(third.msg).toContain(MASKED_LINE);
  });

  it("masks a string or object msg property on the merging object", () => {
    const { log, output } = capture();
    log.error({ err: new Error("provider failed"), msg: CANARY_LINE });
    log.warn({ msg: { detail: CANARY_LINE } });
    log.info({ msg: CANARY_LINE }, "explicit wins");
    const text = output();
    expectNoCanary(text);
    const [first, second, third] = records(text);
    expect(first.msg).toBe(MASKED_LINE);
    expect(first.err.message).toBe("provider failed");
    expect(second.msg).toEqual({ detail: MASKED_LINE });
    expect(third.msg).toBe("explicit wins");
  });

  it("masks every msg shape in child loggers, including ones with their own serializers and prefix", () => {
    const { log, output } = capture();
    const child = log.child({ module: "x" });
    child.error({ err: new Error(CANARY_LINE), msg: undefined });
    child.info("child said %s", CANARY_LINE);
    const own = log.child({ module: "y" }, { serializers: { req: (value: unknown) => value }, msgPrefix: "[y] " });
    own.warn(CANARY_LINE);
    own.child({ module: "z" }).error({ msg: CANARY_LINE });
    const text = output();
    expectNoCanary(text);
    const [first, second, third, fourth] = records(text);
    expect(first.msg).toBe(MASKED_LINE);
    expect(second.msg).toBe(`child said ${MASKED_LINE}`);
    expect(third.msg).toBe(`[y] ${MASKED_LINE}`);
    expect(fourth.msg).toBe(MASKED_LINE);
  });

  it("masks messages logged through pino-http's request logger", async () => {
    const { log, output } = capture();
    const app = express();
    app.use(createHttpLogger(log));
    app.get("/api/talk", (req, res) => {
      req.log.warn("upstream said %s", CANARY_LINE);
      req.log.error({ err: new Error(CANARY_LINE), msg: undefined });
      res.status(200).json({ ok: true });
    });
    await request(app).get("/api/talk");
    const text = output();
    expectNoCanary(text);
    const [first, second] = records(text);
    expect(first.msg).toBe(`upstream said ${MASKED_LINE}`);
    expect(second.msg).toBe(MASKED_LINE);
  });

  it("keeps a message with no credential exactly as written", () => {
    const { log, output } = capture();
    log.info("run %s finished in %d ms at %s", "run_01JD8X4ZK7Q2M9N3P5R6S7T8V9", 42, "2026-11-18T17:36:04.512Z");
    expect(records(output())[0].msg).toBe("run run_01JD8X4ZK7Q2M9N3P5R6S7T8V9 finished in 42 ms at 2026-11-18T17:36:04.512Z");
  });
});

describe("the log mask fails closed past its depth bound", () => {
  it("replaces an err extra deeper than the bound with a marker, never the raw subtree", () => {
    const { log, output } = capture();
    let details: Record<string, unknown> = { leaf: CANARY_LINE, keys: [...CANARIES] };
    for (let level = 0; level < 10; level += 1) details = { child: details };
    log.error({ err: Object.assign(new Error("provider failed"), { details }) }, "provider failed");
    const text = output();
    expectNoCanary(text);
    expect(text).toContain('"[masked: nested deeper than 8]"');
    let node = records(text)[0].err.details;
    while (node && typeof node === "object") node = node.child;
    expect(node).toBe("[masked: nested deeper than 8]");
  });

  it("replaces a deep stderr / stdout slice the same way", () => {
    const { log, output } = capture();
    let deep: unknown = [CANARY_LINE];
    for (let level = 0; level < 10; level += 1) deep = [deep];
    log.warn({ stderr: deep, stdout: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: CANARY_LINE } } } } } } } } } } }, "box output");
    const text = output();
    expectNoCanary(text);
    expect(text).toContain('"[masked: nested deeper than 8]"');
  });
});

// ---------------------------------------------------------------------------
// RFL errser J1-J3 and the adversarial sweep. Each row runs through three
// loggers: production (walker + streamWrite backstop), the walker alone
// (backstop off) and, for the backstop rows, the backstop alone (walker off).
// A mutation of one layer turns that layer's rows RED.
// ---------------------------------------------------------------------------

type Layer = "production" | "walker" | "backstop";

function captureLayer(layer: Layer) {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const options =
    layer === "production"
      ? { ...baseLoggerOptions }
      : layer === "walker"
        ? { ...baseLoggerOptions, hooks: {} }
        : {
            ...baseLoggerOptions,
            // The walker disabled: Pino's own err serializer and identity text
            // serializers, so only the final streamWrite backstop can mask.
            serializers: {
              err: pino.stdSerializers.err,
              msg: (value: unknown) => value,
              stderr: (value: unknown) => value,
              stdout: (value: unknown) => value,
            },
          };
  return { log: pino({ ...options, level: "debug" }, stream), output: () => chunks.join("") };
}

function expectCleanLines(text: string) {
  expectNoCanary(text);
  // Every written line is still one valid JSON record.
  for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
}

// An HTTP client error (axios-style): an enumerable toJSON on the prototype
// that returns the request config with its headers.
function httpClientError(message: string) {
  function ClientError(this: Error & Record<string, unknown>) {
    this.message = message;
    this.name = "AxiosError";
    this.config = { url: "https://api.example.test/v1/x", headers: { Authorization: `Bearer ${CANARIES[5]}`, "x-api-key": CANARIES[0] } };
  }
  ClientError.prototype = Object.create(Error.prototype);
  ClientError.prototype.toJSON = function toJSON(this: Record<string, unknown>) {
    return { message: this.message, name: this.name, config: { url: "https://api.example.test/v1/x", headers: { Authorization: `Bearer ${CANARIES[5]}`, token: CANARIES[2] } }, note: CANARY_LINE };
  };
  return new (ClientError as unknown as new () => Error)();
}

describe.each<Layer>(["production", "walker"])("structured values are masked (%s)", (layer) => {
  it("J1: masks what an enumerable toJSON returns, in msg, stderr and err.details", () => {
    const { log, output } = captureLayer(layer);
    log.warn({ msg: { toJSON() { return CANARY_LINE; } } });
    log.warn({ stderr: { toJSON() { return { inner: CANARY_LINE }; } } }, "box");
    log.error({ err: Object.assign(new Error("provider failed"), { details: { toJSON: () => CANARY_LINE } }) }, "provider failed");
    // A function is dropped, not kept: JSON.stringify calls a toJSON found on a function too.
    log.warn({ stderr: { callback: Object.assign(() => 1, { toJSON: () => CANARY_LINE }) } }, "callback");
    const text = output();
    expectCleanLines(text);
    const [first, second, third, fourth] = records(text);
    expect(fourth.stderr).toEqual({});
    expect(first.msg).toBe(MASKED_LINE);
    expect(second.stderr).toEqual({ inner: MASKED_LINE });
    expect(third.err.details).toBe(MASKED_LINE);
  });

  it("J1: masks an HTTP-client error whose toJSON returns its config and headers", () => {
    const { log, output } = captureLayer(layer);
    log.error({ err: httpClientError(`request failed ${CANARIES[1]}`) }, "upstream failed");
    log.warn({ err: { toJSON: () => ({ headers: { authorization: `Bearer ${CANARIES[5]}` } }) } }, "plain err");
    const text = output();
    expectCleanLines(text);
    const [first] = records(text);
    expect(first.err.message).toBe("request failed ***REDACTED***");
    expect(first.err.config.headers.Authorization).toBe("Bearer ***REDACTED***");
    // The record is what the error's toJSON returns (as JSON.stringify would
    // write it at c2), masked: not a callable left for the serializer.
    expect(first.err.note).toBe(MASKED_LINE);
  });

  it("J1: masks toJSON output through pino-http's req.log and the auto-5xx record", async () => {
    const { log, output } = captureLayer(layer);
    const app = express();
    app.use(createHttpLogger(log));
    app.get("/api/talk", (req, res) => {
      req.log.warn({ msg: { toJSON: () => CANARY_LINE } });
      req.log.error({ err: httpClientError("client error") }, "client failed");
      res.status(200).json({ ok: true });
    });
    app.get("/api/boom", () => { throw httpClientError(`upstream said ${CANARIES[3]}`); });
    app.get("/api/unavailable", (_req, res) => {
      (res as unknown as { err: unknown }).err = httpClientError("busy");
      res.status(503).json({ error: "unavailable" });
    });
    app.use(errorHandler);
    await request(app).get("/api/talk");
    expect((await request(app).get("/api/boom")).status).toBe(500);
    expect((await request(app).get("/api/unavailable")).status).toBe(503);
    const text = output();
    expectCleanLines(text);
    const all = records(text);
    expect(all[0].msg).toBe(MASKED_LINE);
    expect(all.filter((record) => record.res?.statusCode >= 500)).toHaveLength(2);
  });

  it("J2: masks object keys in msg, stderr, stdout and err extras", () => {
    const { log, output } = captureLayer(layer);
    log.warn({ msg: { [CANARY_LINE]: 1 } });
    log.warn({ stderr: { [CANARIES[0]]: "x" }, stdout: [{ [`Bearer ${CANARIES[5]}`]: true }] }, "box");
    log.error({ err: Object.assign(new Error("provider failed"), { details: { nested: { [CANARIES[1]]: CANARIES[2] } } }) }, "x");
    const text = output();
    expectCleanLines(text);
    const [first, second, third] = records(text);
    expect(Object.keys(first.msg)).toEqual([MASKED_LINE]);
    expect(second.stderr).toEqual({ "***REDACTED***": "x" });
    expect(third.err.details.nested).toEqual({ "***REDACTED***": "***REDACTED***" });
  });

  it("J3: decodes Buffer / Uint8Array / ArrayBuffer as text and masks it, in msg, stderr, stdout and err.details", () => {
    const { log, output } = captureLayer(layer);
    const bytes = Buffer.from(CANARY_LINE, "utf8");
    log.warn({ msg: bytes });
    log.warn({ stderr: bytes, stdout: new Uint8Array(bytes) }, "box");
    log.error({ err: Object.assign(new Error("provider failed"), { details: { body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } }) }, "x");
    const text = output();
    expectCleanLines(text);
    const [first, second, third] = records(text);
    expect(first.msg).toBe(MASKED_LINE);
    expect(second.stderr).toBe(MASKED_LINE);
    expect(second.stdout).toBe(MASKED_LINE);
    expect(third.err.details.body).toBe(MASKED_LINE);
    // The raw bytes never reach the line, in any encoding.
    expect(text).not.toContain(String(bytes[0]) + "," + String(bytes[1]));
  });

  it("J3: replaces bytes that are not valid UTF-8 with a marker and their length", () => {
    const { log, output } = captureLayer(layer);
    log.warn({ stderr: Buffer.from([0xff, 0xfe, 0x00, 0x41]) }, "binary");
    expect(records(output())[0].stderr).toBe("[masked: binary value, 4 bytes]");
  });

  it("masks each of the six canaries wrapped in a terminal colour code, in stderr and err.message", () => {
    const { log, output } = captureLayer(layer);
    const coloured = `${CANARIES.slice(0, 4).map((canary) => `\u001b[31m${canary}\u001b[0m`).join(" ")} aws_secret_access_key=${CANARIES[4]} \u001b[1mBearer ${CANARIES[5]}\u001b[0m`;
    log.warn({ stderr: coloured }, "box");
    log.error({ err: new Error(coloured) }, "coloured");
    expectCleanLines(output());
  });

  it("sweep: getters, symbol keys, Map / Set, typed arrays, circular, null prototype", () => {
    const { log, output } = captureLayer(layer);
    const circular: Record<string, unknown> = { leaf: CANARY_LINE };
    circular.self = circular;
    const shared = { leaf: "shared value" };
    const bare = Object.assign(Object.create(null), { leaf: CANARY_LINE });
    const even = new Uint8Array(Buffer.from(`${CANARY_LINE} `.length % 2 ? `${CANARY_LINE}  ` : `${CANARY_LINE} `, "utf8"));
    log.warn({ stderr: { get leak() { return CANARY_LINE; } } }, "getter");
    log.warn({ stderr: { [Symbol(CANARY_LINE)]: CANARY_LINE, kept: 1 } }, "symbol");
    log.warn({ stderr: { map: new Map([["k", CANARY_LINE]]), set: new Set([CANARY_LINE]) } }, "map");
    log.warn({ stderr: new Uint16Array(even.buffer) }, "typed");
    log.warn({ stderr: circular, stdout: { a: shared, b: shared } }, "circular");
    log.warn({ stderr: bare }, "null proto");
    const text = output();
    expectCleanLines(text);
    const [getter, symbol, , typed, circ, nullProto] = records(text);
    expect(getter.stderr.leak).toBe(MASKED_LINE);
    expect(symbol.stderr).toEqual({ kept: 1 });
    expect(typed.stderr.startsWith(MASKED_LINE)).toBe(true);
    expect(circ.stderr).toEqual({ leaf: MASKED_LINE, self: "[Circular]" });
    // A shared, non-circular reference is written in full both times.
    expect(circ.stdout).toEqual({ a: { leaf: "shared value" }, b: { leaf: "shared value" } });
    expect(nullProto.stderr.leaf).toBe(MASKED_LINE);
  });

  it("sweep: non-enumerable cause, AggregateError inside a cause, getter message", () => {
    const { log, output } = captureLayer(layer);
    const hidden = new Error("outer failed");
    Object.defineProperty(hidden, "cause", { value: new Error(CANARY_LINE), enumerable: false });
    const aggregate = new AggregateError([new Error("ok"), new Error(CANARY_LINE)], "fan-out failed");
    const getterMessage = new Error("placeholder");
    Object.defineProperty(getterMessage, "message", { get: () => CANARY_LINE, enumerable: false, configurable: true });
    log.error({ err: hidden }, "hidden cause");
    log.error({ err: new Error("outer", { cause: aggregate }) }, "aggregate cause");
    log.error({ err: getterMessage });
    const text = output();
    expectCleanLines(text);
    expect(records(text)[2].msg).toBe(MASKED_LINE);
  });

  it("sweep: URL objects drop userinfo and query; a Date subclass keeps its ISO text", () => {
    const { log, output } = captureLayer(layer);
    class SecretDate extends Date { override toString() { return CANARY_LINE; } }
    class SecretJsonDate extends Date { override toJSON() { return CANARY_LINE; } }
    const url = new URL(`https://deploy:hunter2-userinfo-pass@git.example.test/repo.git?access_token=${CANARIES[1]}&x=1`);
    log.warn({ stderr: { url, when: new SecretDate(0), json: new SecretJsonDate(0) } }, "url");
    const text = output();
    expectCleanLines(text);
    expect(text).not.toContain("hunter2-userinfo-pass");
    const [record] = records(text);
    expect(record.stderr.url).toBe("https://git.example.test/repo.git");
    expect(record.stderr.when).toBe("1970-01-01T00:00:00.000Z");
    expect(record.stderr.json).toBe(MASKED_LINE);
  });

  it("sweep: a Proxy whose get throws, a throwing toJSON, a BigInt and a 5,000-char string", () => {
    const { log, output } = captureLayer(layer);
    const hostile = new Proxy({ leaf: CANARY_LINE }, { get() { throw new Error(CANARY_LINE); } });
    const long = `${"x".repeat(5_000)} ${CANARIES[0]}`;
    log.warn({ stderr: hostile }, "proxy");
    log.warn({ stderr: { toJSON() { throw new Error(CANARY_LINE); } } }, "throwing toJSON");
    log.warn({ stderr: { count: 10n } }, "bigint");
    log.warn({ stderr: long, msg: long });
    const text = output();
    expectCleanLines(text);
    const [proxy, throwing, bigint, longRecord] = records(text);
    expect(JSON.stringify(proxy.stderr)).toContain("[masked: unreadable value]");
    expect(throwing.stderr).toBe("[masked: unreadable value]");
    expect(bigint.stderr.count).toBe(10);
    expect(longRecord.stderr.endsWith(" ***REDACTED***")).toBe(true);
    expect(longRecord.msg.endsWith(" ***REDACTED***")).toBe(true);
  });
});

describe("the streamWrite backstop masks the finished JSON line", () => {
  // Secrets right after a JSON escape: the escaped form (\n, \t, \", \u0007)
  // puts a letter before the credential, so a raw-text scan of the line misses it.
  const AFTER_ESCAPES: Array<[string, string]> = [
    ["newline", `line one\n${CANARIES[0]}`],
    ["tab", `col\tBearer ${CANARIES[5]}`],
    ["quote", `said "${CANARIES[1]}" twice`],
    ["control \\u0007", `bell\u0007Bearer ${CANARIES[5]}`],
    ["control \\u001b", `\u001b[31m${CANARIES[3]}\u001b[0m`],
  ];

  it.each(AFTER_ESCAPES)("masks a secret after an escaped %s in msg, err.message, stderr and a nested field, past the walker", (_kind, value) => {
    const { log, output } = captureLayer("backstop");
    log.warn(value);
    log.error({ err: new Error(value) }, "err");
    log.warn({ stderr: value }, "stderr");
    log.warn({ ctx: { nested: [{ deeper: value }] } }, "nested");
    const text = output();
    expectCleanLines(text);
    for (const record of records(text)) expect(JSON.stringify(record)).toContain("***REDACTED***");
  });

  it("masks a secret behind an escaped \\u0042 (Bearer) and in a key, given the line directly", () => {
    const line = `{"level":40,"msg":"\\u0042earer ${CANARIES[5]}","ctx":{"${CANARIES[0]}":1}}\n`;
    const masked = maskSerializedLogLine(line);
    expect(masked).toBe('{"level":40,"msg":"Bearer ***REDACTED***","ctx":{"***REDACTED***":1}}\n');
    expect(() => JSON.parse(masked)).not.toThrow();
  });

  it("masks keys, getters and toJSON output in fields the walker never visits", () => {
    const { log, output } = captureLayer("production");
    log.info({ ctx: { [CANARIES[1]]: { get v() { return CANARY_LINE; } }, j: { toJSON: () => CANARY_LINE } } }, "ctx");
    const text = output();
    expectCleanLines(text);
  });

  it("decodes Buffer and Uint8Array bytes in fields the walker never visits; leaves clean bytes as written", () => {
    const { log, output } = captureLayer("production");
    const bytes = Buffer.from(CANARY_LINE, "utf8");
    log.info({ ctx: { body: bytes, view: new Uint8Array(bytes), clean: Buffer.from("hi") } }, "bytes");
    const text = output();
    expectCleanLines(text);
    const [record] = records(text);
    expect(record.ctx.body).toBe(MASKED_LINE);
    expect(record.ctx.view).toBe(MASKED_LINE);
    expect(record.ctx.clean).toEqual({ type: "Buffer", data: [104, 105] });
  });

  it("covers a child that replaces serializers.msg with identity (Pino's intended override)", () => {
    const { log, output } = captureLayer("production");
    log.child({}, { serializers: { msg: (value: unknown) => value } }).warn(CANARY_LINE);
    expectCleanLines(output());
    expect(records(output())[0].msg).toBe(MASKED_LINE);
  });

  it("returns a clean line byte for byte: no reordering, no reformatting, duplicate keys kept", () => {
    const clean = [
      '{"level":30,"time":1763496964512,"b":1,"1":2,"msg":"run finished","module":"a","module":"b","n":1e21,"x":-0}\n',
      `{"level":50,"msg":${JSON.stringify("429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"},\"request_id\":\"req_011CVBxF6Lr3v9kQ2nT8wYzA\"}\nline two\ttabbed \u2028 é")}}\n`,
    ];
    for (const line of clean) expect(maskSerializedLogLine(line)).toBe(line);
    const { log, output } = captureLayer("walker");
    const withBackstop = captureLayer("production");
    const row = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CVBz9aB3cD5eF7gH9iJkL"}';
    for (const logger of [log, withBackstop.log]) logger.error({ err: new Error(row) }, row);
    const strip = (text: string) => text.replace(/"time":\d+,/g, "");
    expect(strip(withBackstop.output())).toBe(strip(output()));
  });
});

// ---------------------------------------------------------------------------
// Gap (iv): a password in a URL's userinfo, inside plain text. DB / driver
// errors print their connection string. The scheme, the user and `@host` stay;
// only the password is masked.
// ---------------------------------------------------------------------------

describe("a password in a URL's userinfo inside text is masked", () => {
  const POSITIVE: Array<[kind: string, input: string, expected: string, password: string]> = [
    ["postgres", "connect ECONNREFUSED postgres://app:S3cretPw@db:5432/x", "connect ECONNREFUSED postgres://app:***REDACTED***@db:5432/x", "S3cretPw"],
    ["mysql", "Access denied for mysql://root:Hunter2Mysql@10.0.0.5:3306/app (ER_ACCESS_DENIED_ERROR)", "Access denied for mysql://root:***REDACTED***@10.0.0.5:3306/app (ER_ACCESS_DENIED_ERROR)", "Hunter2Mysql"],
    ["redis, empty user", "Error: connect ETIMEDOUT redis://:R3disOnlyPw@cache:6379/0", "Error: connect ETIMEDOUT redis://:***REDACTED***@cache:6379/0", "R3disOnlyPw"],
    ["amqp", "Socket closed during handshake to amqp://guest:Gu3stRabbitPw@rabbit:5672/vhost", "Socket closed during handshake to amqp://guest:***REDACTED***@rabbit:5672/vhost", "Gu3stRabbitPw"],
    ["https", "request to https://deploy:Dep10yHttpsPw@git.example.test/repo.git failed", "request to https://deploy:***REDACTED***@git.example.test/repo.git failed", "Dep10yHttpsPw"],
    ["%40-encoded password", "pool error postgresql://app:S3cret%40Encoded@db/x", "pool error postgresql://app:***REDACTED***@db/x", "S3cret%40Encoded"],
    ["%-escapes and a literal :", "connect postgres://app:p%2Fa:ss%3Aw0rdX@db:5432/x refused", "connect postgres://app:***REDACTED***@db:5432/x refused", "p%2Fa:ss%3Aw0rdX"],
    ["scheme with + and .", "sqlalchemy postgresql+asyncpg://svc:Plus.Scheme-Pw@db/x down", "sqlalchemy postgresql+asyncpg://svc:***REDACTED***@db/x down", "Plus.Scheme-Pw"],
  ];
  const NEGATIVE: Array<[kind: string, input: string]> = [
    ["a URL with a user and no password", "fetch https://user@host.example.test/path failed"],
    ["a plain https URL with a port and query", "fetch https://api.example.test:8443/v1/x?x=1&y=2 failed"],
    ["an email address", "notify paul@example.com and ops@example.org failed"],
    ["a git sha after @ (pip/npm git spec)", "install git+https://github.com/org/repo.git@a3c8a95e04a2758bf91c7980f999c2ceb10c8075 failed"],
    ["a git sha after @ (ssh user, no password)", "clone ssh://git@github.com/org/repo.git@523dfe753 failed"],
    ["a host:port then a path with @", "GET https://host.example.test:8443/pkg/@scope/name@1.2.3 failed"],
  ];

  it.each(POSITIVE)("masks the %s password, given the text directly", (_kind, input, expected) => {
    expect(redactSensitiveText(input)).toBe(expected);
    // Idempotent: a masked line is left as it is.
    expect(redactSensitiveText(expected)).toBe(expected);
  });

  it.each(POSITIVE)("masks the %s password inside an Error logged through the production Pino logger", (_kind, input, expected, password) => {
    const { log, output } = capture();
    const err = new Error(input);
    err.stack = `Error: ${input}\n    at connect (driver.ts:10:5)`;
    log.error({ err }, input);
    const text = output();
    expect(text).not.toContain(password);
    const [record] = records(text);
    expect(record.err.message).toBe(expected);
    expect(record.err.stack.split("\n")[0]).toBe(`Error: ${expected}`);
    expect(record.msg).toBe(expected);
  });

  it.each(NEGATIVE)("keeps %s as written", (_kind, input) => {
    expect(redactSensitiveText(input)).toBe(input);
    const { log, output } = capture();
    log.error({ err: new Error(input) }, input);
    const [record] = records(output());
    expect(record.err.message).toBe(input);
    expect(record.msg).toBe(input);
  });
});
