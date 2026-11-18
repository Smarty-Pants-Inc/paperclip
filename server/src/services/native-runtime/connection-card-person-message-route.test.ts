import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, closeRegisteredClients, companies, createDb, heartbeatRuns,
  issueThreadInteractions, issues,
} from "@paperclipai/db";
import type { NativeExecutionInput } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { heartbeatService } from "../heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../heartbeat/run-admission.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { pendingGovernedWaitCondition } from "./native-session-executor.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// Route-driven: the person's message goes through the real comment route as a
// board user, and the real wake path admits run B and writes its context
// snapshot. Run admission is closed (as in c9-restore-twin) so run B stays
// queued: no provider is started and nothing is written to run B by hand.
describeEmbeddedPostgres("a pending connection card and the person's next message (comment route)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db!: ReturnType<typeof createDb>;
  const userId = `conn-card-board-${randomUUID()}`;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-conn-card-route-");
    db = createDb(temporary.connectionString);
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    if (temporary) await closeRegisteredClients(temporary.connectionString);
    await temporary?.cleanup();
    resetProcessRunAdmissionForTests();
  });

  function appForBoard() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("R5 a message POSTed to the comment route while a card is pending: its woken run is not parked", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runA = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Conn card route", requireBoardApprovalForNewAgents: false,
      issuePrefix: `R${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runA, companyId, agentId, status: "succeeded", responsibleUserId: userId,
      contextSnapshot: { issueId }, finishedAt: new Date() });
    // Run A raised the Connect GitHub card through the real service.
    const card = await issueThreadInteractionService(db).createConnectionIntent({ id: issueId, companyId }, {
      payload: { version: 1, serviceSlug: "github", serviceName: "GitHub", serviceLogoUrl: null, requestingAgentId: agentId, requestingAgentName: "Chat", phase: "requested" },
      sourceRunId: runA, addresseeUserId: userId, idempotencyKey: `connection-intent:${runA}:github`,
    });
    expect(card).toMatchObject({ kind: "connection_intent", status: "pending" });

    // The person's next message, over HTTP through the real comment route.
    const posted = await request(appForBoard()).post(`/api/issues/${issueId}/comments`)
      .send({ body: "What is the status of r2?" }).expect(201);
    const commentId = posted.body.id as string;

    // The route wakes the assignee after responding; wait for the real wake path
    // to admit run B with this comment in its snapshot.
    const wake = await vi.waitFor(async () => {
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      const found = wakes.find(w => w.runId && JSON.stringify(w.payload ?? {}).includes(commentId));
      expect(found, `comment route wakes: ${JSON.stringify(wakes.map(w => ({ reason: w.reason, status: w.status, runId: w.runId, payload: w.payload })))}`).toBeDefined();
      return found!;
    }, { timeout: 20_000, interval: 100 });
    const [runB] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
    expect(runB).toMatchObject({ agentId, status: "queued" });
    expect(runB!.id).not.toBe(runA);
    expect((runB!.contextSnapshot as Record<string, unknown>).wakeCommentIds).toContain(commentId);

    const parks = async (runId: string) => (await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(pendingGovernedWaitCondition({ binding: { companyId, issueId, agentId, runId }, interactionResponses: [] } as unknown as NativeExecutionInput)))[0]?.id ?? null;
    expect(await parks(runB!.id)).toBeNull();
    // The run that raised the card still parks on it.
    expect(await parks(runA)).toBe(card.id);
    process.stderr.write(`R5 evidence ${JSON.stringify({ commentId, wakeId: wake.id, wakeReason: wake.reason, wakeStatus: wake.status,
      runA, runB: runB!.id, runBStatus: runB!.status, runBContext: runB!.contextSnapshot, cardId: card.id })}\n`);
  });
});
