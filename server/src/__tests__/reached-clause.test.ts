import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { answeredPersonMessageIds } from "../services/person-message-answer.js";
import { interruptedTurnUnansweredCommentIds } from "../services/interrupted-turn-input.js";
import { unansweredPersonMessageCommentCondition } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// RFL 08:41Z ruling (reached clause): a LATER reply answers an EARLIER person
// message ONLY if that earlier message reached the agent (it was in some run's
// input). A message held and never carried stays OWED: the sweep's discovery
// still lists it and the Interrupt's carry still carries it. Real Postgres.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("reached clause: a never-carried message is never answered by a later reply", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("reached-clause-"); db = createDb(pg.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await pg?.cleanup(); });

  async function seed(opts: { originImport?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const t = Date.now() - 60_000;
    await db.insert(companies).values({ id: companyId, name: "Reached", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reached", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Reached", status: "in_progress", assigneeAgentId: agentId });
    const m1 = randomUUID(), m2 = randomUUID();
    await db.insert(issueComments).values({ id: m1, companyId, issueId, authorType: "user", body: "M1 (held)", createdAt: new Date(t),
      ...(opts.originImport ? { origin: "import" } : {}) });
    await db.insert(issueComments).values({ id: m2, companyId, issueId, authorType: "user", body: "M2", createdAt: new Date(t + 1000) });
    const run = async (contextSnapshot: Record<string, unknown>, at: number, status = "succeeded") => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, status, startedAt: new Date(at), finishedAt: new Date(at + 500),
        nativeIssueId: issueId, contextSnapshot: { issueId, ...contextSnapshot } });
      return id;
    };
    const reply = async (runId: string, at: number) => {
      await db.insert(issueComments).values({ companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: runId,
        body: "Answer", createdAt: new Date(at) });
    };
    const owed = async () => (await db.select({ id: issueComments.id }).from(issueComments).where(and(
      inArray(issueComments.id, [m1, m2]), unansweredPersonMessageCommentCondition()))).map(r => r.id);
    return { companyId, agentId, issueId, m1, m2, t, run, reply, owed };
  }

  it("row 1: M1 held and never carried, M2 sent and answered => M1 still OWED (sweep lists it; the Interrupt carries it)", async () => {
    const f = await seed();
    const r2 = await f.run({ wakeCommentId: f.m2, wakeCommentIds: [f.m2] }, f.t + 2000);
    await f.reply(r2, f.t + 3000);
    expect([...await answeredPersonMessageIds(db, { ...f, commentIds: [f.m1, f.m2] })]).toEqual([f.m2]);
    expect(await f.owed()).toEqual([f.m1]);
    // The Interrupt's carry of a turn that listed M1 (e.g. a held input copied into its context) keeps M1.
    expect(await interruptedTurnUnansweredCommentIds(db, { ...f,
      run: { id: randomUUID(), contextSnapshot: { wakeCommentIds: [f.m1] } }, held: [] })).toEqual([f.m1]);
  });

  it("row 2: M1 carried (a run's input), then a later reply to M2 => M1 answered", async () => {
    const f = await seed();
    await f.run({ wakeCommentId: f.m1 }, f.t + 500, "succeeded");
    const r2 = await f.run({ wakeCommentId: f.m2, wakeCommentIds: [f.m2] }, f.t + 2000);
    await f.reply(r2, f.t + 3000);
    expect(new Set(await answeredPersonMessageIds(db, { ...f, commentIds: [f.m1, f.m2] }))).toEqual(new Set([f.m1, f.m2]));
    expect(await f.owed()).toEqual([]);
  });

  it("row 2b: M1 reached only as context.commentId => answered by the later reply", async () => {
    const f = await seed();
    await f.run({ commentId: f.m1 }, f.t + 500, "succeeded");
    const r2 = await f.run({ wakeCommentIds: [f.m2] }, f.t + 2000);
    await f.reply(r2, f.t + 3000);
    expect(new Set(await answeredPersonMessageIds(db, { ...f, commentIds: [f.m1, f.m2] }))).toEqual(new Set([f.m1, f.m2]));
  });

  it("row 3: imported history (origin='import'), never carried => answered", async () => {
    const f = await seed({ originImport: true });
    expect([...await answeredPersonMessageIds(db, { ...f, commentIds: [f.m1] })]).toEqual([f.m1]);
    expect(await f.owed()).not.toContain(f.m1);
  });

  it("L1b kept: M1's own carrier FAILED without a reply => a later reply does not answer it", async () => {
    const f = await seed();
    await f.run({ wakeCommentId: f.m1 }, f.t + 500, "failed");
    const r2 = await f.run({ wakeCommentIds: [f.m2] }, f.t + 2000);
    await f.reply(r2, f.t + 3000);
    expect([...await answeredPersonMessageIds(db, { ...f, commentIds: [f.m1, f.m2] })]).toEqual([f.m2]);
    const [m1] = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.id, f.m1));
    expect(m1).toBeDefined();
  });
});
