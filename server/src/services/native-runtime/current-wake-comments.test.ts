import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  type Db,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";

import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import {
  assertCurrentWakeCommentsRead,
  readCurrentWakeComments,
  resolveCurrentWakeCommentsBinding,
} from "./current-wake-comments.js";
import { buildPaperclipTaskMarkdown } from "../heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping current wake comment reader tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describeEmbeddedPostgres("current external-chat wake comment reader", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "paperclip-current-wake-comments-",
    );
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seed(input: {
    bodies: string[];
    fallbackFetchNeeded?: boolean;
    attachmentOmissionReasons?: Record<string, number>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `W${companyId.replaceAll("-", "").slice(0, 6)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "local-board",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chat agent",
      role: "engineer",
      status: "running",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External chat",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "local-board",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const comments = await db
      .insert(issueComments)
      .values(
        input.bodies.map((body) => ({
          companyId,
          issueId,
          authorType: "user" as const,
          authorUserId: "local-board",
          body,
        })),
      )
      .returning();
    const commentIds = comments.map((comment) => comment.id);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "native",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        paperclipWake: {
          reason: "External chat message received",
          externalChatProvider: "slack",
          checkedOutByHarness: true,
          fallbackFetchNeeded: input.fallbackFetchNeeded ?? true,
          commentIds,
          latestCommentId: commentIds.at(-1),
          commentWindow: {
            requestedCount: commentIds.length,
            includedCount: Math.min(commentIds.length, 8),
            missingCount: Math.max(0, commentIds.length - 8),
          },
          ...(input.attachmentOmissionReasons
            ? {
                attachmentOmissions: [
                  {
                    commentId: commentIds[0],
                    reasons: input.attachmentOmissionReasons,
                  },
                ],
              }
            : {}),
        },
      },
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "chat-agent",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId, comments, commentIds };
  }

  async function seedAddressedParticipant() {
    const task = await seed({ bodies: ["The board created this confirmation."] });
    const resolverAgentId = randomUUID();
    const interactionId = randomUUID();
    const responseRunId = randomUUID();
    await db.insert(agents).values({
      id: resolverAgentId,
      companyId: task.companyId,
      name: "KP card resolver",
      role: "engineer",
      status: "running",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: task.companyId,
      issueId: task.issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
      requestedResolverPolicy: "not_creator",
      effectiveResolverPolicy: "not_creator",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      sourceRunId: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      addresseeAgentId: resolverAgentId,
      addresseeUserId: null,
      payload: { version: 1, prompt: "Approve the board's bounded request?" },
    });
    await db.insert(heartbeatRuns).values({
      id: responseRunId,
      companyId: task.companyId,
      agentId: resolverAgentId,
      nativeIssueId: task.issueId,
      invocationSource: "automation",
      triggerDetail: "system",
      runtimeMode: "native",
      status: "running",
      contextSnapshot: {
        issueId: task.issueId,
        taskId: task.issueId,
        wakeReason: "interaction_pending",
        interactionId,
        interactionIds: [interactionId],
      },
    });
    return { ...task, resolverAgentId, responseRunId, interactionId };
  }

  const responseResult: PrpStructuredRunResult = {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: "The addressed confirmation response was recorded.",
    completionClaim: {
      contractRevision: "test",
      objectiveSatisfied: false,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
  };

  const pendingBlockerResult: PrpStructuredRunResult = {
    ...responseResult,
    reportedWorkDisposition: "blocked",
    summary: "The addressed board confirmation is still pending.",
    completionClaim: {
      ...responseResult.completionClaim,
      objectiveSatisfied: false,
      remainingWork: [
        { description: "Wait for the board decision", blocksCompletion: true },
      ],
    },
    blocker: {
      reasonCode: "missing_access",
      owner: { kind: "user", name: "Board operator" },
      scope: "task_wide",
      unblockAction: "Resolve the addressed confirmation",
    },
  };

  it("exposes no reader for an inline-complete wake", async () => {
    const seeded = await seed({
      bodies: ["One complete request"],
      fallbackFetchNeeded: false,
    });
    await expect(
      resolveCurrentWakeCommentsBinding(db, seeded),
    ).resolves.toBeNull();
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    const newlyTruncated = await seed({
      bodies: ["A newly bound overflow request"],
      fallbackFetchNeeded: true,
    });
    await expect(
      assertCurrentWakeCommentsRead(db, newlyTruncated, null),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  it("pages every exact accepted comment in order and excludes task history outside the wake", async () => {
    const bodies = Array.from(
      { length: 10 },
      (_, index) => `${index + 1}:${String(index).repeat(4_500)}`,
    );
    const seeded = await seed({ bodies });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "user",
      authorUserId: "local-board",
      body: "This older task-history comment is not part of the accepted wake.",
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    expect(binding?.commentIds).toEqual(seeded.commentIds);
    if (!binding) throw new Error("Expected a current wake reader binding");

    await expect(
      readCurrentWakeComments(db, binding, { cursor: "forged" }),
    ).rejects.toThrow("paperclip_current_wake_comments_cursor_out_of_order");

    let cursor: string | null = null;
    const reconstructed = new Map<string, string>();
    let pageCount = 0;
    while (true) {
      const page = await readCurrentWakeComments(db, binding, { cursor });
      pageCount += 1;
      expect(page.requestedCount).toBe(seeded.commentIds.length);
      for (const chunk of page.comments) {
        reconstructed.set(
          chunk.id,
          `${reconstructed.get(chunk.id) ?? ""}${chunk.bodyChunk}`,
        );
      }
      if (page.complete) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
    }

    expect(pageCount).toBeGreaterThan(1);
    expect([...reconstructed.keys()]).toEqual(seeded.commentIds);
    expect([...reconstructed.values()]).toEqual(bodies);
    expect(
      [...reconstructed.values()].some((body) =>
        body.includes("older task-history comment"),
      ),
    ).toBe(false);
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );
  });

  it("requires ordered pages and fails the completion fence after a comment changes", async () => {
    const seeded = await seed({
      bodies: [`first:${"a".repeat(20_000)}`, "second"],
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    if (!binding) throw new Error("Expected a current wake reader binding");

    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_unread",
    );
    const first = await readCurrentWakeComments(db, binding, {});
    expect(first.complete).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_unread",
    );

    const replay = await readCurrentWakeComments(db, binding, {});
    expect(replay).toEqual(first);
    await db
      .update(issueComments)
      .set({ body: "edited after the first page" })
      .where(eq(issueComments.id, seeded.commentIds[0]!));
    await expect(
      readCurrentWakeComments(db, binding, { cursor: first.nextCursor }),
    ).rejects.toThrow("paperclip_current_wake_comments_snapshot_changed");

    const restarted = await readCurrentWakeComments(db, binding, {});
    expect(restarted.snapshotDigest).not.toBe(first.snapshotDigest);
    let page = restarted;
    while (!page.complete) {
      page = await readCurrentWakeComments(db, binding, {
        cursor: page.nextCursor,
      });
    }
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    await db
      .update(issueComments)
      .set({ body: "edited again after the complete read" })
      .where(eq(issueComments.id, seeded.commentIds[1]!));
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_changed_after_read",
    );
  });

  it("surfaces closed attachment omissions and fences their exact snapshot", async () => {
    const seeded = await seed({
      bodies: ["Inspect every current attachment"],
      attachmentOmissionReasons: {
        unsupported_type: 1,
        processing_failed: 1,
        credential_token: 20,
      },
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    expect(binding?.attachmentOmissions).toEqual([
      {
        commentId: seeded.commentIds[0],
        reasons: { unsupported_type: 1, processing_failed: 1 },
      },
    ]);
    if (!binding) throw new Error("Expected a current wake reader binding");

    const page = await readCurrentWakeComments(db, binding, {});
    expect(page.complete).toBe(true);
    expect(page.comments[0]?.attachmentImportNotice).toBe(
      "Paperclip could not import every attachment from this exact external message: 2 attachments were omitted (unsupported type: 1, processing failed: 1). Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.",
    );
    expect(JSON.stringify(page)).not.toContain("credential_token");
    expect(
      buildPaperclipTaskMarkdown({
        issue: {
          id: seeded.issueId,
          identifier: "WAKE-1",
          title: "Inspect the current files",
        },
        wakeComments: [
          {
            id: seeded.commentIds[0]!,
            body: "Inspect every current attachment",
          },
        ],
        attachmentOmissions: [
          {
            commentId: seeded.commentIds[0]!,
            notice: page.comments[0]!.attachmentImportNotice!,
          },
        ],
        externalChatProvider: "discord",
        nativeRunner: true,
      }),
    ).toContain(
      "Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.",
    );
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const contextSnapshot = structuredClone(
      run!.contextSnapshot as Record<string, unknown>,
    );
    const wake = contextSnapshot.paperclipWake as Record<string, unknown>;
    wake.attachmentOmissions = [
      {
        commentId: seeded.commentIds[0],
        reasons: { unsupported_type: 2 },
      },
    ];
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_changed_after_read",
    );
  });

  it("rejects a coalesced comment that arrives between binding resolution and the terminal row lock", async () => {
    const seeded = await seed({ bodies: ["first accepted request"] });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    if (!binding) throw new Error("Expected a current wake reader binding");
    await expect(
      readCurrentWakeComments(db, binding, {}),
    ).resolves.toMatchObject({ complete: true });

    const [coalesced] = await db
      .insert(issueComments)
      .values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorType: "user",
        authorUserId: "local-board",
        body: "second request accepted during finalization",
      })
      .returning();
    let injected = false;
    const racingDb = Object.create(db) as ReturnType<typeof createDb>;
    Object.defineProperty(racingDb, "transaction", {
      configurable: true,
      value: async <T>(operation: (tx: Db) => Promise<T>) => {
        if (!injected) {
          injected = true;
          const commentIds = [...seeded.commentIds, coalesced!.id];
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: {
                issueId: seeded.issueId,
                taskId: seeded.issueId,
                paperclipWake: {
                  reason: "External chat message received",
                  externalChatProvider: "slack",
                  checkedOutByHarness: true,
                  fallbackFetchNeeded: true,
                  commentIds,
                  latestCommentId: coalesced!.id,
                  commentWindow: {
                    requestedCount: commentIds.length,
                    includedCount: 1,
                    missingCount: 1,
                  },
                },
              },
            })
            .where(eq(heartbeatRuns.id, seeded.runId));
        }
        return db.transaction((tx) => operation(tx as unknown as Db));
      },
    });

    await expect(
      assertCurrentWakeCommentsRead(racingDb, seeded, binding),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  it.each(["accepted", "rejected"] as const)(
    "allows only its exact %s board confirmation to cross the terminal fence",
    async (status) => {
      const value = await seedAddressedParticipant();
      await db
        .update(issueThreadInteractions)
        .set({
          status,
          resolvedByAgentId: value.resolverAgentId,
          resolvedByRunId: value.responseRunId,
          resolvedAt: new Date(),
          result: { version: 1, outcome: status },
        })
        .where(eq(issueThreadInteractions.id, value.interactionId));
      const binding = {
        companyId: value.companyId,
        issueId: value.issueId,
        agentId: value.resolverAgentId,
        runId: value.responseRunId,
      };

      await expect(
        assertCurrentWakeCommentsRead(db, binding, null),
      ).rejects.toThrow("native_current_wake_comments_binding_changed");
      await expect(
        assertCurrentWakeCommentsRead(db, binding, null, responseResult),
      ).resolves.toBeUndefined();
      const [task] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, value.issueId));
      expect(task).toMatchObject({
        status: "in_progress",
        assigneeAgentId: value.agentId,
        executionRunId: value.runId,
      });
    },
  );

  it("allows an exact pending participant only to finish an explicit blocked response turn", async () => {
    const value = await seedAddressedParticipant();
    await expect(
      assertCurrentWakeCommentsRead(
        db,
        {
          companyId: value.companyId,
          issueId: value.issueId,
          agentId: value.resolverAgentId,
          runId: value.responseRunId,
        },
        null,
        pendingBlockerResult,
      ),
    ).resolves.toBeUndefined();
    const [card] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, value.interactionId));
    expect(card).toMatchObject({ status: "pending", resolvedByRunId: null });
  });

  it("denies a pending done report and any participant continuation", async () => {
    const value = await seedAddressedParticipant();
    const binding = {
      companyId: value.companyId,
      issueId: value.issueId,
      agentId: value.resolverAgentId,
      runId: value.responseRunId,
    };
    await expect(
      assertCurrentWakeCommentsRead(db, binding, null, responseResult),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
    await expect(
      assertCurrentWakeCommentsRead(db, binding, null, {
        ...pendingBlockerResult,
        continuation: {
          kind: "response_wake",
          idempotencyKey: "participant-wait",
          summary: "Wait for the board decision",
        },
      }),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  it.each(["agent", "run"] as const)(
    "denies an accepted card attributed to another %s",
    async (mismatch) => {
      const value = await seedAddressedParticipant();
      await db
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          resolvedByAgentId:
            mismatch === "agent" ? value.agentId : value.resolverAgentId,
          resolvedByRunId:
            mismatch === "run" ? value.runId : value.responseRunId,
          resolvedAt: new Date(),
          result: { version: 1, outcome: "accepted" },
        })
        .where(eq(issueThreadInteractions.id, value.interactionId));
      await expect(
        assertCurrentWakeCommentsRead(
          db,
          {
            companyId: value.companyId,
            issueId: value.issueId,
            agentId: value.resolverAgentId,
            runId: value.responseRunId,
          },
          null,
          responseResult,
        ),
      ).rejects.toThrow("native_current_wake_comments_binding_changed");
    },
  );

  it.each(["cancelled", "stale primary wake"] as const)(
    "denies a %s addressed card at terminal settlement",
    async (state) => {
      const value = await seedAddressedParticipant();
      if (state === "cancelled") {
        await db
          .update(issueThreadInteractions)
          .set({ status: "cancelled" })
          .where(eq(issueThreadInteractions.id, value.interactionId));
      } else {
        const [run] = await db
          .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, value.responseRunId));
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: {
              ...(run!.contextSnapshot as Record<string, unknown>),
              interactionId: randomUUID(),
            },
          })
          .where(eq(heartbeatRuns.id, value.responseRunId));
      }
      await expect(
        assertCurrentWakeCommentsRead(
          db,
          {
            companyId: value.companyId,
            issueId: value.issueId,
            agentId: value.resolverAgentId,
            runId: value.responseRunId,
          },
          null,
          pendingBlockerResult,
        ),
      ).rejects.toThrow("native_current_wake_comments_binding_changed");
    },
  );

  it("denies a participant card moved to another task", async () => {
    const value = await seedAddressedParticipant();
    const [otherTask] = await db
      .insert(issues)
      .values({
        companyId: value.companyId,
        title: "Different task",
        status: "in_progress",
      })
      .returning();
    if (!otherTask) throw new Error("Expected a second task fixture");
    await db
      .update(issueThreadInteractions)
      .set({ issueId: otherTask.id })
      .where(eq(issueThreadInteractions.id, value.interactionId));
    await expect(
      assertCurrentWakeCommentsRead(
        db,
        {
          companyId: value.companyId,
          issueId: value.issueId,
          agentId: value.resolverAgentId,
          runId: value.responseRunId,
        },
        null,
        pendingBlockerResult,
      ),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  it("does not let terminal participant evidence bypass a non-null owner reader binding", async () => {
    const value = await seedAddressedParticipant();
    const ownerBinding = await resolveCurrentWakeCommentsBinding(db, value);
    if (!ownerBinding) throw new Error("Expected the KA current-wake reader binding");
    await db
      .update(issueThreadInteractions)
      .set({
        status: "accepted",
        resolvedByAgentId: value.resolverAgentId,
        resolvedByRunId: value.responseRunId,
        resolvedAt: new Date(),
        result: { version: 1, outcome: "accepted" },
      })
      .where(eq(issueThreadInteractions.id, value.interactionId));
    await expect(
      assertCurrentWakeCommentsRead(
        db,
        {
          companyId: value.companyId,
          issueId: value.issueId,
          agentId: value.resolverAgentId,
          runId: value.responseRunId,
        },
        ownerBinding,
        responseResult,
      ),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });
});
