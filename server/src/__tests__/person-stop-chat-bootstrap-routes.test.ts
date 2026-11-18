import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import {
  describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";
import { expect, it } from "vitest";

describeEmbeddedPostgres("person Stop on the real chat bootstrap path", () => {
  const ctx = useEmbeddedPostgres("person-stop-chat-bootstrap-");

  it.each([false, true])("preserves Stop attribution after a real message and Stop (conversation=%s)", async conversation => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Stop bootstrap");
    const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await ctx.db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Runner",
      adapterType: "paperclip_runner", status: "active" });
    await ctx.db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Stop this reply",
      status: "in_progress", assigneeAgentId: agentId, responsibleUserId: f.userId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: f.userId, conversationState: "active" } : {}) });
    // An in-flight native turn: no provider is launched by this route test.
    // The message and Stop below go through production HTTP handlers and storage.
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, issueId,
      nativeIssueId: issueId, nativeSessionId: randomUUID(), runtimeMode: "native", status: "running",
      responsibleUserId: f.userId, contextSnapshot: { issueId }, startedAt: new Date() });
    await ctx.db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId, runId, phase: "observed" });
    await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const app = routeApp(ctx.db, f.actor, issueRoutes, agentRoutes, activityRoutes);
    const sent = await request(app).post(`/api/issues/${issueId}/comments`)
      .send({ body: "Keep this follow-up saved", clientRequestId: randomUUID() }).expect(201);
    const stop = await request(app).post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({ cancellationRequestId: randomUUID() }).expect(200);
    expect(stop.body).toMatchObject({ id: runId, status: "cancelled" });
    const [stored] = await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stored!.resultJson).toMatchObject({ cancelledByActorType: "user", cancelledByUserId: f.userId });

    const single = await request(app).get(`/api/issues/${issueId}/chat-bootstrap`).expect(200);
    const batch = await request(app).get(`/api/companies/${f.companyId}/issues/chat-bootstrap`).query({ ids: issueId }).expect(200);
    const recent = await request(app).get(`/api/issues/${issueId}/runs?view=recent`).expect(200);
    expect(single.body.recentComments.comments).toEqual(expect.arrayContaining([expect.objectContaining({ id: sent.body.id })]));
    // Retain the actual route response for the production thread renderer,
    // rather than replacing it with a hand-authored linked-run fixture.
    console.log("PERSON_STOP_BOOTSTRAP", JSON.stringify({ conversation, ...single.body }));
    for (const rows of [single.body.recentRuns, batch.body.items[0].recentRuns, recent.body]) {
      expect(rows.find((run: { runId: string }) => run.runId === runId)).toMatchObject({
        status: "cancelled", runtimeMode: "native", resultJson: { cancelledByActorType: "user" },
      });
    }
  });
});
