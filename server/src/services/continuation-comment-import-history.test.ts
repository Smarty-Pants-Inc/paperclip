// Imported history (org decision 20:29Z, .local/IMPORT-ARRIVAL.md): person comments that ARRIVED by a company import
// are history: answered, so never carried into a continuation and never noticed by B'. Live comments after the
// task's arrival keep the normal rules, and a live run-less agent comment still never answers. Everything here goes
// through the REAL companyPortabilityService import with SYNTHETIC bundles (no real bundle content).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, createDb, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { CompanyPortabilityFileEntry, CompanyPortabilityImport } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { companyPortabilityService } from "./company-portability.js";
import { logActivity } from "./activity-log.js";
import { readContinuationCommentInput } from "./continuation-comment-input.js";
import { settleUnansweredPersonMessage } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();

// The importer's own block-YAML shape (as in company-import-comment-authorship.test.ts).
const scalar = (value: unknown) => value === null ? "null" : typeof value === "boolean" || typeof value === "number" ? String(value) : JSON.stringify(value);
function yaml(value: unknown, level = 0): string[] {
  const pad = "  ".repeat(level);
  if (Array.isArray(value)) return value.flatMap(entry => entry !== null && typeof entry === "object"
    ? [`${pad}-`, ...yaml(entry, level + 1)] : [`${pad}- ${scalar(entry)}`]);
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => entry !== null && typeof entry === "object"
    && !(Array.isArray(entry) && entry.length === 0) ? [`${pad}${key}:`, ...yaml(entry, level + 1)] : [`${pad}${key}: ${Array.isArray(entry) ? "[]" : scalar(entry)}`]);
}

type BundleComment = { body: string; authorType: "user" | "agent"; createdAt: string };
function bundle(slug: string, comments: BundleComment[]) {
  const files: Record<string, CompanyPortabilityFileEntry> = {
    "COMPANY.md": ["---", 'schema: "agentcompanies/v1"', 'name: "Synthetic import history"', "---", "Synthetic fixture.", ""].join("\n"),
    "agents/helper/AGENTS.md": ["---", 'slug: "helper"', 'name: "Helper"', "kind: agent", "---", "Synthetic agent.", ""].join("\n"),
    [`tasks/${slug}/TASK.md`]: ["---", `name: "Synthetic task ${slug}"`, "kind: task", "---", "Synthetic task.", ""].join("\n"),
  };
  files[".paperclip.yaml"] = `${yaml({ schemaVersion: 7, agents: { helper: { role: "engineer" } }, tasks: { [slug]: {
    status: "in_progress", priority: "medium", assigneeAgentSlug: "helper",
    comments: comments.map(comment => ({ body: comment.body, authorType: comment.authorType,
      authorAgentSlug: comment.authorType === "agent" ? "helper" : null, authorUserId: null, presentation: null, metadata: null,
      createdAt: comment.createdAt })) } } }).join("\n")}\n`;
  return { rootPath: `history-${slug}`, files };
}

describe.skipIf(!support.supported)("imported person comments are history: never carried, never noticed", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("import-history-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function importer() {
    const id = randomUUID(), now = new Date();
    await db.insert(authUsers).values({ id, name: "Importer", email: `${id}@example.test`, createdAt: now, updatedAt: now });
    return id;
  }
  async function runImport(userId: string, target: CompanyPortabilityImport["target"], slug: string, comments: BundleComment[]) {
    const input = { source: { type: "inline" as const, ...bundle(slug, comments) },
      include: { company: target.mode === "new_company", agents: true, projects: false, issues: true },
      target, collisionStrategy: "rename" as const } as CompanyPortabilityImport;
    const result = await companyPortabilityService(db).importBundle(input, userId);
    // The route's audit row (routes/companies.ts logImportedCompanyActivity), written after a committed import.
    await logActivity(db, { companyId: result.company.id, actorType: "user", actorId: userId, action: "company.imported",
      entityType: "company", entityId: result.company.id, details: { companyAction: result.company.action } });
    const imported = await db.select().from(issues).where(and(eq(issues.companyId, result.company.id), eq(issues.originKind, "company_import")))
      .orderBy(issues.createdAt);
    return { companyId: result.company.id, issue: imported.find(issue => issue.title === `Synthetic task ${slug}`)! };
  }
  const commentsOf = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(issueComments.createdAt);
  async function makeActionable(issue: typeof issues.$inferSelect) {
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, issue.companyId)).limit(1);
    await db.update(agents).set({ status: "active", adapterType: "paperclip_runner" }).where(eq(agents.id, agent!.id));
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: agent!.id, assigneeUserId: null }).where(eq(issues.id, issue.id));
    return agent!.id;
  }
  // A live continuation whose parent run carried the person comment.
  async function carried(issue: typeof issues.$inferSelect, agentId: string, commentId: string) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: issue.companyId, agentId, status: "failed", runtimeMode: "native",
      nativeIssueId: issue.id, contextSnapshot: { issueId: issue.id, wakeCommentId: commentId, wakeCommentIds: [commentId] },
      createdAt: new Date(), finishedAt: new Date() }).returning();
    return readContinuationCommentInput(db, { companyId: issue.companyId, issueId: issue.id, runId: run!.id });
  }
  const notice = async (issue: typeof issues.$inferSelect) => {
    const settled = await settleUnansweredPersonMessage(db, { companyId: issue.companyId, issueId: issue.id, now: new Date(Date.now() + 30 * 60_000) });
    const notes = (await commentsOf(issue.id)).filter(note => note.authorType === "system"
      && String((note.metadata as Record<string, unknown> | null)?.authorizationReason ?? "").startsWith("unanswered_message:"));
    return { kind: settled.kind, notes: notes.length };
  };
  const past = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  it("(R1) new_company import: an imported person comment + an imported run-less agent reply -> not carried, not noticed", async () => {
    const userId = await importer();
    const { issue } = await runImport(userId, { mode: "new_company", newCompanyName: "History R1" }, "r1",
      [{ body: "Imported question.", authorType: "user", createdAt: past(600) }, { body: "Imported reply.", authorType: "agent", createdAt: past(590) }]);
    const [person, reply] = await commentsOf(issue.id);
    expect(person!.authorType).toBe("user");
    expect(reply!.authorType).toBe("agent");
    expect(reply!.createdByRunId, "the importer writes run-less replies").toBeNull();
    const agentId = await makeActionable(issue);
    expect.soft(await carried(issue, agentId, person!.id), "imported history is never carried").toEqual({});
    const n = await notice(issue);
    expect.soft(n.kind, "imported history is never noticed").not.toBe("noticed");
    expect.soft(n.notes).toBe(0);
  });

  it("(R2) an imported person comment with NO reply -> not carried, not noticed", async () => {
    const userId = await importer();
    const { issue } = await runImport(userId, { mode: "new_company", newCompanyName: "History R2" }, "r2",
      [{ body: "Imported question, never answered.", authorType: "user", createdAt: past(600) }]);
    const [person] = await commentsOf(issue.id);
    const agentId = await makeActionable(issue);
    expect.soft(await carried(issue, agentId, person!.id)).toEqual({});
    const n = await notice(issue);
    expect.soft(n.kind).not.toBe("noticed");
    expect.soft(n.notes).toBe(0);
  });

  it("(R3) a SECOND import (existing_company) whose messages are NEWER than the first import, with run-less replies -> not carried, not noticed", async () => {
    const userId = await importer();
    const first = await runImport(userId, { mode: "new_company", newCompanyName: "History R3" }, "r3-first",
      [{ body: "First import question.", authorType: "user", createdAt: past(600) }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    const afterFirst = new Date();
    const newer = [{ body: "Newer question.", authorType: "user" as const, createdAt: new Date(afterFirst.getTime() + 2).toISOString() },
      { body: "Newer reply.", authorType: "agent" as const, createdAt: new Date(afterFirst.getTime() + 4).toISOString() }];
    // The second import starts after its messages were written at the source.
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await runImport(userId, { mode: "existing_company", companyId: first.companyId }, "r3-second", newer);
    const [person] = await commentsOf(second.issue.id);
    expect(person!.createdAt.getTime(), "newer than the FIRST import").toBeGreaterThan(afterFirst.getTime());
    const agentId = await makeActionable(second.issue);
    expect.soft(await carried(second.issue, agentId, person!.id)).toEqual({});
    const n = await notice(second.issue);
    expect.soft(n.kind).not.toBe("noticed");
    expect.soft(n.notes).toBe(0);
  });

  it("(R4) a LIVE person message on an imported task after its arrival, then a live run-less agent post -> carried AND noticed", async () => {
    const userId = await importer();
    const { issue } = await runImport(userId, { mode: "new_company", newCompanyName: "History R4" }, "r4",
      [{ body: "Imported question.", authorType: "user", createdAt: past(600) }, { body: "Imported reply.", authorType: "agent", createdAt: past(590) }]);
    const agentId = await makeActionable(issue);
    await new Promise(resolve => setTimeout(resolve, 20));
    const [live] = await db.insert(issueComments).values({ companyId: issue.companyId, issueId: issue.id, authorType: "user",
      authorUserId: userId, body: "A live question after the import." }).returning();
    await db.insert(issueComments).values({ companyId: issue.companyId, issueId: issue.id, authorType: "agent", authorAgentId: agentId,
      createdByRunId: null, body: "A live run-less post.", createdAt: new Date(live!.createdAt.getTime() + 1_000) });
    expect.soft(await carried(issue, agentId, live!.id)).toMatchObject({ wakeCommentIds: [live!.id] });
    const n = await notice(issue);
    expect.soft(n.kind, "a live message is still owed a notice").toBe("noticed");
  });

  it("(R5) an imported task with no arrival record and no company import row -> nothing is history (normal behaviour)", async () => {
    const userId = await importer();
    const input = { source: { type: "inline" as const, ...bundle("r5", [{ body: "Old question.", authorType: "user", createdAt: past(600) }]) },
      include: { company: true, agents: true, projects: false, issues: true },
      target: { mode: "new_company", newCompanyName: "History R5" }, collisionStrategy: "rename" as const } as CompanyPortabilityImport;
    const result = await companyPortabilityService(db).importBundle(input, userId);
    const [issue] = await db.select().from(issues).where(eq(issues.companyId, result.company.id));
    // An import made before this image: neither record exists.
    await db.execute(sql`delete from activity_log where company_id = ${result.company.id} and action in ('issue.imported', 'company.imported')`);
    const [person] = await commentsOf(issue!.id);
    const agentId = await makeActionable(issue!);
    expect.soft(await carried(issue!, agentId, person!.id)).toMatchObject({ wakeCommentIds: [person!.id] });
    expect.soft((await notice(issue!)).kind).toBe("noticed");
  });

  it.each(["new_company", "existing_company"] as const)("(R6) a %s import writes exactly ONE issue.imported row per created issue, in the import", async mode => {
    const userId = await importer();
    const base = mode === "existing_company" ? await runImport(userId, { mode: "new_company", newCompanyName: "History R6 base" }, "r6-base", []) : null;
    const target = mode === "new_company" ? { mode, newCompanyName: "History R6" } as const : { mode, companyId: base!.companyId } as const;
    const { issue } = await runImport(userId, target, `r6-${mode}`, [{ body: "Q.", authorType: "user", createdAt: past(60) }]);
    const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, issue.companyId), eq(activityLog.action, "issue.imported"),
      eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(rows, "one arrival record for the created issue").toHaveLength(1);
  });

  it("(R6) the import FAILS, leaving no task behind, if its arrival record cannot be written", async () => {
    const userId = await importer();
    await db.execute(sql`create or replace function refuse_issue_imported() returns trigger language plpgsql as $$
      begin if new.action = 'issue.imported' then raise exception 'arrival record refused'; end if; return new; end $$`);
    await db.execute(sql`create trigger refuse_issue_imported before insert on activity_log for each row execute function refuse_issue_imported()`);
    try {
      const input = { source: { type: "inline" as const, ...bundle("r6-fail", [{ body: "Q.", authorType: "user", createdAt: past(60) }]) },
        include: { company: true, agents: true, projects: false, issues: true },
        target: { mode: "new_company", newCompanyName: "History R6 refused" }, collisionStrategy: "rename" as const } as CompanyPortabilityImport;
      let failed = false;
      try { await companyPortabilityService(db).importBundle(input, userId); } catch { failed = true; }
      const left = await db.select({ id: issues.id }).from(issues).where(eq(issues.title, "Synthetic task r6-fail"));
      expect.soft(failed, "the import fails").toBe(true);
      expect.soft(left, "and leaves no task").toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger refuse_issue_imported on activity_log`);
    }
  });
});
