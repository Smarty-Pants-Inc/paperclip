import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  authUsers,
  closeRegisteredClients,
  companies,
  companyMemberships,
  createDb,
  documents,
  issueComments,
  issues,
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
import { randomUUID } from "node:crypto";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const relayedGithubMetadata = {
  version: 1,
  sourceChannel: "github",
  sections: [{
    title: "GitHub sender",
    rows: [{ type: "key_value", label: "Sender", value: "example-bot" }],
  }],
} as const;

// Match the import/export service's block-YAML renderer. The importer uses its
// own block parser for .paperclip.yaml, so JSON emitted on this path would not
// exercise the bundle format used by actual imports.
function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function isRenderableScalar(value: unknown): boolean {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
    || (Array.isArray(value) && value.length === 0)
    || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      if (isRenderableScalar(entry)) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      if (isRenderableScalar(entry)) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }
  return [`${indent}${renderYamlScalar(value)}`];
}

function renderPaperclipYaml(value: Record<string, unknown>): string {
  return `${renderYamlBlock(value, 0).join("\n")}\n`;
}

function buildAuthorshipBundle(): {
  rootPath: string;
  files: Record<string, CompanyPortabilityFileEntry>;
} {
  const files: Record<string, CompanyPortabilityFileEntry> = {};
  files["COMPANY.md"] = [
    "---",
    'schema: "agentcompanies/v1"',
    'name: "Authorship source company"',
    'description: "Synthetic source description; never apply on rejected imports."',
    "---",
    "Synthetic import fixture only.",
    "",
  ].join("\n");
  files["agents/comment-bot/AGENTS.md"] = [
    "---",
    'slug: "comment-bot"',
    'name: "Comment Bot"',
    "kind: agent",
    "---",
    "Synthetic mapped agent fixture.",
    "",
  ].join("\n");
  files["tasks/authorship-task/TASK.md"] = [
    "---",
    'name: "Authorship task"',
    "kind: task",
    "---",
    "Synthetic task fixture.",
    "",
  ].join("\n");
  files["tasks/authorship-task/documents/spec.md"] = "# Synthetic import document\n\nNo real data.\n";

  files[".paperclip.yaml"] = renderPaperclipYaml({
    schemaVersion: 7,
    agents: { "comment-bot": { role: "engineer" } },
    tasks: {
      "authorship-task": {
        status: "todo",
        priority: "medium",
        comments: [
          {
            body: "plain-user-note",
            authorType: "user",
            authorAgentSlug: null,
            authorUserId: null,
            presentation: null,
            metadata: null,
            createdAt: null,
          },
          {
            body: "relayed-github-note",
            authorType: "user",
            authorAgentSlug: null,
            authorUserId: null,
            presentation: null,
            metadata: relayedGithubMetadata,
            createdAt: null,
          },
          {
            body: "agent-authored-note",
            authorType: "agent",
            authorAgentSlug: "comment-bot",
            authorUserId: null,
            presentation: null,
            metadata: null,
            createdAt: null,
          },
          {
            body: "system-authored-note",
            authorType: "system",
            authorAgentSlug: null,
            authorUserId: null,
            presentation: null,
            metadata: null,
            createdAt: null,
          },
        ],
        documents: [{
          key: "spec",
          title: "Synthetic import document",
          format: "markdown",
          path: "tasks/authorship-task/documents/spec.md",
        }],
      },
    },
  });

  return { rootPath: "comment-authorship", files };
}

type ImportTarget = CompanyPortabilityImport["target"];

function buildImportInput(
  bundle: ReturnType<typeof buildAuthorshipBundle>,
  target: ImportTarget,
  options: { userCommentAuthorEmail?: string; includeCompany?: boolean } = {},
): CompanyPortabilityImport {
  const input = {
    source: { type: "inline" as const, rootPath: bundle.rootPath, files: bundle.files },
    include: {
      company: options.includeCompany ?? false,
      agents: false,
      projects: false,
      issues: true,
    },
    target,
    collisionStrategy: "rename" as const,
    ...(options.userCommentAuthorEmail === undefined
      ? {}
      : { userCommentAuthorEmail: options.userCommentAuthorEmail }),
  };
  // Keep this candidate buildable before the new optional field is added to the
  // shared import type. The schema-contract test below still checks runtime
  // parsing; this cast does not relax or replace that assertion.
  return input as CompanyPortabilityImport;
}

function sortRowsById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

function instrumentMutationCalls(db: Record<string, unknown>) {
  const counts = {
    total: 0,
    byMethod: { insert: 0, update: 0, delete: 0 },
    reset() {
      this.total = 0;
      this.byMethod.insert = 0;
      this.byMethod.update = 0;
      this.byMethod.delete = 0;
    },
  };
  const patch = (target: Record<string, unknown>) => {
    for (const method of ["insert", "update", "delete"] as const) {
      const original = target[method];
      if (typeof original !== "function") continue;
      const bound = (original as (...args: unknown[]) => unknown).bind(target);
      target[method] = (...args: unknown[]) => {
        counts.total += 1;
        counts.byMethod[method] += 1;
        return bound(...args);
      };
    }
  };
  patch(db);
  const originalTransaction = (db.transaction as (
    fn: (tx: Record<string, unknown>) => unknown,
    config?: unknown,
  ) => unknown).bind(db);
  db.transaction = (
    fn: (tx: Record<string, unknown>) => unknown,
    config?: unknown,
  ) => originalTransaction((tx: Record<string, unknown>) => {
    patch(tx);
    return fn(tx);
  }, config);
  return counts;
}

async function snapshotRows(db: ReturnType<typeof createDb>) {
  const [companyRows, issueRows, commentRows, documentRows, agentRows, assetRows] = await Promise.all([
    db.select().from(companies),
    db.select().from(issues),
    db.select().from(issueComments),
    db.select().from(documents),
    db.select().from(agents),
    db.select().from(assets),
  ]);
  return {
    companies: sortRowsById(companyRows),
    memberships: sortRowsById(await db.select().from(companyMemberships)),
    issues: sortRowsById(issueRows),
    comments: sortRowsById(commentRows),
    documents: sortRowsById(documentRows),
    agents: sortRowsById(agentRows),
    assets: sortRowsById(assetRows),
  };
}

async function addUsers(db: ReturnType<typeof createDb>) {
  const suffix = randomUUID();
  const users = {
    namedMember: { id: randomUUID(), email: `named-${suffix}@example.test` },
    importer: { id: randomUUID(), email: `importer-${suffix}@example.test` },
    nonmember: { id: randomUUID(), email: `outsider-${suffix}@example.test` },
  };
  const now = new Date();
  await db.insert(authUsers).values([
    { id: users.namedMember.id, name: "Named comment author", email: users.namedMember.email, createdAt: now, updatedAt: now },
    { id: users.importer.id, name: "Importing board user", email: users.importer.email, createdAt: now, updatedAt: now },
    { id: users.nonmember.id, name: "Unrelated email user", email: users.nonmember.email, createdAt: now, updatedAt: now },
  ]);
  return users;
}

async function seedExistingTarget(db: ReturnType<typeof createDb>) {
  const users = await addUsers(db);
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Existing target remains unchanged",
    description: "Original target description.",
    issuePrefix: `M${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: users.namedMember.id, status: "active", membershipRole: "member" },
    { companyId, principalType: "user", principalId: users.importer.id, status: "active", membershipRole: "member" },
  ]);
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Comment Bot",
    role: "engineer",
    status: "idle",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return { ...users, companyId, agentId };
}

async function captureImportAttempt(
  db: ReturnType<typeof createDb>,
  input: CompanyPortabilityImport,
  importerId: string,
) {
  try {
    await companyPortabilityService(db).importBundle(input, importerId);
    return { rejected: false, error: null };
  } catch (error) {
    return { rejected: true, error };
  }
}

describe("company import comment authorship schema contract", () => {
  it("retains userCommentAuthorEmail when parsing import input", () => {
    const email = "  Named-Member@Example.test  ";
    const parsed = companyPortabilityImportSchema.parse({
      source: { type: "inline", rootPath: "contract", files: {} },
      include: { company: false, agents: false, projects: false, issues: true },
      target: { mode: "existing_company", companyId: randomUUID() },
      userCommentAuthorEmail: email,
    });

    expect((parsed as unknown as Record<string, unknown>).userCommentAuthorEmail).toBe(email.trim());
  });
});

describeEmbeddedPostgres("company import comment authorship", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let mutationCalls!: ReturnType<typeof instrumentMutationCalls>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-import-comment-authorship-");
    db = createDb(tempDb.connectionString);
    mutationCalls = instrumentMutationCalls(db as unknown as Record<string, unknown>);
  }, 30_000);

  afterAll(async () => {
    if (!tempDb) return;
    await closeRegisteredClients(tempDb.connectionString);
    await tempDb.cleanup();
  });

  it("attributes selected plain user comments to an active target-company member and demotes relayed chat comments", async () => {
    const fixture = await seedExistingTarget(db);
    const bundle = buildAuthorshipBundle();
    const result = await companyPortabilityService(db).importBundle(
      buildImportInput(bundle, { mode: "existing_company", companyId: fixture.companyId }, {
        userCommentAuthorEmail: `  ${fixture.namedMember.email.toUpperCase()}  `,
      }),
      fixture.importer.id,
    );
    expect(result.company.id).toBe(fixture.companyId);

    const importedIssues = await db.select().from(issues).where(eq(issues.companyId, fixture.companyId));
    expect(importedIssues).toHaveLength(1);
    expect(importedIssues[0]?.createdByUserId).toBeNull();

    const importedDocuments = await db.select().from(documents).where(eq(documents.companyId, fixture.companyId));
    expect(importedDocuments).toHaveLength(1);
    expect(importedDocuments[0]?.createdByUserId).toBe(fixture.importer.id);

    const comments = await db.select().from(issueComments).where(eq(issueComments.companyId, fixture.companyId));
    const byBody = new Map(comments.map((comment) => [comment.body, comment] as const));
    expect(byBody.size).toBe(4);
    expect(byBody.get("plain-user-note")).toMatchObject({
      authorType: "user",
      authorAgentId: null,
      authorUserId: fixture.namedMember.id,
      metadata: null,
    });
    expect(byBody.get("relayed-github-note")).toMatchObject({
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      metadata: relayedGithubMetadata,
    });
    expect(byBody.get("relayed-github-note")?.metadata).toEqual(relayedGithubMetadata);
    expect(byBody.get("agent-authored-note")).toMatchObject({
      authorType: "agent",
      authorAgentId: fixture.agentId,
      authorUserId: null,
      metadata: null,
    });
    expect(byBody.get("system-authored-note")).toMatchObject({
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      metadata: null,
    });
  });

  it("preserves legacy importer attribution when userCommentAuthorEmail is omitted", async () => {
    const fixture = await seedExistingTarget(db);
    const bundle = buildAuthorshipBundle();
    const input = buildImportInput(bundle, { mode: "existing_company", companyId: fixture.companyId });
    expect("userCommentAuthorEmail" in input).toBe(false);

    await companyPortabilityService(db).importBundle(input, fixture.importer.id);
    const comments = await db.select().from(issueComments).where(eq(issueComments.companyId, fixture.companyId));
    const byBody = new Map(comments.map((comment) => [comment.body, comment] as const));
    expect(byBody.size).toBe(4);
    expect(byBody.get("plain-user-note")).toMatchObject({ authorType: "user", authorUserId: fixture.importer.id });
    expect(byBody.get("relayed-github-note")).toMatchObject({
      authorType: "user",
      authorUserId: fixture.importer.id,
      metadata: relayedGithubMetadata,
    });
    expect(byBody.get("agent-authored-note")).toMatchObject({ authorType: "agent", authorAgentId: fixture.agentId });
    expect(byBody.get("system-authored-note")).toMatchObject({ authorType: "system", authorUserId: null });
  });

  it("rejects a nonmember author email before any database mutation", async () => {
    const fixture = await seedExistingTarget(db);
    const bundle = buildAuthorshipBundle();
    const input = buildImportInput(bundle, { mode: "existing_company", companyId: fixture.companyId }, {
      includeCompany: true,
      userCommentAuthorEmail: fixture.nonmember.email,
    });
    mutationCalls.reset();
    const before = await snapshotRows(db);

    const attempt = await captureImportAttempt(db, input, fixture.importer.id);
    const after = await snapshotRows(db);
    const errorMessage = attempt.error instanceof Error ? attempt.error.message : "";
    expect({
      rejected: attempt.rejected,
      errorMessage,
      mutationCalls: mutationCalls.total,
      after,
    }).toEqual({
      rejected: true,
      errorMessage: expect.stringMatching(/member|membership/i),
      mutationCalls: 0,
      after: before,
    });
  });

  it("resolves an existing instance user for a new company without adding that user's membership", async () => {
    const users = await addUsers(db);
    const bundle = buildAuthorshipBundle();
    const result = await companyPortabilityService(db).importBundle(
      buildImportInput(bundle, {
        mode: "new_company",
        newCompanyName: "New company comment authorship fixture",
      }, { userCommentAuthorEmail: `  ${users.namedMember.email.toUpperCase()}  ` }),
      users.importer.id,
    );

    expect(result.company.action).toBe("created");
    const [importedIssue] = await db.select().from(issues).where(eq(issues.companyId, result.company.id));
    expect(importedIssue?.createdByUserId).toBeNull();
    const importedComments = await db.select().from(issueComments).where(eq(issueComments.companyId, result.company.id));
    const plainUserComment = importedComments.find((comment) => comment.body === "plain-user-note");
    expect(plainUserComment).toMatchObject({ authorType: "user", authorUserId: users.namedMember.id });

    const authorMemberships = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, result.company.id),
      eq(companyMemberships.principalId, users.namedMember.id),
    ));
    expect(authorMemberships).toEqual([]);
  });

  it.each(["existing_company", "new_company"] as const)(
    "rejects ambiguous normalized author emails for %s before any database mutation",
    async (mode) => {
      const fixture = await seedExistingTarget(db);
      const now = new Date();
      await db.insert(authUsers).values({
        id: randomUUID(),
        name: "A different instance user with the same normalized email",
        email: ` ${fixture.namedMember.email.toUpperCase()} `,
        createdAt: now,
        updatedAt: now,
      });
      const target: ImportTarget = mode === "existing_company"
        ? { mode, companyId: fixture.companyId }
        : { mode, newCompanyName: "Must not be created for ambiguous authorship" };
      const input = buildImportInput(buildAuthorshipBundle(), target, {
        includeCompany: true,
        userCommentAuthorEmail: fixture.namedMember.email,
      });
      mutationCalls.reset();
      const before = await snapshotRows(db);
      const attempt = await captureImportAttempt(db, input, fixture.importer.id);
      const after = await snapshotRows(db);
      expect({
        rejected: attempt.rejected,
        errorMessage: attempt.error instanceof Error ? attempt.error.message : "",
        mutationCalls: mutationCalls.total,
        after,
      }).toEqual({
        rejected: true,
        errorMessage: expect.stringMatching(/email|author/i),
        mutationCalls: 0,
        after: before,
      });
    },
  );

  it("rejects an unknown author email for a new company before any database mutation", async () => {
    const users = await addUsers(db);
    const bundle = buildAuthorshipBundle();
    const input = buildImportInput(bundle, {
      mode: "new_company",
      newCompanyName: "Must not be created for an unknown comment author",
    }, { userCommentAuthorEmail: `unknown-${randomUUID()}@example.test` });
    mutationCalls.reset();
    const before = await snapshotRows(db);

    const attempt = await captureImportAttempt(db, input, users.importer.id);
    const after = await snapshotRows(db);
    const errorMessage = attempt.error instanceof Error ? attempt.error.message : "";
    expect({
      rejected: attempt.rejected,
      errorMessage,
      mutationCalls: mutationCalls.total,
      after,
    }).toEqual({
      rejected: true,
      errorMessage: expect.stringMatching(/email|author/i),
      mutationCalls: 0,
      after: before,
    });
  });
});
