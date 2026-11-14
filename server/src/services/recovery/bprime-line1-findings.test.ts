// RFL VERDICT-bprime-line1-faf2a201 (11:07Z) A1/A2/A4, on isolated PostgreSQL with production settlement.
// Keep reasons: never edit a note in place (org 09:18Z), one CURRENT note that every reader resolves to,
// and true held wording when the agent is also paused (SMA-183).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { heartbeatService } from "../heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { settleUnansweredPersonMessage, unansweredPersonMessageCommentCondition } from "./unanswered-person-message.js";
const support = await getEmbeddedPostgresTestSupport();
type Meta = Record<string, unknown> | null;
const HELD_NOTE_TITLE = "This conversation can't continue";
const supersededBy = (n: { metadata: unknown }) => (n.metadata as Meta)?.supersededBy as string | undefined;

describe.skipIf(!support.supported)("RFL bprime-line1 (11:07Z) A1/A2/A4: never edit in place, current-note resolution, paused+held wording (M1.4, Smarty fork, TEMPORARY)", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("bprime-line1-"); db = createDb(temp.connectionString); }, 60000);
  afterAll(async () => { if (db) await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await temp?.cleanup(); });

  async function fixture(opts: { chat?: boolean; hold?: boolean } = {}) {
    const chat = opts.chat ?? true;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), userId = randomUUID(), runId = randomUUID();
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: userId + "@example.test", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, name: "B-prime line1", issuePrefix: companyId.slice(0, 8), defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "History", status: "blocked", assigneeAgentId: agentId,
      ...(chat ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}) });
    const message = async (ms: number) => (await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Follow up " + ms, createdAt: at(ms) }).returning())[0]!;
    const first = await message(-300_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "failed",
      createdAt: at(-240_000), finishedAt: at(-180_000), errorCode: "native_continuation_requires_reconciliation", error: null, contextSnapshot: { issueId } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      status: opts.hold === false ? "resolved" : "active", cause: "native_continuation_requires_reconciliation", fingerprint: "line1:" + runId,
      nextAction: "Inspect the saved state", evidence: { runId } }).returning();
    const queue = async (messageId: string, ms: number) => (await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "queued", createdAt: at(ms), contextSnapshot: { issueId, wakeCommentId: messageId } }).returning())[0]!;
    const settle = (ms = 0) => settleUnansweredPersonMessage(db, { companyId, issueId, now: at(ms) });
    const all = () => db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system")));
    const current = async () => (await all()).filter(n => !n.deletedAt && !supersededBy(n));
    const flagged = async () => (await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.issueId, issueId),
      unansweredPersonMessageCommentCondition()))).length;
    return { companyId, agentId, issueId, userId, holdId: hold!.id, first, at, message, queue, settle, all, current, flagged };
  }

  // A1 (9): the waiting -> held upgrade rewrote the waiting note in place (unanswered-person-message.ts:407-414 on faf2a201).
  it("A1 never edit in place: waiting -> held posts a NEW held note; the waiting note stays byte-identical, kept and marked supersededBy the held note", async () => {
    const f = await fixture({ hold: false });
    const run = await f.queue(f.first.id, -60_000);
    expect((await f.settle()).kind).toBe("pending");
    await f.settle(121_000);
    const [waiting] = await f.current();
    expect(waiting!.body).toContain("it will start by itself");
    await db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.id, f.holdId));
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: f.at(122_000), errorCode: "native_continuation_requires_reconciliation",
      error: "native_controller_recovery_missing_evidence:snapshot_binding" }).where(eq(heartbeatRuns.id, run.id));
    await f.settle(150_000);
    const rows = await f.all();
    expect(rows, "the waiting note and ONE new held note").toHaveLength(2);
    const kept = rows.find(n => n.id === waiting!.id)!;
    const [held] = await f.current();
    expect(held!.id, "the held note is a NEW row").not.toBe(waiting!.id);
    expect(held!.presentation?.title).toBe(HELD_NOTE_TITLE);
    expect(kept.body, "never edit a note body in place").toBe(waiting!.body);
    expect(kept.presentation).toEqual(waiting!.presentation);
    expect(kept.deletedAt).toBeNull();
    expect(supersededBy(kept)).toBe(held!.id);
    expect((kept.metadata as Meta)?.authorizationReason, "the waiting note keeps its own key").toBe((waiting!.metadata as Meta)?.authorizationReason);
    await f.settle(200_000);
    expect(await f.all(), "no further note").toHaveLength(2);
  });

  // A1 counterexample path: a waiting note whose run never starts becomes failure text: also a NEW note, never an edit.
  it("A1 never edit in place: waiting -> 'didn't start' (start bound passed, no hold) posts a NEW note; the waiting note stays, marked superseded", async () => {
    const f = await fixture({ hold: false });
    await f.queue(f.first.id, -60_000);
    expect((await f.settle()).kind).toBe("pending");
    await f.settle(121_000);
    const [waiting] = await f.current();
    expect(waiting!.body).toContain("it will start by itself");
    await f.settle(11 * 60_000);
    const rows = await f.all();
    expect(rows).toHaveLength(2);
    const [now] = await f.current();
    expect(now!.id).not.toBe(waiting!.id);
    expect(now!.body).not.toContain("it will start by itself");
    const kept = rows.find(n => n.id === waiting!.id)!;
    expect(kept.body).toBe(waiting!.body);
    expect(kept.updatedAt?.getTime(), "only the supersession mark changes the waiting row").toBeGreaterThanOrEqual(waiting!.updatedAt!.getTime());
    expect(supersededBy(kept)).toBe(now!.id);
  });

  // A2 (9): RFL 11:07Z: a direct-successor chain A->B->C is acceptable; every reader must resolve to the CURRENT note.
  it("A2 three held messages give A->B->C; every row resolves through supersededBy to the ONE current note, and no reader counts or re-flags a superseded note", async () => {
    const f = await fixture();
    await f.settle();
    await f.message(1000); await f.settle(130_000);
    await f.message(140_000); await f.settle(270_000);
    const rows = await f.all();
    expect(rows).toHaveLength(3);
    expect(rows.every(n => !n.deletedAt), "never deleted").toBe(true);
    const current = await f.current();
    expect(current, "exactly one current note").toHaveLength(1);
    const byId = new Map(rows.map(n => [n.id, n]));
    const resolve = (id: string) => { let n = byId.get(id)!; const seen = new Set<string>();
      while (supersededBy(n)) { expect(seen.has(n.id), "no cycle").toBe(false); seen.add(n.id); n = byId.get(supersededBy(n)!)!; expect(n, "link target exists").toBeDefined(); }
      return n.id; };
    for (const n of rows) expect(resolve(n.id), "every row resolves to the current note").toBe(current[0]!.id);
    // Readers: discovery flags nothing, settlement adds nothing, and the note count stays one current.
    expect(await f.flagged(), "discovery does not re-flag superseded history").toBe(0);
    expect((await f.settle(400_000)).kind).toBe("noticed_before");
    expect(await f.all()).toHaveLength(3);
    expect(await f.current()).toHaveLength(1);
  });

  // A4 (6): paused + reconciliation-held said "it will run when Coder is resumed" (lines 675-684, 799-818 on faf2a201).
  it.each([true, false])("A4 paused chat=%s plus an active reconciliation hold gives the HELD note, never a promise that resume alone runs it", async chat => {
    const f = await fixture({ chat });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await f.queue(f.first.id, -60_000);
    await f.settle();
    const notes = await f.current();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.presentation?.title).toBe(HELD_NOTE_TITLE);
    expect(notes[0]!.body).not.toContain("it will run when Coder is resumed");
    expect(JSON.stringify(notes[0]!.metadata)).not.toContain("resume Coder");
  });

  // A4 counterexample: a genuine pause with no hold still says paused, and a hold that arrives later replaces it with a NEW held note.
  it("A4 counterexample: paused with no hold keeps the paused note; a later reconciliation hold posts a NEW held note and marks the paused note superseded", async () => {
    const f = await fixture({ hold: false });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    await f.queue(f.first.id, -60_000);
    await f.settle();
    const [paused] = await f.current();
    expect(paused!.body).toContain("it will run when Coder is resumed");
    await f.settle(60_000);
    expect(await f.all(), "a standing paused note stays while only the pause holds").toHaveLength(1);
    await db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.id, f.holdId));
    await f.settle(120_000);
    const [held] = await f.current();
    expect(held!.id).not.toBe(paused!.id);
    expect(held!.presentation?.title).toBe(HELD_NOTE_TITLE);
    const kept = (await f.all()).find(n => n.id === paused!.id)!;
    expect(kept.body).toBe(paused!.body);
    expect(supersededBy(kept)).toBe(held!.id);
  });
});
