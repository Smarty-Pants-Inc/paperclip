import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, agentWakeupRequests, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { drainCommentIngressTimings } from "../services/comment-ingress-timing.js";
import { buildNativeWakeIngressSpan, createNativeRunTrace, nativeRunPreparationStarts } from "../services/native-runtime/native-run-trace.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("comment ingress real HTTP and PG", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const owner = `ingress-owner-${randomUUID()}`;
  const captured = new Map<string, { query: string; parameters: unknown[] }>();
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-ingress-");
    db = createDb(tempDb.connectionString);
    if (process.env.INGRESS_EXPLAIN) (db.$client.options as any).debug = (_connection: number, query: string, parameters: unknown[]) => {
      if (/^select /i.test(query) && query.includes("issue_comments") && query.length > 5_000) captured.set(query, { query, parameters });
    };
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(authUsers).values({ id: owner, name: "Ingress owner", email: `${owner}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    // Stop exactly at the assigned boundary: the real queue still admits the run,
    // but execution/preparation (including credentials and providers) is out of scope.
    startTaskDrain({ ttlMs: null });
  }, 120_000);
  afterAll(async () => {
    stopTaskDrain();
    await db?.$client.end();
    await tempDb?.cleanup();
  });
  for (const managed of [false, true]) it(`n=20 ${managed ? "managed GitHub" : "ordinary"}`, async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ingress timing", issuePrefix: `IG${Math.floor(Math.random()*1e8)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ingress agent", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", ...(managed ? { githubAuthenticationMode: "managed" } : { githubAuthenticationMode: "agent_env" }) } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "operator" });
    await ensureHumanRoleDefaultGrants(db, { companyId, principalId: owner, membershipRole: "operator", grantedByUserId: null });
    const issue = await issueService(db).create(companyId, { title: "Conversation", conversationAgentId: agentId, conversationUserId: owner, assigneeAgentId: agentId, status: "in_review", conversationState: "waiting" });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId: owner, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false }; next(); });
    app.use("/api", issueRoutes(db, {} as any, {})); app.use(errorHandler);
    const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const rows: unknown[] = [];
    try {
      for (let i=0; i<21; i++) {
        const started = Date.now();
        const response = await fetch(`${url}/api/issues/${issue.id}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: `Daily follow-up ${i}: please continue`, clientRequestId: randomUUID() }) });
        const comment = await response.json() as { id: string; createdAt: string };
        const respondedAt = Date.now();
        expect(response.status, JSON.stringify(comment)).toBe(201);
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${comment.id}`));
        expect(run, JSON.stringify(comment)).toBeTruthy();
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
        // Exercise S1's actual builder, not a substitute timestamp metric.
        // One saved message must be the complete accepted input for this run.
        expect(run!.contextSnapshot?.wakeCommentIds).toEqual([comment.id]);
        const ingress = buildNativeWakeIngressSpan({ runCreatedAtMs: run!.createdAt.getTime(),
          wakeComments: [comment], attestedQuestionResponseAtMs: null });
        expect(ingress).toMatchObject({ name: "comment.to_run_created", startedAtMs: Date.parse(comment.createdAt),
          endedAtMs: run!.createdAt.getTime() });
        const spans = [ingress!, ...drainCommentIngressTimings([comment.id])];
        if (process.env.INGRESS_LABEL !== "baseline") {
          expect(spans.map(span => span.name)).toEqual(expect.arrayContaining(["comment.to_run_inserted", "comment.ingress.outbox.owed_comments", "comment.ingress.queue.wake_insert", "comment.ingress.queue.run_insert"]));
          expect(nativeRunPreparationStarts(spans, Date.now()).preparationStartedAtMs).toBeGreaterThanOrEqual(Math.max(...spans.map(span => span.endedAtMs)));
        }
        const events: unknown[] = [];
        const trace = createNativeRunTrace({ runId: run!.id, startedAtMs: Date.parse(comment.createdAt), onEvent: async event => { events.push(event); } });
        for (const span of spans) await trace.record(span);
        await trace.finish("ok");
        rows.push({ iteration: i, priming: i===0, managed, commentId: comment.id, runId: run!.id, commentCreatedAt: comment.createdAt, spans, events,
          wakeRequestedAt: wake!.requestedAt, runCreatedAt: run!.createdAt, httpMs: respondedAt-started,
          commentToRunMs: run!.createdAt.getTime()-Date.parse(comment.createdAt) });
        // Persisted history between warm follow-ups, without running anything
        // beyond run creation. There is deliberately no provider/model fixture.
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
        await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, wake!.id));
        await db.update(issues).set({ executionRunId: null, conversationState: "waiting" }).where(eq(issues.id, issue.id));
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `ingress-${managed ? "managed" : "ordinary"}-${process.env.INGRESS_LABEL ?? "baseline"}.json`), JSON.stringify({ url, revision: process.env.INGRESS_REVISION ?? "not supplied", node: process.version,
        preparedStatements: db.$client.options.prepare, primingRequests: 1, measuredRequests: 20,
        boundary: "real HTTP/route/embedded PostgreSQL; dispatch withheld after run create; providers not called",
        fixtureLimit: "synthetic company and fresh database, not Paul's daily org; GitHub mode configured without provisioning credentials",
        rows }, null, 2));
      if (process.env.TASK_OUT && process.env.INGRESS_EXPLAIN) {
        (db.$client.options as any).debug = false;
        const plans: unknown[] = [];
        for (const {query, parameters} of captured.values()) plans.push({ query, plan: await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${query}`, parameters as never[]) });
        const settings = await db.execute(sql`select name, setting from pg_settings where name in ('jit', 'jit_above_cost', 'jit_inline_above_cost', 'jit_optimize_above_cost', 'plan_cache_mode') order by name`);
        await writeFile(join(process.env.TASK_OUT, `plans-${managed ? "managed" : "ordinary"}-${process.env.INGRESS_LABEL}.json`), JSON.stringify({ settings, plans }, null, 2));
      }
    }
  }, 180_000);
});
