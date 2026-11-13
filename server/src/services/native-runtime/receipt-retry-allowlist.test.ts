import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { TRANSACTION_RETRY_ATTEMPTS } from "../transaction-retry.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

// N1: #withMutationReceipt retries ONLY allowlisted DB-only receipt operations
// on 40P01/40001. Every other operation, including one nobody has listed yet,
// is attempted exactly once.
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("native receipt retry allowlist", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("receipt-retry-allowlist-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Receipt retry", issuePrefix: `Q${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry policy", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    // Reads pass through; every receipt transaction fails with a deadlock.
    const counter = { transactions: 0 };
    const deadlocking = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") return async () => {
          counter.transactions++;
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as Db;
    const authority = new PaperclipRunnerToolAuthority(deadlocking, { companyId, agentId, issueId, runId });
    return { authority, counter };
  }

  // recover() routes these through #withMutationReceipt(call.tool, key, input, null).
  it.each([
    ["an unlisted (new) operation", "future_receipt_mutation", 1],
    ["register_deliverable (object storage before commit)", "register_deliverable", 1],
    ["reuse_chat_attachment (object storage before commit)", "reuse_chat_attachment", 1],
    ["set_dependencies (allowlisted, DB-only)", "set_dependencies", TRANSACTION_RETRY_ATTEMPTS],
    ["report_progress (allowlisted, DB-only)", "report_progress", TRANSACTION_RETRY_ATTEMPTS],
  ] as const)("%s [%s]: 40P01 attempts the receipt transaction %i time(s)", async (_label, tool, expected) => {
    const f = await fixture();
    const outcome = await f.authority.recover({ tool, callId: randomUUID(), arguments: { idempotencyKey: `k-${randomUUID()}` } })
      .then(() => null, (error: unknown) => error as { code?: string });
    expect(outcome?.code).toBe("40P01");
    expect(f.counter.transactions).toBe(expected);
  }, 30_000);
});
