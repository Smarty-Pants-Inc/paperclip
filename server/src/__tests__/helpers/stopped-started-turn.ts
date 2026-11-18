import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type createDb } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { agentRoutes } from "../../routes/agents.js";
import { appendHeartbeatRunEvent } from "../../services/heartbeat-run-events.js";

type Db = ReturnType<typeof createDb>;

/**
 * Fixture (S8 c3, RFL ruling 11-18 05:02Z): an earlier native turn that carried
 * `own` as its own input, had STARTED answering it the way the executor records
 * it (a validated item.started userMessage, then the reply item; the same events
 * as s8c3-live-shape-order's F1b fixture), and was then STOPPED by DRIVING the
 * real Stop route, POST /heartbeat-runs/:runId/cancel (routes/agents.ts), as
 * `stopper`. No stop field of the run is hand-seeded: the route writes
 * cancelledByActorType and cancelledByUserId (a person) or cancelledByAgentId
 * (a managing agent), and cancelRun records the cancellation.
 */
export async function stopStartedTurn(db: Db, input: {
  companyId: string; agentId: string; issueId: string; own: string[]; wakeCommentId?: string;
  createdAt?: Date; startedAt?: Date;
  stopper?: { type: "user"; userId: string } | { type: "agent"; agentId: string };
}): Promise<string> {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({ id, companyId: input.companyId, agentId: input.agentId, status: "running",
    runtimeMode: "native", nativeIssueId: input.issueId, invocationSource: "assignment", triggerDetail: "earlier turn",
    createdAt: input.createdAt ?? new Date(Date.now() - 250_000), startedAt: input.startedAt ?? new Date(Date.now() - 240_000),
    contextSnapshot: { issueId: input.issueId, ...(input.wakeCommentId ? { wakeCommentId: input.wakeCommentId } : {}),
      wakeCommentIds: input.own } });
  // The native turn's coordinator, as seedBusyChat records it for the busy turn.
  await db.insert(nativeRunFinalizations).values({ companyId: input.companyId, issueId: input.issueId, runId: id, phase: "observed" });
  // The executor's record, written through the real run-event writer (the native
  // control plane's appendHeartbeatRunEvent): it read the input, then began its reply.
  for (const [index, item] of [{ itemId: "u1", kind: "userMessage" }, { itemId: "a1", kind: "agentMessage" }].entries()) {
    const prpEvent = { schemaVersion: 1, sourceInstanceId: `runner-${id}`, sourceEventId: `stopped-${id}-${index + 1}`,
      sourceSeq: index + 1, eventType: "item.started", turnId: "t1", itemId: item.itemId, payload: { kind: item.kind } };
    await appendHeartbeatRunEvent(db as any, { companyId: input.companyId, runId: id, agentId: input.agentId,
      eventType: "item.started", stream: "system", level: "info", payload: { prpEvent },
      nativeSource: { sourceInstanceId: prpEvent.sourceInstanceId, sourceEventId: prpEvent.sourceEventId,
        sourceSeq: prpEvent.sourceSeq, protocolSchemaVersion: 1, canonicalPayload: prpEvent } });
  }
  const stopper = input.stopper ?? { type: "user", userId: "queue-owner" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = stopper.type === "user"
      ? { type: "board", source: "session", userId: stopper.userId, companyIds: [input.companyId],
        memberships: [{ companyId: input.companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false }
      : { type: "agent", agentId: stopper.agentId, companyId: input.companyId, source: "agent_key" };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  const stopped = await request(app).post(`/api/heartbeat-runs/${id}/cancel`).send({});
  if (stopped.status !== 200) throw new Error(`Stop route answered ${stopped.status}: ${JSON.stringify(stopped.body)}`);
  const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
  if (row?.status !== "cancelled") throw new Error(`Stop route left the run ${row?.status}`);
  return id;
}
