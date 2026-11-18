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
