import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { activityService } from "../services/activity.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RUNS_COST_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
type Plan = { "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: Plan[] };

// The task chat reads a task's two latest runs before its first frame (the
// chat bootstrap and `/issues/:id/runs?view=recent`). That read must cost the
// task's own runs, not every run the company ever had.
describe.skipIf(!support.supported)("issue runs read cost", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let capture = false;
  const queries: Array<{ query: string; parameters: unknown[] }> = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("issue-runs-cost-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query, parameters) => {
      if (capture && /from "heartbeat_runs"/.test(query)) queries.push({ query, parameters: [...parameters] });
    };
  }, 30_000);
  afterEach(async () => { capture = false; queries.length = 0; await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it.each(["UTF8", "SQL_ASCII"])("preserves bounded nothing-new evidence byte-for-byte with the single-run read on %s", async (encoding) => {
    let rowDb = db;
    const asciiDatabase = `nothing_new_${randomUUID().replaceAll("-", "")}`;
    if (encoding === "SQL_ASCII") {
      await db.$client.unsafe(`CREATE DATABASE ${asciiDatabase} TEMPLATE template0 ENCODING 'SQL_ASCII' LC_COLLATE 'C' LC_CTYPE 'C'`);
      const url = new URL(external ?? temporary!.connectionString);
      url.pathname = `/${asciiDatabase}`;
      await applyPendingMigrations(url.toString());
      rowDb = createDb(url.toString(), { maxConnections: 2, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
      rowDb.$client.options.onnotice = () => {};
    }
    try {
      expect((await rowDb.execute(sql`show server_encoding`))[0]?.server_encoding).toBe(encoding);
      const companyId = randomUUID(), agentId = randomUUID();
      await rowDb.insert(companies).values({ id: companyId, name: "Continuation work", issuePrefix: `NN${companyId.slice(0, 6)}` });
      await rowDb.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
      const [task] = await rowDb.insert(issues).values({ companyId, title: "Continuation task", status: "in_progress" }).returning();
      const evidence = { schema: "paperclip.continuation-nothing-new.v1", namedCommentIds: [randomUUID()],
        answeredCommentIds: [] as string[], cause: "all_named_answered" };
      evidence.answeredCommentIds = [...evidence.namedCommentIds];
      const cases = [
        { name: "nothing-new", value: evidence, expected: evidence },
        { name: "wrong schema", value: { ...evidence, schema: "other" }, expected: undefined },
        { name: "over 16 KiB", value: { ...evidence, namedCommentIds: ["a".repeat(16384)] }, expected: undefined },
        { name: "non-ASCII", value: { ...evidence, namedCommentIds: ["caf\u00e9"] }, expected: undefined },
        { name: "without evidence", value: undefined, expected: undefined },
      ];
      const state = createHeartbeatRunState(rowDb);
      for (const entry of cases) {
        // Force UTF8's bounded result path as well as SQL_ASCII's safe path.
        const [run] = await rowDb.insert(heartbeatRuns).values({ companyId, agentId, issueId: task!.id,
          status: "succeeded", resultJson: { stopReason: "end_turn", stdout: randomBytes(70000).toString("hex"),
            ...(entry.value ? { continuationNothingNew: entry.value } : {}) } }).returning({ id: heartbeatRuns.id });
        const listed = (await activityService(rowDb).runsForIssue(companyId, task!.id, null, undefined, undefined,
          { skipLivenessBackfill: true })).find(candidate => candidate.runId === run!.id)!;
        const single = await state.getRun(run!.id);
        const projected = listed.resultJson?.continuationNothingNew;
        expect(projected, entry.name).toEqual(entry.expected);
        expect(Buffer.from(JSON.stringify(projected) ?? ""), entry.name).toEqual(
          Buffer.from(JSON.stringify(single?.resultJson?.continuationNothingNew) ?? ""));
        if (entry.expected === undefined) expect(listed.resultJson, entry.name).toEqual({ stopReason: "end_turn" });
        process.stdout.write(JSON.stringify({ continuationProjection: { encoding, case: entry.name, runId: run!.id,
          issueRuns: projected ?? null, singleRun: single?.resultJson?.continuationNothingNew ?? null, byteEqual: true } }) + "\n");
      }
    } finally {
      if (rowDb !== db) {
        await rowDb.$client.end({ timeout: 1 });
        await db.$client.unsafe(`DROP DATABASE ${asciiDatabase}`);
      }
    }
  }, 120_000);

  it("reads a task's latest runs without walking the company's run history", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Busy", issuePrefix: `BR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [task, other] = await db.insert(issues).values([
      { companyId, title: "Opened task", status: "in_progress" },
      { companyId, title: "Other task", status: "in_progress" },
    ]).returning();
    // 20,000 runs of other work, newer than the task's own runs.
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, issue_id, status, created_at)
      select ${companyId}::uuid, ${agentId}::uuid, ${other!.id}::uuid, 'succeeded',
        '2026-06-01T00:00:00Z'::timestamptz + n * interval '1 second' from generate_series(1, 20000) n`);
    // The task's runs: two linked directly, one only through its activity.
    const [direct1, direct2, viaActivity] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, issueId: task!.id, status: "succeeded", createdAt: new Date("2026-01-01T00:00:01Z") },
      { companyId, agentId, issueId: task!.id, status: "succeeded", createdAt: new Date("2026-01-01T00:00:02Z") },
      { companyId, agentId, status: "succeeded", createdAt: new Date("2026-01-01T00:00:03Z") },
    ]).returning();
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated",
      entityType: "issue", entityId: task!.id, runId: viaActivity!.id });
    await db.execute(sql`analyze heartbeat_runs`);
    await db.execute(sql`analyze activity_log`);

    capture = true;
    const recent = await activityService(db).runsForIssue(companyId, task!.id, null, 2, undefined, { skipLivenessBackfill: true });
    const all = await activityService(db).runsForIssue(companyId, task!.id, null, undefined, undefined, { skipLivenessBackfill: true });
    capture = false;

    expect(recent.map(run => run.runId)).toEqual([viaActivity!.id, direct2!.id]);
    expect(all.map(run => run.runId)).toEqual([viaActivity!.id, direct2!.id, direct1!.id]);

    expect(queries.length).toBeGreaterThan(0);
    let runRowsExamined = 0;
    for (const statement of queries) {
      const result = await db.$client.unsafe("EXPLAIN (ANALYZE, FORMAT JSON) " + statement.query, statement.parameters as never[]);
      const visit = (node: Plan) => {
        if (node["Relation Name"] === "heartbeat_runs") runRowsExamined += node["Actual Loops"]
          * (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0));
        node.Plans?.forEach(visit);
      };
      visit((result[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!.Plan);
    }
    process.stdout.write(JSON.stringify({ issueRunsReadCost: { companyRuns: 20003, runRowsExamined, queryCount: queries.length } }) + "\n");
    // Two reads of a three-run task. The other task's 20,000 runs must not be scanned.
    expect(runRowsExamined).toBeLessThanOrEqual(100);
  }, 120_000);
});
