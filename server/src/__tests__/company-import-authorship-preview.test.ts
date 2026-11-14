import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, assets, authUsers, closeRegisteredClients, companies, companyMemberships,
  createDb, documents, issueComments, issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  companyPortabilityImportSchema, companyPortabilityPreviewSchema, INBOX_MINE_ISSUE_STATUS_FILTER,
  type CompanyPortabilityFileEntry, type CompanyPortabilityImport,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;
type Person = { issueIdentifier: string; creatorEmail: string | null; responsibleEmail: string | null };
type Authorship = {
  userCommentAuthorUserId?: string;
  comments?: Array<{ issueSlug: string; issueIdentifier: string | null; commentIndex: number; authorType: "user" | "system"; authorUserId: string | null }>;
  taskPeople?: Array<{ issueIdentifier: string; createdByUserId: string | null; responsibleUserId: string | null }>;
};
type Input = CompanyPortabilityImport & {
  userCommentAuthorEmail?: string;
  taskPeople?: Person[];
};
const github = {
  version: 1, sourceChannel: "github",
  sections: [{ title: "GitHub sender", rows: [{ type: "key_value", label: "Sender", value: "synthetic-bot" }] }],
} as const;
const slack = { version: 1, sourceChannel: "slack" } as const;
const specs = [
  { slug: "first-task", identifier: "PRE-1", comments: [
    { body: "plain", type: "user", metadata: null },
    { body: "github", type: "user", metadata: github },
    { body: "slack", type: "user", metadata: slack },
    { body: "agent", type: "agent", metadata: null },
    { body: "system", type: "system", metadata: null },
  ] },
  { slug: "second-task", identifier: "PRE-2", comments: [{ body: "second-plain", type: "user", metadata: null }] },
] as const;

// Compact real block YAML, including structured metadata; no JSON sidecar.
function bundle() {
  const files: Record<string, CompanyPortabilityFileEntry> = {
    "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Synthetic preview source"\n---\nNo real data.\n',
    "agents/source-bot/AGENTS.md": '---\nslug: "source-bot"\nname: "Source Bot"\nkind: agent\n---\nSynthetic agent.\n',
  };
  for (const task of specs) files[`tasks/${task.slug}/TASK.md`] = `---\nname: "${task.slug}"\nkind: task\n---\nSynthetic task.\n`;
  files[".paperclip.yaml"] = [
    "schemaVersion: 7",
    "agents:", "  source-bot:", "    role: engineer", "tasks:",
    ...specs.flatMap((task) => [
      `  ${task.slug}:`, `    identifier: ${task.identifier}`, "    status: todo", "    priority: medium", "    comments:",
      ...task.comments.flatMap((comment) => [
        "      -", `        body: ${comment.body}`, `        authorType: ${comment.type}`,
        `        authorAgentSlug: ${comment.type === "agent" ? "source-bot" : "null"}`,
        "        authorUserId: null", "        presentation: null", "        createdAt: null",
        ...(comment.metadata === null ? ["        metadata: null"] : [
          "        metadata:", "          version: 1", `          sourceChannel: ${comment.metadata.sourceChannel}`,
          ...(comment.metadata.sourceChannel === "github" ? [
            "          sections:", "            -", "              title: GitHub sender", "              rows:",
            "                -", "                  type: key_value", "                  label: Sender", "                  value: synthetic-bot",
          ] : []),
        ]),
      ]),
    ]), "",
  ].join("\n");
  return { type: "inline" as const, rootPath: "authorship-preview", files };
}
function inputFor(users: Users): Input {
  return {
    source: bundle(), target: { mode: "new_company", newCompanyName: "Synthetic authorship target" },
    include: { company: true, agents: true, projects: false, issues: true }, collisionStrategy: "rename",
    userCommentAuthorEmail: ` ${users.paul.email.toLowerCase()} `,
    taskPeople: [
      { issueIdentifier: "PRE-1", creatorEmail: ` ${users.paul.email.toUpperCase()} `, responsibleEmail: ` ${users.ops.email.toLowerCase()} ` },
      { issueIdentifier: "PRE-2", creatorEmail: null, responsibleEmail: users.paul.email },
    ],
  };
}
function instrument(db: Record<string, unknown>) {
  const counts = { insert: 0, update: 0, delete: 0, reset() { this.insert = this.update = this.delete = 0; } };
  const patch = (target: Record<string, unknown>) => {
    for (const method of ["insert", "update", "delete"] as const) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const real = (original as (...args: unknown[]) => unknown).bind(target);
      target[method] = (...args: unknown[]) => { counts[method]++; return real(...args); };
    }
  };
  patch(db);
  const realTransaction = (db.transaction as (fn: (tx: Record<string, unknown>) => unknown, config?: unknown) => unknown).bind(db);
  db.transaction = (fn: (tx: Record<string, unknown>) => unknown, config?: unknown) =>
    realTransaction((tx) => { patch(tx); return fn(tx); }, config);
  return counts;
}
function sorted<T extends { id: string }>(rows: T[]) { return [...rows].sort((a, b) => a.id.localeCompare(b.id)); }
async function snapshot(db: Db) {
  return {
    users: sorted(await db.select().from(authUsers)), companies: sorted(await db.select().from(companies)),
    memberships: sorted(await db.select().from(companyMemberships)), agents: sorted(await db.select().from(agents)),
    issues: sorted(await db.select().from(issues)), comments: sorted(await db.select().from(issueComments)),
    documents: sorted(await db.select().from(documents)), assets: sorted(await db.select().from(assets)),
  };
}
async function seedUsers(db: Db) {
  const suffix = randomUUID();
  const users = {
    paul: { id: randomUUID(), email: `Paul-${suffix}@Example.test` },
    ops: { id: randomUUID(), email: `OPS-${suffix}@example.test` },
    importer: { id: randomUUID(), email: `importer-${suffix}@example.test` },
  };
  const now = new Date();
  await db.insert(authUsers).values(Object.entries(users).map(([name, user]) => ({ ...user, name, createdAt: now, updatedAt: now })));
  return users;
}
type Users = Awaited<ReturnType<typeof seedUsers>>;
const contract = () => ({
  source: bundle(), target: { mode: "new_company", newCompanyName: "Contract" },
  userCommentAuthorEmail: " Paul@example.test ",
  taskPeople: [{ issueIdentifier: "PRE-1", creatorEmail: "paul@example.test", responsibleEmail: null }],
});

describe("authorship preview and apply request contracts", () => {
  for (const [name, schema] of [["preview", companyPortabilityPreviewSchema], ["apply", companyPortabilityImportSchema]] as const) {
    it(`${name} retains both independent inputs`, () => {
      const input = contract();
      const parsed = schema.parse(input) as unknown as Record<string, unknown>;
      expect(parsed.userCommentAuthorEmail).toBe("Paul@example.test");
      expect(parsed.taskPeople).toEqual(input.taskPeople);
    });
    it(`${name} rejects malformed attribution fields`, () => {
      expect(schema.safeParse({ ...contract(), userCommentAuthorEmail: "not-an-email" }).success).toBe(false);
      expect(schema.safeParse({ ...contract(), taskPeople: [{ issueIdentifier: "PRE-1", creatorEmail: null }] }).success).toBe(false);
    });
  }
});

describePostgres("authorship common preflight, read-only preview, and persisted new-company attribution", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let calls!: ReturnType<typeof instrument>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-authorship-preview-");
    db = createDb(temp.connectionString);
    calls = instrument(db as unknown as Record<string, unknown>);
  }, 30_000);
  afterAll(async () => { if (temp) { await closeRegisteredClients(temp.connectionString); await temp.cleanup(); } });
  async function unchanged<T>(run: () => Promise<T>): Promise<T> {
    const before = await snapshot(db);
    calls.reset();
    try { return await run(); }
    finally {
      expect({ insert: calls.insert, update: calls.update, delete: calls.delete }).toEqual({ insert: 0, update: 0, delete: 0 });
      expect(await snapshot(db)).toEqual(before);
    }
  }
  async function rejectBoth(input: Input, importerId: string) {
    for (const phase of ["preview", "apply"] as const) {
      await unchanged(async () => {
        const service = companyPortabilityService(db);
        const attempt = phase === "preview" ? service.previewImport(input) : service.importBundle(input, importerId);
        await expect(attempt).rejects.toMatchObject({ status: 422 });
      });
      const rows = await snapshot(db);
      expect({ companies: rows.companies.length, agents: rows.agents.length, issues: rows.issues.length, comments: rows.comments.length })
        .toEqual({ companies: 0, agents: 0, issues: 0, comments: 0 });
    }
  }

  // All negatives precede any positive company creation: even rolled-back or
  // transient attempted writers fail, and no prior company can hide a mutation.
  for (const field of ["userCommentAuthorEmail", "creatorEmail", "responsibleEmail"] as const) {
    it.each(["unknown", "ambiguous"] as const)(`${field}: %s global normalized email rejects preview AND apply before writes`, async (kind) => {
      const users = await seedUsers(db);
      let email = `unknown-${randomUUID()}@example.test`;
      if (kind === "ambiguous") {
        email = users.paul.email;
        const now = new Date();
        await db.insert(authUsers).values({ id: randomUUID(), name: "Synthetic normalized duplicate", email: ` ${email.toUpperCase()} `, createdAt: now, updatedAt: now });
      }
      const input = inputFor(users);
      // Keep the other two selected fields valid, isolating this field's failure.
      input.userCommentAuthorEmail = users.ops.email;
      input.taskPeople = specs.map((task) => ({ issueIdentifier: task.identifier, creatorEmail: users.ops.email, responsibleEmail: users.ops.email }));
      if (field === "userCommentAuthorEmail") input.userCommentAuthorEmail = email;
      else input.taskPeople[0]![field] = email;
      await rejectBoth(input, users.importer.id);
    });
  }
  it.each(["missing task", "extra task", "duplicate task", "unknown identifier", "invalid email"] as const)(
    "%s rejects both service entry points without any writes", async (reason) => {
      const users = await seedUsers(db);
      const input = inputFor(users);
      if (reason === "missing task") input.taskPeople!.pop();
      if (reason === "extra task") input.taskPeople!.push({ issueIdentifier: "PRE-3", creatorEmail: null, responsibleEmail: null });
      if (reason === "duplicate task") input.taskPeople![1] = { ...input.taskPeople![0]! };
      if (reason === "unknown identifier") input.taskPeople![0]!.issueIdentifier = "PRE-404";
      if (reason === "invalid email") input.userCommentAuthorEmail = "not-an-email";
      await rejectBoth(input, users.importer.id);
    },
  );

  it("previews exact source-indexed mappings without an actor or writes, then persists nonmember attribution without granting access", async () => {
    const users = await seedUsers(db);
    const input = inputFor(users);
    const beforeSource = JSON.stringify(input.source);
    const expected: Authorship = {
      userCommentAuthorUserId: users.paul.id,
      comments: [
        { issueSlug: "first-task", issueIdentifier: "PRE-1", commentIndex: 0, authorType: "user", authorUserId: users.paul.id },
        { issueSlug: "first-task", issueIdentifier: "PRE-1", commentIndex: 1, authorType: "system", authorUserId: null },
        { issueSlug: "first-task", issueIdentifier: "PRE-1", commentIndex: 2, authorType: "system", authorUserId: null },
        { issueSlug: "second-task", issueIdentifier: "PRE-2", commentIndex: 0, authorType: "user", authorUserId: users.paul.id },
      ],
      taskPeople: [
        { issueIdentifier: "PRE-1", createdByUserId: users.paul.id, responsibleUserId: users.ops.id },
        { issueIdentifier: "PRE-2", createdByUserId: null, responsibleUserId: users.paul.id },
      ],
    };
    const service = companyPortabilityService(db);
    const preview = await unchanged(() => service.previewImport(input));
    expect(preview.errors).toEqual([]);
    expect((preview as unknown as { authorship?: Authorship }).authorship).toEqual(expected);
    expect(JSON.stringify(input.source)).toBe(beforeSource);
    for (const spec of specs) expect(preview.manifest.issues.find((task) => task.slug === spec.slug)?.comments).toEqual(
      spec.comments.map((comment) => ({ body: comment.body, authorType: comment.type,
        authorAgentSlug: comment.type === "agent" ? "source-bot" : null, authorUserId: null,
        presentation: null, metadata: comment.metadata, createdAt: null })),
    );
    const legacy = { ...input };
    delete legacy.userCommentAuthorEmail; delete legacy.taskPeople;
    expect(await service.previewImport(legacy)).not.toHaveProperty("authorship");
    for (const only of ["comments", "taskPeople"] as const) {
      const one = { ...input };
      if (only === "comments") { delete one.taskPeople; }
      else delete one.userCommentAuthorEmail;
      const projected = await unchanged(() => service.previewImport(one));
      expect((projected as unknown as { authorship?: Authorship }).authorship).toEqual(only === "comments"
        ? { userCommentAuthorUserId: users.paul.id, comments: expected.comments }
        : { taskPeople: expected.taskPeople });
    }
    const result = await service.importBundle(input, users.importer.id);
    expect(result.company.action).toBe("created");
    const companyId = result.company.id;
    const taskRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(taskRows).toHaveLength(2);
    for (const [index, spec] of specs.entries()) {
      expect(taskRows.find((row) => row.title === spec.slug)).toMatchObject({
        createdByUserId: expected.taskPeople![index]!.createdByUserId,
        responsibleUserId: expected.taskPeople![index]!.responsibleUserId,
        createdByAgentId: null, assigneeAgentId: null, assigneeUserId: null, conversationUserId: null,
      });
    }
    const commentRows = await db.select().from(issueComments).where(eq(issueComments.companyId, companyId));
    expect(commentRows).toHaveLength(6);
    expect(commentRows.filter((row) => row.authorType === "user" && row.authorUserId === users.importer.id)).toEqual([]);
    const importedAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(importedAgents).toHaveLength(1);
    for (const spec of specs) for (const original of spec.comments) {
      const row = commentRows.find((comment) => comment.body === original.body);
      const relay = original.metadata !== null;
      expect(row).toMatchObject({ authorType: relay ? "system" : original.type,
        authorUserId: original.type === "user" && !relay ? users.paul.id : null,
        authorAgentId: original.type === "agent" ? importedAgents[0]!.id : null });
      expect(row?.metadata).toEqual(original.metadata);
    }
    for (const user of [users.paul, users.ops]) expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, user.id),
    ))).toEqual([]);
    // Ordinary owner invitation happens AFTER import; attribution did not grant access.
    await accessService(db).ensureMembership(companyId, "user", users.paul.id, "member", "active");
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, users.paul.id),
    ))).toMatchObject([{ principalType: "user", status: "active", membershipRole: "member" }]);
    await accessService(db).ensureMembership(companyId, "user", users.ops.id, "member", "active");
    expect(await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, users.ops.id),
    ))).toMatchObject([{ principalType: "user", status: "active", membershipRole: "member" }]);
    // Match the actual Mine route's participation query after ordinary invitations.
    // Both tasks contain Paul's direct human comments; neither is responsible-only for Paul.
    // company_import is NOT a human-task origin, so creator-only visibility is not claimed.
    expect(taskRows.every((row) => row.originKind === "company_import")).toBe(true);
    const mine = async (userId: string) => issueService(db).list(companyId, {
      readCondition: await issueReadSqlCondition(db, {
        type: "board", source: "session", userId, authorizingUserId: userId,
      }),
      touchedByUserId: userId, touchedCandidates: "participation", inboxArchivedByUserId: userId,
      status: INBOX_MINE_ISSUE_STATUS_FILTER, listProjection: "index",
      sortField: "updated", sortDir: "desc", limit: 100,
      includeRoutineExecutions: true, includeLiveDescendantSummary: true,
    });
    const paulMine = await mine(users.paul.id);
    expect(paulMine.map((row) => row.id).sort()).toEqual(taskRows.map((row) => row.id).sort());
    // Ops is only responsible for PRE-1: not creator, assignee, commenter, or importer.
    expect(taskRows.filter((row) => row.responsibleUserId === users.ops.id)).toHaveLength(1);
    expect(taskRows.some((row) => row.createdByUserId === users.ops.id || row.assigneeUserId === users.ops.id)).toBe(false);
    expect(commentRows.some((row) => row.authorUserId === users.ops.id)).toBe(false);
    expect(await mine(users.ops.id)).toEqual([]);
    // Existing-target planning must not run listFull's skill-refresh writers.
    const existing: Input = { ...input, target: { mode: "existing_company", companyId } };
    const existingPreview = await unchanged(() => service.previewImport(existing));
    expect(existingPreview.errors).toEqual([]);
    expect((existingPreview as unknown as { authorship?: Authorship }).authorship).toEqual(expected);
  });
});
