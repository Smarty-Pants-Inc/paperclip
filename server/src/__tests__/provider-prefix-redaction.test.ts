import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentApiKeys, authUsers, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { providerPrefixKeys } from "./fixtures/provider-prefix-keys.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { redactEventPayload, REDACTED_EVENT_VALUE } from "../redaction.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { createNativeRunTrace } from "../services/native-runtime/native-run-trace.js";
import { publishLiveEvent } from "../services/live-events.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { StorageService } from "../storage/types.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Optional acceptance artifact: callers select an owned evidence directory.
// Save only after all no-cleartext assertions pass, never authentication material.
async function saveEvidence(name: string, value: unknown) {
  const directory = process.env.PAPERCLIP_REDACTION_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// Keep reason: never-OK exposing a credential. Real authentication, route and Postgres writes.
// catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21032
// No provider invocation or credential use: all format canaries are synthetic.
describe("K2 agent comment provider-prefix write boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "prefix-redaction-home-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("provider-prefix-redaction-");
    db = createDb(database.connectionString);
    closeProcessRunAdmission();
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    resetProcessRunAdmissionForTests();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("masks every family in the stored and returned body, readback and audit", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Credential redaction boundary", issuePrefix: "KEY", requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Synthetic owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic writer", role: "engineer", adapterType: "process", status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Bare key redaction", identifier: "KEY-1", issueNumber: 1, status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", scopeKind: "issue", issueId, nativeIssueId: issueId, responsibleUserId: userId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId, name: "Synthetic local fixture", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const storage: StorageService = { provider: "local_disk", putFile: vi.fn(), getObject: vi.fn(), headObject: vi.fn(async () => ({ exists: false })), deleteObject: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
    const body = providerPrefixKeys.map(([family, key]) => `${family}: ${key}`).join("\n");
    const response = await request(app).post(`/api/issues/${issueId}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId).send({ body });
    expect(response.status, response.text).toBe(201);
    expect(response.body.authorAgentId).toBe(agentId);
    const [saved] = await db.select().from(issueComments).where(eq(issueComments.id, response.body.id));
    const readback = await request(app).get(`/api/issues/${issueId}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId);
    expect(readback.status, readback.text).toBe(200);
    expect(saved.body).toBe(response.body.body);
    expect(readback.body).toContainEqual(expect.objectContaining({ id: saved.id, body: saved.body }));
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    for (const [family, key] of providerPrefixKeys) {
      expect(saved.body, family).not.toContain(key);
      expect(response.body.body, family).not.toContain(key);
      expect(JSON.stringify(readback.body), family).not.toContain(key);
      expect(JSON.stringify(activity), family).not.toContain(key);
      expect(saved.body, family).toContain(`${family}: ${REDACTED_EVENT_VALUE}`);
    }
    await saveEvidence("comment-write-readback.json", { stored: saved, returned: response.body, readback: readback.body, activity });
    // Denial still uses real access checks and does not write another comment.
    expect((await request(app).post(`/api/issues/${randomUUID()}/comments`).set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", runId).send({ body })).status).toBe(404);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
  }, 30_000);

  it("masks every family in persisted run events, performance traces and published live events", async () => {
    const [company] = await db.insert(companies).values({ name: "Event boundary", issuePrefix: "EVT" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Synthetic event source" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running" }).returning();
    const runId = run.id;
    const body = providerPrefixKeys.map(([family, key]) => `${family}: ${key}`).join("\n");
    // Actual event and performance-trace sinks: read back persisted Postgres rows
    // and the public live-event payload, not just the redaction helper output.
    const deps = {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() },
      companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) },
      treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: async () => ({ enabled: false }),
      getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
      emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    } satisfies HeartbeatLifecycleDependencies;
    const lifecycle = createHeartbeatLifecycle(db, deps);
    vi.mocked(publishLiveEvent).mockClear();
    await lifecycle.appendRunEvent(run, { eventType: "provider.notice", stream: "stdout", message: body, payload: { message: body, nested: [body] } });
    const trace = createNativeRunTrace({ runId, onEvent: event => lifecycle.appendRunEvent(run, event) });
    for (const [, key] of providerPrefixKeys) {
      await trace.measure("provider.reply", async () => undefined, { attributes: { reason: key } });
    }
    await trace.finish("ok");
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some(event => event.eventType === "provider.notice")).toBe(true);
    expect(events.some(event => event.eventType === "run.performance.span")).toBe(true);
    const storedEvents = JSON.stringify(events), publishedEvents = JSON.stringify(vi.mocked(publishLiveEvent).mock.calls);
    expect(publishedEvents).toContain("heartbeat.run.event");
    for (const [family, key] of providerPrefixKeys) {
      expect(storedEvents, `persisted event/trace ${family}`).not.toContain(key);
      expect(publishedEvents, `live event/trace ${family}`).not.toContain(key);
    }
    expect(storedEvents).toContain(REDACTED_EVENT_VALUE);
    await saveEvidence("run-events-traces-live.json", { stored: events, published: vi.mocked(publishLiveEvent).mock.calls });
  }, 30_000);
});

describe("real production logger byte sink", () => {
  it("masks unregistered bare keys in messages, objects and serialized Error stacks", async () => {
    const script = `import { logger } from './src/middleware/logger.ts';
      const keys = JSON.parse(await new Promise(resolve => { let data = ''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => resolve(data)); }));
      for (const [family, key] of keys) logger.error({ family, nested: { detail: key }, err: new Error('upstream ' + key) }, 'provider returned ' + key);
      logger.flush();`;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../..", import.meta.url), input: JSON.stringify(providerPrefixKeys), encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "production" }, timeout: 15_000,
    });
    const rows = output.trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(providerPrefixKeys.length);
    for (const [family, key] of providerPrefixKeys) {
      expect(output, family).not.toContain(key);
      expect(rows.find(row => row.family === family)).toMatchObject({ msg: "provider returned [REDACTED]", nested: { detail: "[REDACTED]" }, err: { message: "upstream [REDACTED]" } });
    }
    await saveEvidence("production-logger.json", rows);
  });
});

describe("server event, trace and log string leaves", () => {
  it.each(providerPrefixKeys)("masks %s without relying on a secret field name or registration", (_family, key) => {
    const message = `upstream ${key}\nretry denied`;
    const payload = redactEventPayload({ message, nested: [message] });
    expect(payload).toEqual({ message: `upstream ${REDACTED_EVENT_VALUE}\nretry denied`, nested: [`upstream ${REDACTED_EVENT_VALUE}\nretry denied`] });
    // Username censorship is optional; credential redaction never is.
    expect(redactCurrentUserText(message, { enabled: false })).toBe(`upstream ${REDACTED_EVENT_VALUE}\nretry denied`);
  });
});
