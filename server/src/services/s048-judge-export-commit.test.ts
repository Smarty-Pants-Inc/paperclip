import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { finishCancelledWarmWorkspaceExport } from "./heartbeat/cancelled-warm-workspace-export.js";
import { registerCleanupSettledResumer, resetCleanupSettledWakesForTest } from "./native-runtime/cleanup-settled-wake.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("S048 judge: export wake must follow a committed finalization mark", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s048-judge-export-commit-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it("does NOT wake when the finalization mark write fails before commit", async () => {
    resetCleanupSettledWakesForTest();
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "commit failure", issuePrefix: `J${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "commit failure", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "cancelled",
      finishedAt: new Date(), contextSnapshot: { issueId },
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board", executionCancellation: { state: "acknowledged" }, nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId,
        scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: new Date().toISOString() } },
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeRetainedIdleCheckpoint: {
        schema: "paperclip.native-retained-idle-checkpoint.v1", runId, companyId, issueId,
      } } });
    let rejectedMarkWrites = 0;
    const originalUpdate = db.update.bind(db);
    const failingMarkUpdate = vi.spyOn(db, "update").mockImplementation(((...args: Parameters<typeof db.update>) => {
        const builder = originalUpdate(...args);
        const set = builder.set.bind(builder);
        builder.set = ((values: Parameters<typeof set>[0]) => {
          const chunks = (values as { runnerProfileJson?: { queryChunks?: unknown[] } }).runnerProfileJson?.queryChunks ?? [];
          if (chunks.some(chunk => typeof chunk === "string" && chunk.includes("nativeCancelledWarmExport"))) {
            rejectedMarkWrites++;
            throw new Error("judge injected finalization-mark write failure");
          }
          return set(values);
        }) as typeof builder.set;
        return builder;
    }) as typeof db.update);
    const seen: unknown[] = [];
    const unregister = registerCleanupSettledResumer(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      seen.push(row?.runnerProfileJson?.nativeCancelledWarmExport ?? null);
    });
    try {
      const reference = { state: "prepared" };
      await finishCancelledWarmWorkspaceExport({ db, companyId, runId,
        nativeWorkspaceSync: { reference, restoreWorkspace: async () => { reference.state = "finalized"; } } });
      expect(rejectedMarkWrites).toBe(1);
      expect(reference.state).toBe("finalized");
      expect(seen).toEqual([]);
    } finally { unregister(); failingMarkUpdate.mockRestore(); }
  }, 30_000);
});
