import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, assets, authUsers, closeRegisteredClients, companies, companyMemberships,
  createDb, documents, issueComments, issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  companyPortabilityImportSchema,
  type CompanyPortabilityFileEntry,
  type CompanyPortabilityImport,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyPortabilityService } from "../services/company-portability.js";

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;
type Target = CompanyPortabilityImport["target"];
type TaskPeople = Array<{
  issueIdentifier: string;
  creatorEmail: string | null;
  responsibleEmail: string | null;
}>;

// Deliberately different slugs, rotated identifier-looking titles, and shuffled
// taskPeople entries: only .paperclip.yaml tasks[slug].identifier is the key.
const taskSpecs = [
  { slug: "first-task", identifier: "AUTH-1", title: "AUTH-2" },
  { slug: "second-task", identifier: "AUTH-2", title: "AUTH-3" },
  { slug: "third-task", identifier: "AUTH-3", title: "AUTH-1" },
] as const;

function bundle() {
  const files: Record<string, CompanyPortabilityFileEntry> = {
    "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Task people source"\ndescription: "Rejected imports must not apply this description."\n---\nSynthetic fixture.\n',
    "agents/review-bot/AGENTS.md": '---\nslug: "review-bot"\nname: "Review Bot"\nkind: agent\n---\nSynthetic existing assignee.\n',
    "tasks/first-task/documents/spec.md": "# Synthetic specification\n",
  };
  for (const task of taskSpecs) {
    files[`tasks/${task.slug}/TASK.md`] = [
      "---", `name: ${JSON.stringify(task.title)}`, "kind: task",
      ...(task.identifier === "AUTH-1" ? ['assignee: "review-bot"'] : []),
      "---", "Synthetic task.", "",
    ].join("\n");
  }
  // Real block YAML, not JSON pretending to be .paperclip.yaml. The sidecar
  // identifier is the actual export field read into manifest.issues[].identifier.
  files[".paperclip.yaml"] = [
    "schemaVersion: 7", "agents:", "  review-bot:", "    role: engineer", "tasks:",
    ...taskSpecs.flatMap((task) => [
      `  ${task.slug}:`, `    identifier: ${JSON.stringify(task.identifier)}`,
      "    status: todo", "    priority: medium",
      "    comments:", "      -", `        body: ${JSON.stringify(`note-${task.identifier}`)}`,
      "        authorType: user", "        authorAgentSlug: null", "        authorUserId: null",
      "        presentation: null", "        metadata: null", "        createdAt: null",
      ...(task.identifier === "AUTH-1" ? [
        "    documents:", "      -", "        key: spec", "        title: Synthetic specification",
        "        format: markdown", "        path: tasks/first-task/documents/spec.md",
      ] : []),
    ]), "",
  ].join("\n");
  return { rootPath: "task-people", files };
}

function inputFor(target: Target, taskPeople?: TaskPeople, userCommentAuthorEmail?: string): CompanyPortabilityImport {
  const source = bundle();
  const input = {
    source: { type: "inline" as const, ...source },
    include: { company: true, agents: false, projects: false, issues: true },
    target,
    collisionStrategy: "rename" as const,
    ...(taskPeople === undefined ? {} : { taskPeople }),
    ...(userCommentAuthorEmail === undefined ? {} : { userCommentAuthorEmail }),
  };
  // Buildable on the pre-feature shared type; runtime schema tests below still
  // require taskPeople retention and reject malformed values, without casts.
  return input as CompanyPortabilityImport;
}

function instrumentMutationCalls(db: Record<string, unknown>) {
  const calls = {
    insert: 0, update: 0, delete: 0,
    reset() { this.insert = 0; this.update = 0; this.delete = 0; },
  };
  const patch = (target: Record<string, unknown>) => {
    for (const method of ["insert", "update", "delete"] as const) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const bound = (original as (...args: unknown[]) => unknown).bind(target);
      target[method] = (...args: unknown[]) => { calls[method] += 1; return bound(...args); };
    }
  };
  patch(db);
  const transaction = (db.transaction as (
    fn: (tx: Record<string, unknown>) => unknown, config?: unknown,
  ) => unknown).bind(db);
  db.transaction = (fn: (tx: Record<string, unknown>) => unknown, config?: unknown) =>
    transaction((tx) => { patch(tx); return fn(tx); }, config);
  return calls;
}

function sorted<T extends { id: string }>(rows: T[]) {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

async function snapshot(db: Db) {
  return {
    companies: sorted(await db.select().from(companies)),
    memberships: sorted(await db.select().from(companyMemberships)),
    issues: sorted(await db.select().from(issues)),
    comments: sorted(await db.select().from(issueComments)),
    documents: sorted(await db.select().from(documents)),
    agents: sorted(await db.select().from(agents)),
    assets: sorted(await db.select().from(assets)),
  };
}

async function seed(db: Db, existingCompany: boolean) {
  const suffix = randomUUID();
  const users = {
    paul: { id: randomUUID(), email: `Paul-${suffix}@Example.test` },
    ops: { id: randomUUID(), email: `OPS-${suffix}@example.test` },
    importer: { id: randomUUID(), email: `importer-${suffix}@example.test` },
    outsider: { id: randomUUID(), email: `outsider-${suffix}@example.test` },
  };
  const now = new Date();
  await db.insert(authUsers).values(Object.entries(users).map(([name, user]) => ({
    ...user, name, createdAt: now, updatedAt: now,
  })));
  if (!existingCompany) return { ...users, companyId: null, agentId: null };
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId, name: "Original task people target", description: "Original description.",
    issuePrefix: `T${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(companyMemberships).values([users.paul, users.ops, users.importer].map((user) => ({
    companyId, principalType: "user", principalId: user.id, status: "active", membershipRole: "member",
  })));
  await db.insert(agents).values({
    id: agentId, companyId, name: "Review Bot", role: "engineer", status: "idle",
    adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  return { ...users, companyId, agentId };
}

type Fixture = Awaited<ReturnType<typeof seed>>;
function peopleFor(users: Fixture): TaskPeople {
  return [
    { issueIdentifier: "AUTH-3", creatorEmail: null, responsibleEmail: null },
    { issueIdentifier: "AUTH-1", creatorEmail: `  ${users.paul.email.toLowerCase()}  `, responsibleEmail: ` ${users.ops.email.toUpperCase()} ` },
    { issueIdentifier: "AUTH-2", creatorEmail: ` ${users.ops.email.toLowerCase()} `, responsibleEmail: `  ${users.paul.email.toUpperCase()}  ` },
  ];
}
function targetFor(mode: "existing_company" | "new_company", fixture: Fixture): Target {
  if (mode === "new_company") return { mode, newCompanyName: "New task people target" };
  if (!fixture.companyId) throw new Error("Existing target fixture missing company");
  return { mode, companyId: fixture.companyId };
}

const contractInput = () => ({
  source: { type: "inline", rootPath: "contract", files: {} },
  target: { mode: "existing_company", companyId: randomUUID() },
});
const contractPeople: TaskPeople = [
  { issueIdentifier: "AUTH-1", creatorEmail: "paul@example.test", responsibleEmail: null },
];

describe("company import taskPeople schema contract", () => {
  it("retains the independent optional taskPeople input rather than stripping it", () => {
    const parsed = companyPortabilityImportSchema.parse({ ...contractInput(), taskPeople: contractPeople });
    expect((parsed as unknown as Record<string, unknown>).taskPeople).toEqual(contractPeople);
    const absent = companyPortabilityImportSchema.parse(contractInput());
    expect("taskPeople" in absent).toBe(false);
  });
  it("strips unrelated entry keys without accepting them as creator authority", () => {
    const parsed = companyPortabilityImportSchema.parse({ ...contractInput(), taskPeople: [
      { ...contractPeople[0]!, creatorAgentId: randomUUID(), createdByEmail: "ignored@example.test" },
    ] });
    expect((parsed as unknown as Record<string, unknown>).taskPeople).toEqual(contractPeople);
  });
  it.each([
    ["null array", null],
    ["obsolete versioned wrapper", { version: 1, tasks: contractPeople }],
    ["object instead of array", {}],
    ["missing explicit nullable field", [{ issueIdentifier: "AUTH-1", creatorEmail: null }]],
    ["obsolete entry field names", [{ identifier: "AUTH-1", createdByEmail: null, responsibleEmail: null }]],
    ["non-string identifier", [{ issueIdentifier: 1, creatorEmail: null, responsibleEmail: null }]],
    ["non-email creator", [{ issueIdentifier: "AUTH-1", creatorEmail: "not-an-email", responsibleEmail: null }]],
    ["non-email responsible", [{ issueIdentifier: "AUTH-1", creatorEmail: null, responsibleEmail: "not-an-email" }]],
  ])("rejects %s", (_name, taskPeople) => {
    expect(companyPortabilityImportSchema.safeParse({ ...contractInput(), taskPeople }).success).toBe(false);
  });
});

describePostgres("company import taskPeople persisted attribution", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let calls!: ReturnType<typeof instrumentMutationCalls>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-import-task-people-");
    db = createDb(tempDb.connectionString);
    calls = instrumentMutationCalls(db as unknown as Record<string, unknown>);
  }, 30_000);
  afterAll(async () => {
    if (!tempDb) return;
    await closeRegisteredClients(tempDb.connectionString);
    await tempDb.cleanup();
  });

  async function assertRejectedWithoutWrites(input: CompanyPortabilityImport, importer: string) {
    const before = await snapshot(db);
    calls.reset();
    let rejected = false;
    let error: unknown;
    try { await companyPortabilityService(db).importBundle(input, importer); }
    catch (caught) { rejected = true; error = caught; }
    // Calls detect even rolled-back writes; snapshots detect persisted changes.
    expect({
      rejected,
      status: error && typeof error === "object" && "status" in error ? error.status : null,
      mutations: { insert: calls.insert, update: calls.update, delete: calls.delete },
      after: await snapshot(db),
    }).toEqual({ rejected: true, status: 422, mutations: { insert: 0, update: 0, delete: 0 }, after: before });
  }

  async function assertImported(companyId: string, fixture: Fixture, selectedPeople: boolean, commentAuthor: string) {
    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    expect(rows).toHaveLength(3);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    for (const spec of taskSpecs) {
      const row = byTitle.get(spec.title);
      const creator = spec.identifier === "AUTH-1" ? fixture.paul.id : spec.identifier === "AUTH-2" ? fixture.ops.id : null;
      const responsible = spec.identifier === "AUTH-1" ? fixture.ops.id : spec.identifier === "AUTH-2" ? fixture.paul.id : null;
      expect(row).toMatchObject({
        createdByUserId: selectedPeople ? creator : null,
        createdByAgentId: null,
        responsibleUserId: selectedPeople ? responsible : null,
        conversationUserId: null,
        assigneeUserId: null,
        assigneeAgentId: spec.identifier === "AUTH-1" ? fixture.agentId : null,
      });
      const comments = await db.select().from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, row!.id),
      ));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        body: `note-${spec.identifier}`, authorType: "user", authorUserId: commentAuthor, authorAgentId: null,
      });
    }
    const docs = await db.select().from(documents).where(eq(documents.companyId, companyId));
    expect(docs).toHaveLength(1);
    expect(docs[0]?.createdByUserId).toBe(fixture.importer.id);
  }

  it.each(["existing_company", "new_company"] as const)(
    "maps each identifier's two people independently in %s; explicit null never becomes importer", async (mode) => {
      const fixture = await seed(db, mode === "existing_company");
      const input = inputFor(targetFor(mode, fixture), peopleFor(fixture));
      expect("userCommentAuthorEmail" in input).toBe(false);
      const result = await companyPortabilityService(db).importBundle(input, fixture.importer.id);
      expect(result.company.action).toBe(mode === "new_company" ? "created" : "updated");
      await assertImported(result.company.id, fixture, true, fixture.importer.id);
      if (mode === "new_company") {
        for (const user of [fixture.paul, fixture.ops]) {
          expect(await db.select().from(companyMemberships).where(and(
            eq(companyMemberships.companyId, result.company.id), eq(companyMemberships.principalId, user.id),
          ))).toEqual([]);
        }
      }
    },
  );

  it("accepts both inputs without letting the selected comment author replace either task person", async () => {
    const fixture = await seed(db, true);
    const people = peopleFor(fixture);
    Object.assign(people[1]!, { creatorAgentId: fixture.agentId });
    const result = await companyPortabilityService(db).importBundle(inputFor(
      targetFor("existing_company", fixture), people, fixture.ops.email,
    ), fixture.importer.id);
    await assertImported(result.company.id, fixture, true, fixture.ops.id);
  });

  it.each([false, true])("omitted taskPeople preserves NULL task people with comment-author input present=%s", async (withCommentAuthor) => {
    const fixture = await seed(db, true);
    const input = inputFor(targetFor("existing_company", fixture), undefined, withCommentAuthor ? fixture.ops.email : undefined);
    expect("taskPeople" in input).toBe(false);
    const result = await companyPortabilityService(db).importBundle(input, fixture.importer.id);
    await assertImported(result.company.id, fixture, false, withCommentAuthor ? fixture.ops.id : fixture.importer.id);
  });

  const invalidCases = ["missing task", "extra identifier", "duplicate identifier", "wrong identifier case", "unknown creator", "unknown responsible"] as const;
  for (const mode of ["existing_company", "new_company"] as const) {
    it.each(invalidCases)(`rejects %s in ${mode} before any import mutation`, async (reason) => {
      const fixture = await seed(db, mode === "existing_company");
      const people = peopleFor(fixture);
      if (reason === "missing task") people.pop();
      if (reason === "extra identifier") people.push({ issueIdentifier: "AUTH-404", creatorEmail: null, responsibleEmail: null });
      if (reason === "duplicate identifier") people[2] = { ...people[0]! };
      if (reason === "wrong identifier case") people[0]!.issueIdentifier = "auth-3";
      if (reason === "unknown creator") people[1]!.creatorEmail = `unknown-${randomUUID()}@example.test`;
      if (reason === "unknown responsible") people[1]!.responsibleEmail = `unknown-${randomUUID()}@example.test`;
      await assertRejectedWithoutWrites(inputFor(targetFor(mode, fixture), people), fixture.importer.id);
    });
  }

  it.each(["creatorEmail", "responsibleEmail"] as const)("rejects a nonmember %s for an existing company before writes", async (field) => {
    const fixture = await seed(db, true);
    const people = peopleFor(fixture);
    people[1]![field] = fixture.outsider.email;
    await assertRejectedWithoutWrites(inputFor(targetFor("existing_company", fixture), people), fixture.importer.id);
  });

  it("rejects an inactive target membership even when the task user exists globally", async () => {
    const fixture = await seed(db, true);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(
      eq(companyMemberships.companyId, fixture.companyId!),
      eq(companyMemberships.principalId, fixture.paul.id),
    ));
    await assertRejectedWithoutWrites(inputFor(targetFor("existing_company", fixture), peopleFor(fixture)), fixture.importer.id);
  });

  it.each(["existing_company", "new_company"] as const)("rejects globally ambiguous normalized task emails in %s before writes", async (mode) => {
    const fixture = await seed(db, mode === "existing_company");
    const now = new Date();
    await db.insert(authUsers).values({
      id: randomUUID(), name: "Duplicate normalized Paul", email: ` ${fixture.paul.email.toUpperCase()} `,
      createdAt: now, updatedAt: now,
    });
    await assertRejectedWithoutWrites(inputFor(targetFor(mode, fixture), peopleFor(fixture)), fixture.importer.id);
  });
});
