// N1's subprocess exercises production callers, not test logger mocks.
// Keep reason: never-OK leaking a matched secret through diagnostic side effects.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { activityLog, agents, agentApiKeys, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { providerPrefixKeys } from "./provider-prefix-keys.js";
import { createProviderTraceFileSink } from "../../../../packages/paperclip-runner/src/contracts/provider-trace-file-sink.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { logger, createHttpLogger } from "../../middleware/logger.js";
import { issueRoutes } from "../../routes/issues.js";
import { redactSensitiveText } from "../../redaction.js";
import { closeProcessRunAdmission } from "../../services/heartbeat/run-admission.js";
import { providerTraceStore } from "../../services/provider-trace-store.js";
import type { StorageService } from "../../storage/types.js";

export async function exerciseNoWrite(): Promise<void> {
const directory = process.env.N1_DIRECTORY!;
await mkdir(directory, { recursive: true });
const save = async (name: string, data: unknown) => writeFile(join(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 });
const noKey = (data: unknown, caller: string) => {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const [family, key] of providerPrefixKeys) assert.ok(!text.includes(key), `${caller}: ${family} leaked`);
};
// Trace/debug really enabled, including the lowest Pino level.
assert.equal(logger.level, "trace");
closeProcessRunAdmission();
const database = await startEmbeddedPostgresTestDatabase("provider-no-write-");
const db = createDb(database.connectionString);
try {
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "No-write credential guard", issuePrefix: "NOWR", requireBoardApprovalForNewAgents: false });
  await db.insert(authUsers).values({ id: userId, name: "Guard owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Guard writer", role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
    { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
  ]);
  await db.insert(issues).values({ id: issueId, companyId, title: "No-write matched secret", identifier: "NOWR-1", issueNumber: 1, status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", scopeKind: "issue", issueId, nativeIssueId: issueId, responsibleUserId: userId, contextSnapshot: { issueId } });
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  const token = randomUUID();
  await db.insert(agentApiKeys).values({ companyId, agentId, name: "Runtime-only fixture auth", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
  const storage: StorageService = {
    provider: "local_disk",
    putFile: async () => { throw new Error("unexpected storage write"); },
    getObject: async () => { throw new Error("unexpected storage read"); },
    headObject: async () => ({ exists: false }), deleteObject: async () => undefined,
  };
  const app = express();
  app.use(createHttpLogger(logger));
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
  app.use("/api", issueRoutes(db, storage));
  app.use(errorHandler);
  // The unchanged Runner sink is only the frame producer. The server owns the
  // prepared path, persisted trace metadata, finalization and readback below.
  const traces = providerTraceStore(db);
  const capture = await traces.prepare({ runId, companyId, provider: "pi_rpc", requestedBy: userId });
  const sink = await createProviderTraceFileSink({ path: capture.path, provider: "pi_rpc", channel: "N1" });
  assert.ok(sink);
  const results: unknown[] = [];
  try {
    for (const [family, key] of providerPrefixKeys) {
      const input = `upstream ${key}\nretry denied`;
      const server = redactSensitiveText(input);
      noKey(server, "server redactSensitiveText");
      assert.ok(server.includes("REDACTED"), `${family}: must force a match`);
      // Low-level logs, serialized errors/stacks, and metric-like structured labels
      // all cross the actual Pino byte hook. Do not pre-redact their arguments.
      for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
        logger[level]({ family, detail: key, err: new Error(input), metric: "redaction_probe", labels: { reason: key } }, input);
      }
      const frameId = sink.frame({ direction: "provider_to_client", transport: "stdio", raw: JSON.stringify({ detail: input }) });
      sink.interpretation({ frameId: frameId!, stage: "N1", ruleId: "N1", disposition: "rejected", reason: input });
      const response = await request(app).post(`/api/issues/${issueId}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId).send({ body: input });
      // Avoid assert.equal(response.status, ...) with a raw body in its message.
      assert.equal(response.status, 201, `${family}: comment create failed`);
      noKey(response.body, "comment response");
      const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, response.body.id));
      noKey(stored, "stored comment");
      const denied = await request(app).post(`/api/issues/${randomUUID()}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId).send({ body: input });
      assert.equal(denied.status, 404, `${family}: expected denied route`);
      noKey(denied.body, "denied route response");
      // Emit the server's returned redaction on both ordinary stdout and stderr too.
      console.log(JSON.stringify({ family, server }));
      console.error(JSON.stringify({ family, error: server }));
      results.push({ family, server, returned: response.body, stored, denied: denied.body });
    }
  } finally {
    await sink.finish({ reason: redactSensitiveText(providerPrefixKeys.map(([, key]) => key).join("\n")) });
  }
  const comments = await request(app).get(`/api/issues/${issueId}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId);
  assert.equal(comments.status, 200);
  noKey(comments.body, "comment readback");
  const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
  noKey(audit, "audit");
  await save("caller-results.json", results);
  await save("comment-readback-audit.json", { comments: comments.body, audit });
  await traces.finalize(runId, companyId);
  const persisted = await traces.getByRun(runId, companyId);
  assert.equal(persisted?.frameCount, providerPrefixKeys.length);
  const frames = await traces.readExactEntries(runId, companyId);
  assert.ok(frames);
  const inspection = await traces.inspect(runId, companyId);
  await save("trace-server-readback-census.json", { trace: inspection.trace,
    visibleFamilies: providerPrefixKeys.filter(([, key]) => JSON.stringify(inspection).includes(key)).map(([family]) => family) });
  noKey(inspection, "server trace inspection");
  noKey(await traces.revealFrame(runId, companyId, 1), "server exact frame reveal");
  const decoded = frames.filter(row => row.kind === "frame").map(row => Buffer.from(row.rawBase64, "base64").toString("utf8"));
  assert.equal(decoded.length, providerPrefixKeys.length);
  noKey(decoded, "decoded trace frames");
  await save("trace-decoded.json", decoded);
  await save("coverage.json", { canaries: providerPrefixKeys.length, callers: ["redactSensitiveText", "authenticated comment route + denied route + audit", "Pino trace/debug/info/warn/error/fatal + Error stack + metric labels", "trace frames + interpretations"], level: logger.level, mode: process.env.NODE_ENV });
  // Check files while the database/logs still exist, before its helper cleanup.
  const inventory: { path: string; bytes: number }[] = [];
  async function inspect(root: string): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        for (const [family, key] of providerPrefixKeys) assert.ok(!bytes.includes(Buffer.from(key)), `${family}: raw secret in file ${path}`);
        inventory.push({ path, bytes: bytes.length });
      }
    }
  }
  await inspect(directory);
  await save("pre-cleanup-file-census.json", inventory);
} finally {
  await db.$client.end({ timeout: 5 });
  await database.cleanup();
  await new Promise<void>((resolve, reject) => logger.flush(error => error ? reject(error) : resolve()));
}
}
