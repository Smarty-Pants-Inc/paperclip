import { createHash } from "node:crypto";
import type { Db, heartbeatRuns } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { createHeartbeatRunOutput } from "../services/heartbeat/run-output.js";
import { createAgentIdentityRedactor } from "../services/agent-identity-redaction.js";

vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({
  resolveVersion: async ({ material }: { material: { value: string } }) => material.value,
  createSecret: async ({ value }: { value: string }) => ({ material: { value } }),
}) }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Data safety: exercise the stored-text readers, not just the live redactor.
const ids = {
  run: "0d6e9b52-31aa-4c1f-9e2d-5b7c8a9f0e1d",
  agent: "7f3c2a10-4b5d-4e6f-8a9b-0c1d2e3f4a5b",
  company: "18bd3ac1-49fe-4e26-b315-100897712fe1",
  issue: "5a46df11-94a5-4eba-8a2e-b063ebc08ab2",
  environment: "bd0378e2-642f-440b-98ef-d270c582fe52",
};
const longSecret = "registry-long-secret-z9X#";
const ordinary = `test 1 passed in v1.2.3 (11 files)\nrun ${ids.run} agent ${ids.agent}\ncompany ${ids.company} issue ${ids.issue} environment ${ids.environment}\n`;
const entry = (value: string) => ({ fingerprintSha256: createHash("sha256").update(value).digest("hex"), material: { value } });
const readers = ["redactForRuns", "redactorForRun", "redactForRun", "redactForIssue"] as const;
type Reader = typeof readers[number];
type RegistryRow = { id: string; identifiers: string[]; contextSnapshot: { paperclipSecretRedactions: ReturnType<typeof entry>[] } };

function fixture(values: string[], extraRows: RegistryRow[] = []) {
  const row: RegistryRow = { id: ids.run, identifiers: Object.values(ids),
    contextSnapshot: { paperclipSecretRedactions: values.map(entry) } };
  const rows = [row, ...extraRows];
  const projections: Record<string, unknown>[] = [];
  const db = {
    select: (columns: Record<string, unknown>) => {
      projections.push(columns);
      return { from: () => ({ where: () => Object.assign(Promise.resolve(rows), {
        for: () => Promise.resolve(rows),
        orderBy: () => ({ limit: async () => [] }),
      }) }) };
    },
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
      if (values.contextSnapshot) row.contextSnapshot = values.contextSnapshot as RegistryRow["contextSnapshot"];
    } }) }),
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db as unknown as Db),
  };
  return { row, registry: createRunSecretRedactionRegistry(db as unknown as Db), db: db as unknown as Db, projections };
}

async function read(registry: ReturnType<typeof createRunSecretRedactionRegistry>, reader: Reader, text: string) {
  if (reader === "redactForRuns") return (await registry.redactForRuns(ids.company, [{ id: ids.run, text }]))[0]!.text;
  if (reader === "redactorForRun") return (await registry.redactorForRun(ids.company, ids.run))({ text }).text;
  if (reader === "redactForRun") return (await registry.redactForRun(ids.company, ids.run, { text })).text;
  return (await registry.redactForIssue(ids.company, ids.issue, { text })).text;
}

describe("stored run secret index rules (redact-meta5 RED)", () => {
  it.each(readers)("%s masks a long non-id registered value on its own", async reader => {
    const { registry } = fixture([longSecret]);
    expect(await read(registry, reader, `token=${longSecret}\n`)).toBe("token=***REDACTED***\n");
  });

  it.each(readers)("%s leaves short registered values byte-equal", async reader => {
    const { registry } = fixture(["1", "v1", "abc1234"]);
    expect(await read(registry, reader, ordinary)).toBe(ordinary);
  });

  it.each(readers.flatMap(reader => Object.entries(ids).map(([kind, id]) => ({ reader, kind, id }))))(
    "$reader leaves a secret equal to the run's $kind id byte-equal", async ({ reader, id }) => {
      const { registry } = fixture([id, ` ${id}\n`]);
      expect(await read(registry, reader, ordinary)).toBe(ordinary);
    });

  it.each(readers)("%s still masks a long non-id value beside skipped values", async reader => {
    const { registry } = fixture(["1", "v1", ...Object.values(ids), longSecret]);
    expect(await read(registry, reader, ordinary + `token=${longSecret}\n`))
      .toBe(ordinary + "token=***REDACTED***\n");
  });

  it("loads only the registry and the run's own identity fields, not the prompt snapshot", async () => {
    const { registry, projections } = fixture([]);
    for (const reader of readers) await read(registry, reader, ordinary);
    const dialect = new PgDialect();
    for (const projection of projections) {
      const query = dialect.sqlToQuery(projection.identifiers as import("drizzle-orm").SQL).sql;
      for (const field of ["id", "agent_id", "company_id", "native_issue_id"]) expect(query).toContain(`"${field}"`);
      for (const field of ["issueId", "paperclipIssue", "paperclipEnvironment"]) expect(query).toContain(field);
      expect(dialect.sqlToQuery(projection.contextSnapshot as import("drizzle-orm").SQL).sql)
        .toContain("-> 'paperclipSecretRedactions'");
    }
  });

  it.each(readers)("%s never skips a secret merely because it equals another run's id", async reader => {
    const foreignId = "2efad5e0-8cbe-46d4-ab71-2666ea37eeb0";
    const other: RegistryRow = { id: foreignId, identifiers: [foreignId, ids.company], contextSnapshot: { paperclipSecretRedactions: [] } };
    const { registry } = fixture([foreignId], [other]);
    expect(await read(registry, reader, `foreign=${foreignId}`)).toBe("foreign=***REDACTED***");
  });

  it("runtimeLogSecretValues registration reaches every stored reader with the same rules", async () => {
    const { db, registry, row } = fixture([]);
    const run = { id: ids.run, agentId: ids.agent, companyId: ids.company, status: "running", runtimeMode: "native",
      logStore: null, logRef: null, logBytes: null, lastOutputSeq: 0, lastOutputAt: null } as typeof heartbeatRuns.$inferSelect;
    const recorder = createHeartbeatRunOutput(db, { run, runId: ids.run, issueId: ids.issue,
      runLogStore: { begin: async () => ({ store: "s3_segments", logRef: "company/agent/run" }), append: async () => 0,
        enqueue: async () => ({ committed: Promise.resolve(0) }), flush: async () => undefined },
      identityRedactor: createAgentIdentityRedactor(), secretKeys: new Set(), appendRunEvent: vi.fn(),
      getCurrentUserRedactionOptions: async () => ({ enabled: false }),
      runtimeLogSecretValues: ["1", "v1", ...Object.values(ids), longSecret],
    });
    await recorder.begin(run);
    expect(row.contextSnapshot.paperclipSecretRedactions).toHaveLength(8);
    for (const reader of readers) {
      expect(await read(registry, reader, ordinary + `token=${longSecret}\n`))
        .toBe(ordinary + "token=***REDACTED***\n");
    }
  });
});
