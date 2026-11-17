import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { decideRetryAuthority } from "./task-retry-eligibility.js";
import { AGENT_PAUSED_RETRY_MESSAGE, AUTOMATIC_RECOVERY_MESSAGE } from "./native-runtime/held-predecessor-notice-text.js";

// rf-3 A + judge R9: the card's fields come from the ONE Retry authority
// (decideRetryAuthority), not only its veto. Entry point:
// taskInterruptionPresentation, the card projection routes/issues.ts serves
// (GET /issues/:id `interruption:`, and the Retry answer's `presentation`).
// Agent shape: a Boat-remote pi_rpc agent with managed instructions (agent_files).
describe("retry fold 4: the card reads the one Retry authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("retry-fold4-card-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(input: { agentStatus?: string; continuation?: "pending" | "not_requested" }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Card", defaultResponsibleUserId: "board", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: input.agentStatus ?? "idle",
      adapterConfig: { provider: "pi_rpc", instructionsBundleMode: "managed" } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, title: "Daily work", status: "in_progress" }).returning();
    const recordedAt = new Date(Date.now() - 60_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      startedAt: new Date(recordedAt.getTime() - 120_000), finishedAt: new Date(recordedAt.getTime() - 90_000),
      errorCode: "native_restart_recovery_blocked", contextSnapshot: { issueId, executionTarget: { kind: "remote", transport: "sandbox", providerKey: "boat" } },
      resultJson: {} });
    if (input.continuation) {
      const freshContinuation = { schema: "paperclip.fresh-continuation.v1", sourceRunId: runId, trigger: "held_recovery",
        failureCode: "native_restart_recovery_blocked", delivery: "recorded", recordedAt: recordedAt.toISOString(),
        isolation: "remote_epoch", stopProof: "unproven_epoch_abandoned", unverifiedActions: [], createdObjects: [] };
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
        outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-continuation:${runId}`, nextAction: "Paperclip continues the task in a fresh run from its saved work.",
        resolvedAt: recordedAt, createdAt: recordedAt, updatedAt: recordedAt,
        evidence: { runId, freshContinuationSettlement: { schema: "paperclip.fresh-continuation.v1", sourceRunId: runId },
          freshContinuation, continuationDelivery: input.continuation } });
    }
    return { issue: issue! };
  }

  it("R9: while Paperclip continues the conversation by itself, the card carries the authority's automatic-recovery words and no Retry", async () => {
    const { issue } = await seed({ continuation: "pending" });
    const presentation = await taskInterruptionPresentation(db, issue);
    const authority = decideRetryAuthority({ automaticRecovery: true });
    expect(presentation).toMatchObject({ state: "working", canRetry: false,
      notice: { code: authority.reason, text: authority.cardText } });
    expect(presentation!.notice!.text).toBe(AUTOMATIC_RECOVERY_MESSAGE);
  });

  it("R9 guard (rf-3 E): a continuation recorded with no delivery request and no wake never says 'No action is needed'", async () => {
    const { issue } = await seed({ continuation: "not_requested" });
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(JSON.stringify(presentation)).not.toContain(AUTOMATIC_RECOVERY_MESSAGE);
  });

  it("rf-3 A: a failed run whose assignee is paused: canRetry, the resume action and the words all come from the authority", async () => {
    const { issue } = await seed({ agentStatus: "paused" });
    const presentation = await taskInterruptionPresentation(db, issue);
    const authority = decideRetryAuthority({ agentPaused: true, retrySource: true });
    expect(presentation).toMatchObject({ canRetry: authority.canRetry, userAction: authority.userAction,
      retryWait: { reason: authority.reason, message: authority.cardText } });
    expect(presentation!.retryWait!.message).toBe(AGENT_PAUSED_RETRY_MESSAGE);
  });
});
