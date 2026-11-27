import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { buildExecutionContinuation } from "./execution-continuation.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_EXECUTION_CONTINUATION_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "authorized continuation context",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID(),
      runId = randomUUID();
    const gmailId = randomUUID(),
      notionId = randomUUID(),
      laterId = randomUUID(),
      interactionId = randomUUID();
    beforeAll(async () => {
      if (externalUrl) {
        await applyPendingMigrations(externalUrl);
        database = { connectionString: externalUrl, cleanup: async () => {} };
      } else database = await startEmbeddedPostgresTestDatabase(
        "paperclip-continuation-context-",
      );
      db = createDb(database.connectionString);
      await db
        .insert(companies)
        .values({ id: companyId, name: "Continuation", issuePrefix: `CTX${companyId.replaceAll("-", "")}` });
      await db
        .insert(agents)
        .values({
          id: agentId,
          companyId,
          name: "Executor",
          role: "engineer",
          adapterType: "paperclip_runner",
        });
      await db
        .insert(issues)
        .values({
          id: issueId,
          companyId,
          title: "Read Notion",
          status: "in_progress",
          assigneeAgentId: agentId,
        });
      await db
        .insert(heartbeatRuns)
        .values({
          id: runId,
          companyId,
          agentId,
          status: "failed",
          contextSnapshot: { issueId, commentId: gmailId },
        });
      await db.insert(issueComments).values([
        {
          id: notionId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "local-board",
          body: "Read my Notion launch notes.",
          createdAt: new Date("2026-09-08T10:00:00Z"),
        },
        {
          id: gmailId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "local-board",
          body: "Now summarize my recent Gmail emails.",
          createdAt: new Date("2026-09-08T10:01:00Z"),
        },
        {
          id: laterId,
          companyId,
          issueId,
          authorType: "user",
          authorUserId: "another-user",
          body: "Focus the Gmail summary on launch decisions.",
          createdAt: new Date("2026-09-08T10:02:00Z"),
        },
      ]);
      await db
        .insert(issueThreadInteractions)
        .values({
          id: interactionId,
          companyId,
          issueId,
          kind: "connection_intent",
          status: "accepted",
          sourceRunId: runId,
          originCommentIds: [gmailId],
          payload: {
            version: 1,
            serviceSlug: "gmail",
            serviceName: "Gmail",
            serviceLogoUrl: null,
            requestingAgentId: agentId,
            requestingAgentName: "Executor",
            phase: "requested",
          },
          result: {
            version: 1,
            outcome: "connected",
            connectionId: randomUUID(),
          },
        });
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    });
    const build = () =>
      buildExecutionContinuation({
        db,
        companyId,
        issueId,
        agentId,
        context: { interactionId, wakeReason: "connection_intent.resolved" },
        summary: "Notion read completed.",
        exposeLowTrustRaw: false,
      });

    it("marks only the fresh-session system notice with the writer's stored provenance", async () => {
      const marker = {
        companyId,
        issueId,
        authorType: "system" as const,
        authorAgentId: null,
        authorUserId: null,
        createdByRunId: null,
        conversationSessionGeneration: 1,
        body: "New session · Earlier messages and files are still available.",
        presentation: { kind: "system_notice" as const, tone: "neutral" as const, detailsDefaultOpen: false },
        metadata: { version: 1 as const, sourceRunId: runId, sections: [] },
        createdAt: new Date("2026-09-08T10:03:00Z"),
      };
      const markerId = randomUUID();
      const withoutGenerationId = randomUUID();
      const withoutSourceRunId = randomUUID();
      const withoutPresentationId = randomUUID();
      const boardAuthoredId = randomUUID();
      const ids = [markerId, withoutGenerationId, withoutSourceRunId, withoutPresentationId, boardAuthoredId];
      await db.insert(issueComments).values([
        { ...marker, id: markerId },
        { ...marker, id: withoutGenerationId, conversationSessionGeneration: null },
        { ...marker, id: withoutSourceRunId, metadata: { version: 1, sections: [] } },
        { ...marker, id: withoutPresentationId, presentation: null },
        { ...marker, id: boardAuthoredId, authorType: "user", authorUserId: "board-user" },
      ]);
      try {
        const envelope = await build();
        expect(envelope.messages.find(message => message.id === markerId)).toMatchObject({
          id: markerId, authorType: "system", authorId: null, freshSessionMarker: true,
        });
        for (const id of ids.slice(1)) {
          const message = envelope.messages.find(message => message.id === id);
          expect(message).toMatchObject(id === boardAuthoredId
            ? { id, authorType: "user", authorId: "board-user", body: marker.body }
            : { id, authorType: "system", authorId: null, body: marker.body });
          expect(message).not.toHaveProperty("freshSessionMarker");
        }
      } finally {
        for (const id of ids) await db.delete(issueComments).where(eq(issueComments.id, id));
      }
    });

  },
);
