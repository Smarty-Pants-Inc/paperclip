import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { baseLoggerOptions, createHttpLogger } from "../middleware/logger.js";
import { errorHandler } from "../middleware/error-handler.js";

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
});
