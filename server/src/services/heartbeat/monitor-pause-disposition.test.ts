import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import { AGENT_LIFECYCLE_STATES, AGENT_STATUSES, COMPANY_STATUSES, PAUSE_REASONS } from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { retainedIssueMonitorPause } from "./scheduling.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("shared monitor pause disposition", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("monitor-pause-disposition-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  it("evaluates the read/deadline/claim expression against the corrected rule on the full state matrix", async () => {
    // Every subset of the known hold vocabulary, plus an unknown hold, must
    // behave safely. Null is a defensive compatibility case, not a schema claim.
    const vocabulary = [...PAUSE_REASONS, "company_paused", "unknown_future_hold"];
    const holdSets: (string[] | null)[] = Array.from({ length: 2 ** vocabulary.length }, (_, bits) =>
      vocabulary.filter((_, index) => bits & (1 << index)));
    holdSets.push(null, ["import", "import"], ["company_paused", "company_paused"], ["manual", "manual"]);
    const rows = [];
    for (const company_status of COMPANY_STATUSES) for (const status of AGENT_STATUSES)
      for (const lifecycle_state of AGENT_LIFECYCLE_STATES) for (const holds of holdSets) {
        const present = holds ?? [];
        const expected = company_status === "paused" || (status === "paused" && (
          (present.length > 0 && present.every(hold => hold === "company_paused" || hold === "import")) ||
          (present.length === 0 && (lifecycle_state === "pausing" || lifecycle_state === "resuming"))
        ));
        rows.push({ company_status, status, lifecycle_state, holds, expected });
      }
    const expression = retainedIssueMonitorPause({ companyStatus: sql`matrix.company_status`,
      status: sql`matrix.status`, lifecycleState: sql`matrix.lifecycle_state`, holds: sql`matrix.holds` });
    const mismatches = await db.execute(sql`select * from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as matrix(company_status text, status text, lifecycle_state text, holds jsonb, expected boolean)
      where ${expression} is distinct from matrix.expected`);
    expect(rows).toHaveLength(COMPANY_STATUSES.length * AGENT_STATUSES.length * AGENT_LIFECYCLE_STATES.length * holdSets.length);
    expect([...mismatches]).toEqual([]);
    console.log(JSON.stringify({ check: "shared-read-deadline-claim-pause-expression", rows: rows.length, mismatches: mismatches.length }));
  }, 30_000);
});
