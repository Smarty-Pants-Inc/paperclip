import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { activityLog, agents, approvals, budgetPolicies, companies, companyMemberships, companySecrets,
  companySecretBindings, companySecretVersions, companySkills, folders, principalPermissionGrants, projects,
  createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

// Data-safety regression. Real routers/writers/PG; each company starts with a
// cold skill inventory. The DB trigger is controlled late storage refusal, not
// an authorization or persistence mock. No live credentials or external calls.
describe("cold import preview and refused imports leave no database residue", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-import-no-residue-");
    db = createDb(fixture.connectionString);
    await db.execute(sql`create sequence l12_prefix_seen`);
    await db.execute(sql`create function l12_refuse_late_project() returns trigger language plpgsql as $$
      begin
        if NEW.name = 'z-refuse' then
          -- Sequence state survives rollback, proving the writer really reached
          -- this point after creating each prefix, not an earlier validation.
          if (select count(*) from agents where company_id = NEW.company_id) < 2
            or not exists (select 1 from principal_permission_grants where company_id = NEW.company_id and permission_key = 'commentary:view')
            or not exists (select 1 from company_secrets where company_id = NEW.company_id)
            or not exists (select 1 from company_secret_bindings where company_id = NEW.company_id)
            or not exists (select 1 from company_skills where company_id = NEW.company_id)
            or not exists (select 1 from projects where company_id = NEW.company_id)
            or not exists (select 1 from activity_log where company_id = NEW.company_id) then
            raise exception 'L12 prefix proof missing';
          end if;
          perform nextval('l12_prefix_seen');
          raise exception 'L12 intentional late storage refusal';
        end if;
        return NEW;
      end $$`);
    await db.execute(sql`create trigger l12_refuse_late_project before insert on projects for each row execute function l12_refuse_late_project()`);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  async function seed(actorType: "board" | "agent") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cold import", issuePrefix: `R${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false });
    const [ceo] = await db.insert(agents).values({ companyId, name: "CEO", role: "ceo", adapterType: "codex_local",
      adapterConfig: {}, permissions: { canCreateAgents: true } }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: ceo!.id,
      membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey: "agents:configure", scope: { subtreeRootAgentId: ceo!.id } },
      { companyId, principalType: "agent", principalId: ceo!.id, permissionKey: "commentary:view", scope: { subtreeRootAgentId: ceo!.id } },
    ]);
    const actor: Express.Request["actor"] = actorType === "board"
      ? { type: "board", userId: "local-board", source: "local_implicit" }
      : { type: "agent", agentId: ceo!.id, companyId, source: "agent_key", keyId: randomUUID() };
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => { req.actor = actor; next(); });
    api.use("/api/companies", companyRoutes(db));
    api.use(errorHandler);
    return { companyId, ceo: ceo!, api };
  }
  function bundle(f: Awaited<ReturnType<typeof seed>>, failure: "unknown-scope" | "late" | "none") {
    const slugs = ["agents/imported/AGENTS.md", "skills/fixture/SKILL.md", "projects/a-first/PROJECT.md", "projects/z-last/PROJECT.md"];
    const files = {
      "COMPANY.md": `---\nname: Cold import\nincludes:\n${slugs.map(s => `  - ${s}`).join("\n")}\n---\n`,
      "agents/imported/AGENTS.md": "---\nname: Imported\nslug: imported\nkind: agent\n---\n\nImported.\n",
      "skills/fixture/SKILL.md": "---\nname: fixture\ndescription: Synthetic import rollback fixture.\n---\n\n# Fixture\n",
      "projects/a-first/PROJECT.md": "---\nname: a-first\nslug: a-first\nkind: project\n---\n\nFirst project.\n",
      "projects/z-last/PROJECT.md": `---\nname: ${failure === "late" ? "z-refuse" : "z-last"}\nslug: z-last\nkind: project\n---\n\nLast project.\n`,
      ".paperclip.yaml": stringify({ schema: "paperclip/v1", agents: { imported: {
        role: "engineer", reportsToExistingAgentId: f.ceo.id,
        adapter: { type: "codex_local", runner: "legacy", config: {} },
        permissionGrants: [{ permissionKey: "commentary:view", scope: { subtreeRootAgentId: failure === "unknown-scope" ? randomUUID() : f.ceo.id } }],
      } }, projects: { "a-first": { inputs: { env: { FIXTURE_SECRET: { kind: "secret", requirement: "required" } } } } } }),
    };
    // Delegation cannot name the caller itself. Use a packaged subordinate ID
    // and let the actual remapper resolve it after creation.
    if (failure !== "unknown-scope") {
      const sourceId = randomUUID();
      files[".paperclip.yaml"] = stringify({ schema: "paperclip/v1", agents: { imported: {
        sourceAgentId: sourceId, role: "engineer", reportsToExistingAgentId: f.ceo.id,
        adapter: { type: "codex_local", runner: "legacy", config: {} },
        permissionGrants: [{ permissionKey: "commentary:view", scope: { subtreeRootAgentId: sourceId } }],
      } }, projects: { "a-first": { inputs: { env: { FIXTURE_SECRET: { kind: "secret", requirement: "required" } } } } } });
    }
    return { source: { type: "inline", files }, target: { mode: "existing_company", companyId: f.companyId },
      include: { company: false, agents: true, skills: true, projects: true, issues: false }, agents: "all", collisionStrategy: "rename",
      secretValues: { "project:a-first:FIXTURE_SECRET": "synthetic-non-credential-fixture" } };
  }
  async function snapshot(companyId: string) {
    const tables = { agents, grants: principalPermissionGrants, secrets: companySecrets, bindings: companySecretBindings,
      skills: companySkills, projects, activity: activityLog,
      memberships: companyMemberships, approvals, budgets: budgetPolicies, folders };
    const counts = Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([key, table]) => [key,
      (await db.select({ id: table.id }).from(table).where(eq(table.companyId, companyId))).length,
    ])));
    counts.versions = (await db.select({ id: companySecretVersions.id }).from(companySecretVersions)
      .innerJoin(companySecrets, eq(companySecrets.id, companySecretVersions.secretId))
      .where(eq(companySecrets.companyId, companyId))).length;
    return counts;
  }
  async function prefixSeen() {
    return (await db.execute<{ last_value: string; is_called: boolean }>(sql`select last_value::text, is_called from l12_prefix_seen`))[0];
  }
  for (const actorType of ["board", "agent"] as const) {
    it(`${actorType}: preview alone does not reconcile a cold skill inventory or write anything`, async () => {
      const f = await seed(actorType), before = await snapshot(f.companyId);
      expect(before.skills).toBe(0);
      const response = await request(f.api).post(`/api/companies/${f.companyId}/imports/preview`).send(bundle(f, "none"));
      const after = await snapshot(f.companyId);
      console.log(JSON.stringify({ row: `preview:${actorType}`, status: response.status, before, after }));
      expect.soft(response.status, response.text).toBe(200);
      expect.soft(after).toEqual(before);
    });
    it(`${actorType}: a refused unknown-scope import from cold inventory leaves zero residue`, async () => {
      const f = await seed(actorType), before = await snapshot(f.companyId);
      expect(before.skills).toBe(0);
      const response = await request(f.api).post(`/api/companies/${f.companyId}/imports/apply`).send(bundle(f, "unknown-scope"));
      const after = await snapshot(f.companyId);
      console.log(JSON.stringify({ row: `early-refusal:${actorType}`, status: response.status, before, after }));
      expect.soft(response.status, response.text).toBe(422);
      expect.soft(response.body.error).toContain("Cannot import permission grant commentary:view");
      expect.soft(after).toEqual(before);
    });
    it(`${actorType}: late storage refusal rolls back real agents, grants, secrets/bindings, skills, projects and activity`, async () => {
      const f = await seed(actorType), before = await snapshot(f.companyId), seen = await prefixSeen();
      expect(before.skills).toBe(0);
      const response = await request(f.api).post(`/api/companies/${f.companyId}/imports/apply`).send(bundle(f, "late"));
      const after = await snapshot(f.companyId), reached = await prefixSeen();
      console.log(JSON.stringify({ row: `late-refusal:${actorType}`, status: response.status, before, after, seen, reached }));
      expect.soft(response.status, response.text).toBe(500);
      expect.soft(reached).not.toEqual(seen);
      expect.soft(after).toEqual(before);
    });
    it(`${actorType}: the same valid package commits all covered resource kinds`, async () => {
      const f = await seed(actorType), before = await snapshot(f.companyId);
      const response = await request(f.api).post(`/api/companies/${f.companyId}/imports/apply`).send(bundle(f, "none"));
      const after = await snapshot(f.companyId);
      console.log(JSON.stringify({ row: `valid:${actorType}`, status: response.status, before, after }));
      expect(response.status, response.text).toBe(200);
      for (const key of ["agents", "grants", "secrets", "bindings", "skills", "projects", "activity"]) {
        expect(after[key], key).toBeGreaterThan(before[key]!);
      }
    });
  }
});
