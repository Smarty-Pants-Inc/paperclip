import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, issueComments, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { describeEmbeddedPostgres, resetCompanyIssueFixtures, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("issue list includeHidden", () => {
  const ctx = useEmbeddedPostgres("paperclip-include-hidden-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(issueComments);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed() {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "Hidden tasks");
    const { companyId, userId } = seeded;
    const ids = { visible: randomUUID(), hidden: randomUUID(), hiddenHarness: randomUUID(), harness: randomUUID() };
    const hiddenAt = new Date("2026-11-15T05:00:00.000Z");
    const base = { companyId, status: "todo", originKind: "manual", createdByUserId: userId, assigneeUserId: userId };
    await ctx.db.insert(issues).values([
      { ...base, id: ids.visible, title: "Quarterly visible report" },
      { ...base, id: ids.hidden, title: "Quarterly hidden report", hiddenAt },
      { ...base, id: ids.hiddenHarness, title: "Quarterly hidden harness report", hiddenAt, harnessKind: "skill_test" },
      { ...base, id: ids.harness, title: "Quarterly harness report", harnessKind: "skill_test" },
    ]);
    // An agent reply after the person last touched both tasks makes each unread.
    const later = new Date(Date.now() + 60_000);
    await ctx.db.insert(issueComments).values([ids.visible, ids.hidden].map((issueId) => ({
      companyId, issueId, authorUserId: null, body: "Agent reply", createdAt: later, updatedAt: later,
    })));
    return { ...seeded, ids, hiddenAt };
  }

  const idsOf = (body: Array<{ id: string }>) => body.map((issue) => issue.id).sort();

  it("returns a hidden task only when includeHidden=true, keeps harness tasks out, and leaves the default unchanged", async () => {
    const { companyId, actor, ids, hiddenAt } = await seed();
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;

    for (const view of ["", "&view=compact", "&view=index"]) {
      const defaults = await request(app).get(`${path}?limit=50${view}`).expect(200);
      expect(idsOf(defaults.body)).toEqual([ids.visible]);
      const explicitOff = await request(app).get(`${path}?includeHidden=false&limit=50${view}`).expect(200);
      expect(idsOf(explicitOff.body)).toEqual([ids.visible]);

      const withHidden = await request(app).get(`${path}?includeHidden=true&limit=50${view}`).expect(200);
      expect(idsOf(withHidden.body)).toEqual([ids.visible, ids.hidden].sort());
      const hiddenRow = withHidden.body.find((issue: { id: string }) => issue.id === ids.hidden);
      // The list marks the row, so every projection carries hiddenAt for it.
      expect(new Date(hiddenRow.hiddenAt).toISOString()).toBe(hiddenAt.toISOString());
      const visibleRow = withHidden.body.find((issue: { id: string }) => issue.id === ids.visible);
      expect(visibleRow.hiddenAt ?? null).toBeNull();
    }

    await request(app).get(`${path}?includeHidden=maybe`).expect(400);
    const svc = issueService(ctx.db);
    expect((await svc.list(companyId, {})).map((issue) => issue.id)).toEqual([ids.visible]);
    expect((await svc.list(companyId, { includeHidden: true })).map((issue) => issue.id).sort()).toEqual([ids.visible, ids.hidden].sort());
  });

  it("returns only hidden non-harness tasks when hiddenOnly=true, before pagination, in every projection", async () => {
    const { companyId, actor, ids, hiddenAt } = await seed();
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;
    for (const view of ["", "&view=compact", "&view=index"]) {
      for (const include of ["", "&includeHidden=true"]) {
        const response = await request(app).get(`${path}?hiddenOnly=true&limit=1${view}${include}`).expect(200);
        expect(idsOf(response.body)).toEqual([ids.hidden]);
        expect(new Date(response.body[0].hiddenAt).toISOString()).toBe(hiddenAt.toISOString());
        expect((await request(app).get(`${path}?hiddenOnly=true&limit=1&offset=1${view}${include}`).expect(200)).body).toEqual([]);
      }
      expect(idsOf((await request(app).get(`${path}?hiddenOnly=false${view}`).expect(200)).body)).toEqual([ids.visible]);
    }
    for (const value of ["maybe", "1", "true&hiddenOnly=false"]) {
      await request(app).get(`${path}?hiddenOnly=${value}`).expect(400);
    }
    expect((await issueService(ctx.db).list(companyId, { hiddenOnly: true })).map(issue => issue.id)).toEqual([ids.hidden]);
  });

  it.each(["includeHidden", "hiddenOnly"])("keeps hidden tasks out of search, the inbox and unread counts even when %s=true", async (visibility) => {
    const { companyId, userId, actor, ids } = await seed();
    const app = routeApp(ctx.db, actor, issueRoutes);
    const path = `/api/companies/${companyId}/issues`;

    // Search: the hidden title matches, but search keeps excluding hidden tasks.
    for (const view of ["", "&view=compact", "&view=index"]) {
      const search = await request(app).get(`${path}?q=Quarterly&${visibility}=true${view}`).expect(200);
      expect(idsOf(search.body)).toEqual([ids.visible]);
    }

    // Inbox and unread lists.
    for (const filter of ["touchedByUserId=me", "touchedByUserId=me&inboxArchivedByUserId=me", "unreadForUserId=me"]) {
      const inbox = await request(app).get(`${path}?${filter}&${visibility}=true`).expect(200);
      expect(idsOf(inbox.body), filter).toEqual([ids.visible]);
    }

    // Unread counts (the sidebar badge and the touched-unread counter).
    const svc = issueService(ctx.db);
    expect(await svc.countUnreadTouchedByUser(companyId, userId)).toBe(1);
    expect([...(await svc.unreadInboxIssueIds(companyId, userId, sql<boolean>`true`))]).toEqual([ids.visible]);
  });
});
