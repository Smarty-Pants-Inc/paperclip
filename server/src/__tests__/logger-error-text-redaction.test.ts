import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { baseLoggerOptions, createHttpLogger } from "../middleware/logger.js";
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
