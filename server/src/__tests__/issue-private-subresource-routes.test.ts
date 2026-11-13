import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companyMemberships, issueAccessGrants, issues } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import {
  describeEmbeddedPostgres, routeApp, seedCompanyWithBoardAccess, useEmbeddedPostgres, type BoardActor,
} from "./helpers/route-test-harness.js";

// Keep reason: task-privacy trust boundary; caught the live ordinary-member
// existence oracle on /live-runs and /feedback-votes.
// Real Express routers, canonical authorization and Postgres; no service mocks.
describeEmbeddedPostgres("private issue subresource reads", () => {
  const ctx = useEmbeddedPostgres("paperclip-private-subresource-");
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
  });

  async function fixture() {
    const owner = await seedCompanyWithBoardAccess(ctx.db, "Private subresource");
    const userId = `member-${randomUUID()}`;
    await ctx.db.insert(companyMemberships).values({
      companyId: owner.companyId, principalType: "user", principalId: userId,
      membershipRole: "operator", status: "active",
    });
    await ensureHumanRoleDefaultGrants(ctx.db, {
      companyId: owner.companyId, principalId: userId, membershipRole: "operator", grantedByUserId: owner.userId,
    });
    const member: BoardActor = {
      type: "board", source: "session", userId, companyIds: [owner.companyId], isInstanceAdmin: false,
      memberships: [{ companyId: owner.companyId, membershipRole: "operator", status: "active" }],
    };
    const issueId = randomUUID();
    const identifier = `PRIV${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}-1`;
    await ctx.db.insert(issues).values({
      id: issueId, companyId: owner.companyId, identifier, title: "Private task",
      visibility: "private", privacyRootIssueId: issueId, status: "todo",
      responsibleUserId: owner.userId, createdByUserId: owner.userId,
    });
    // Match app.ts order: agent routes precede issue routes. The same test also
    // exercises identifier normalization and the issue-router param/ETag layers.
    const app = (actor: BoardActor) => routeApp(ctx.db, actor, agentRoutes, issueRoutes);
    return { owner, member, issueId, identifier, app };
  }

  for (const suffix of ["live-runs", "feedback-votes"]) {
    for (const reference of ["uuid", "identifier"] as const) {
      it(`${suffix}: hides a private issue from an ordinary member by ${reference}`, async () => {
        const f = await fixture();
        const server = f.app(f.member);
        const ref = reference === "uuid" ? f.issueId : f.identifier.toLowerCase();
        // The normal task route establishes that this company member cannot
        // read this exact task; the subresource must give the same 404 body.
        const detail = await request(server).get(`/api/issues/${ref}`).expect(404);
        const missing = await request(server).get(`/api/issues/${reference === "uuid" ? randomUUID() : "MISSING-999"}/${suffix}`).expect(404);
        const result = await request(server).get(`/api/issues/${ref}/${suffix}`);
        expect(result.status, JSON.stringify(result.body)).toBe(404);
        expect(result.body).toEqual(missing.body);
        expect(result.body).toEqual(detail.body);
      });

      it(`${suffix}: preserves owner and explicitly granted member access by ${reference}, then revokes it`, async () => {
        const f = await fixture();
        const ref = reference === "uuid" ? f.issueId : f.identifier.toLowerCase();
        await request(f.app(f.owner.actor)).get(`/api/issues/${ref}/${suffix}`).expect(200, []);
        const [grant] = await ctx.db.insert(issueAccessGrants).values({
          issueId: f.issueId, subjectType: "user", subjectId: f.member.userId,
          source: "explicit", grantedByUserId: f.owner.userId,
        }).returning();
        const server = f.app(f.member);
        const authorized = await request(server).get(`/api/issues/${ref}/${suffix}`).expect(200, []);
        await ctx.db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant!.id));
        // A warm router/ETag must not retain a positive decision after revocation.
        let revoked = request(server).get(`/api/issues/${ref}/${suffix}`);
        if (authorized.headers.etag) revoked = revoked.set("If-None-Match", authorized.headers.etag);
        await revoked.expect(404, { error: "Issue not found" });
        await request(f.app(f.owner.actor)).get(`/api/issues/${ref}/${suffix}`).expect(200, []);
      });
    }
  }
});
