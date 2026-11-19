import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { box, driveClassicCut, liveScenario, openClassicLiveContext, resetClassicLiveBox, PERSON, SAVED } from "../../__tests__/helpers/classic-live-scenario.js";
import { executionWorkspaces, issueRecoveryActions, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport } from "../../__tests__/helpers/embedded-postgres.js";
import { fileResourceRoutes } from "../../routes/file-resources.js";
import { issueRoutes } from "../../routes/issues.js";
import { executionWorkspaceRoutes } from "../../routes/execution-workspaces.js";
import { errorHandler } from "../../middleware/index.js";
import { recoverRetainedWorkspace } from "../workspace-recovery.js";

// rf-5 FU-a (NEVER-OK): after the classic stuck-save cut ended R at the cap, the person's Files reads at
// workspace=auto served R's OLD root: R's UNSAVED files, labelled "Task workspace", with preview and download.
//
// ONE real chain (driveClassicCut, the same one row "K1 live" walks): turn 0, R and P are real runs of the real
// executor, R hangs in its own teardown copy-back and the bound ends it at the cap; then R's late copy-back lands
// in its old root, the person presses Recover saved files, and a further real message starts P2.
// REAL, and every outcome below is read from it:
//   Files ................... GET /api/issues/:id/file-resources/{list,resolve,content,content?download=true} and
//                             POST /api/issues/:id/file-resources/availability (routes/file-resources.ts)
//   the task's binding ...... GET /api/issues/:id
//   Recover saved files ..... POST /api/issues/:id/recovery-actions/recover-workspace (routes/issues.ts)
//   P2 ...................... POST /api/issues/:id/comments -> the real queue and executor; its root is read from
//                             GET /api/issues/:id/runs (environmentLease.executionWorkspaceId) and the provider input
//   R's kept root ........... GET /api/execution-workspaces/:id (routes/execution-workspaces.ts) and the directory
// PLANTED: nothing.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("classic copy-back bound, the old root (rf-5 FU-a): an abandoned root is never the task's files again", () => {
  let context: Awaited<ReturnType<typeof openClassicLiveContext>>;
  type Probe = { status: number; body: any; text: string };
  type Files = Record<"list" | "listNotes" | "resolveNotes" | "contentNotes" | "downloadNotes" | "resolveReport" | "contentReport"
    | "downloadReport" | "availability" | "issue", Probe>;
  const seen = {} as { rRootWorkspaceId: string; rRoot: string; pRootWorkspaceId: string; pRoot: string; rRunId: string;
    unbound: Files; lateApplied: Files; rRootOnDisk: Record<string, string>; recover: Probe; afterRecover: Files;
    p2: { run: any; providerCwd: unknown; inputs: number } | null; keptRow: Probe; pRootOnDisk: Record<string, string>; failure?: unknown };

  beforeAll(async () => {
    context = await openClassicLiveContext("native-classic-oldroot-");
    const { db } = context;
    const s = await liveScenario(context);
    // The same board actor as the harness's own app, on the real Files, task and workspace routes.
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: PERSON, companyIds: [s.companyId],
      memberships: [{ companyId: s.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true }; next(); });
    app.use("/api", fileResourceRoutes(db)); app.use("/api", issueRoutes(db, {} as never, {}));
    app.use("/api", executionWorkspaceRoutes(db)); app.use(errorHandler);
    const base = `/api/issues/${s.issueId}`;
    const get = async (url: string, query: Record<string, string> = {}): Promise<Probe> => {
      const got = await request(app).get(url).query(query).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); });
      const text = (got.body as Buffer).toString("utf8");
      let body: unknown = null; try { body = JSON.parse(text); } catch { /* a download is the file's bytes */ }
      return { status: got.status, body, text };
    };
    /** REAL: what the person's Files navigation reads at workspace=auto. */
    const files = async (): Promise<Files> => {
      const availability = await request(app).post(`${base}/file-resources/availability`)
        .send({ queries: [{ path: "notes.md", workspace: "auto" }, { path: "report.md", workspace: "auto" }] });
      return {
        list: await get(`${base}/file-resources/list`, { workspace: "auto" }),
        listNotes: await get(`${base}/file-resources/list`, { workspace: "auto", q: "notes" }),
        resolveNotes: await get(`${base}/file-resources/resolve`, { workspace: "auto", path: "notes.md" }),
        contentNotes: await get(`${base}/file-resources/content`, { workspace: "auto", path: "notes.md" }),
        downloadNotes: await get(`${base}/file-resources/content`, { workspace: "auto", path: "notes.md", download: "true" }),
        resolveReport: await get(`${base}/file-resources/resolve`, { path: "report.md" }), // the default selector
        contentReport: await get(`${base}/file-resources/content`, { workspace: "auto", path: "report.md" }),
        downloadReport: await get(`${base}/file-resources/content`, { workspace: "auto", path: "report.md", download: "true" }),
        availability: { status: availability.status, body: availability.body, text: JSON.stringify(availability.body) },
        issue: await get(base),
      };
    };
    const onDisk = async (root: string) => {
      const out: Record<string, string> = {};
      for (const name of ["report.md", "notes.md", "data/keep.txt"]) {
        const body = await fs.readFile(path.join(root, name), "utf8").catch(() => null);
        if (body !== null) out[name] = body;
      }
      return out;
    };
    let cut: Awaited<ReturnType<typeof driveClassicCut>> | null = null;
    try {
      cut = await driveClassicCut(context, s, { afterCut: async state => { seen.rRunId = state.rRunId; seen.unbound = await files(); } });
      Object.assign(seen, { rRootWorkspaceId: cut.rRootWorkspaceId, rRoot: cut.rRoot, pRootWorkspaceId: cut.pRootWorkspaceId, pRoot: cut.pRoot });
      // R's live copy-back returns now: its apply lands in R's OLD root (the state rf-5 FU-a read).
      s.releaseStall();
      await cut.heartbeat.drainActiveRunExecutions();
      await cut.sweep(cut.r.id);
      seen.rRootOnDisk = await onDisk(cut.rRoot);
      seen.lateApplied = await files();
      // REAL: the person presses Recover saved files for R (its stale control; a resolved action of the task if it has one).
      const actions = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId)))
        .filter(row => (row.evidence as Record<string, unknown> | null)?.runId === cut!.r.id);
      const action = actions.find(row => row.cause === "native_workspace_sync_out_stalled") ?? actions[0];
      const recover = await request(app).post(`${base}/recovery-actions/recover-workspace`)
        .send({ actionId: action?.id ?? randomUUID(), runId: cut.r.id, idempotencyKey: randomUUID() });
      seen.recover = { status: recover.status, body: { answer: recover.body, action: action ? { cause: action.cause, status: action.status } : null },
        text: JSON.stringify(recover.body) };
      await cut.sweep(cut.r.id);
      // REAL: the recovery worker's own pass for that request (whatever it answers, it is recorded with the press).
      if (action) seen.recover.body.worker = await recoverRetainedWorkspace({ db, environmentRuntime: {} as never, companyId: s.companyId,
        issueId: s.issueId, runId: cut.r.id, actionId: action.id } as never).then(result => ({ result }), error => ({ error: String(error) }));
      seen.afterRecover = await files();
      // REAL: P2, the turn after P. Its message goes through the real route, queue and executor.
      for (let waited = 0; waited < 30_000 && (await s.runs())[2].status === "running"; waited += 250) {
        await cut.heartbeat.resumeQueuedRuns(); await new Promise(resolve => setTimeout(resolve, 250));
      }
      await s.say("Thanks. Now add a conclusion.");
      for (let waited = 0; waited < 60_000 && box.inputs.length < 4; waited += 250) {
        await cut.heartbeat.resumeQueuedRuns(); await new Promise(resolve => setTimeout(resolve, 250));
      }
      await cut.heartbeat.drainActiveRunExecutions();
      const all = await s.runs();
      const served = (await request(s.app).get(`${base}/runs`)).body as Array<Record<string, any>>; // the harness's app mounts the runs route
      const p2 = all[3];
      seen.p2 = p2 ? { run: served.find(row => row.runId === p2.id) ?? null, inputs: box.inputs.length,
        providerCwd: JSON.stringify(box.inputs[3] ?? null) } : null;
      seen.pRootOnDisk = await onDisk(cut.pRoot);
      seen.keptRow = await get(`/api/execution-workspaces/${cut.rRootWorkspaceId}`);
      seen.rRootOnDisk = { ...seen.rRootOnDisk, ...(await onDisk(cut.rRoot)) };
    } catch (error) { seen.failure = error; } finally {
      await cut?.finish();
      if (process.env.CLASSIC_OLDROOT_EVIDENCE) await fs.writeFile(process.env.CLASSIC_OLDROOT_EVIDENCE, JSON.stringify(seen, (_key, value) =>
        value instanceof Error ? String(value.stack ?? value) : value, 2));
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS + 300_000);
  afterEach(() => resetClassicLiveBox());
  afterAll(async () => { await context?.close(); });

  const UNSAVED = /REWRITTEN BY R|R's new notes/;
  /** No Files read names R's root or carries R's unsaved bytes. */
  function neverRsRoot(files: Files) {
    for (const [name, probe] of Object.entries(files)) {
      if (name === "issue") continue;
      expect(probe.text, `${name} names R's root`).not.toContain(seen.rRootWorkspaceId);
      expect(probe.text, `${name} carries R's unsaved bytes`).not.toMatch(UNSAVED);
    }
    for (const name of ["resolveNotes", "contentNotes", "downloadNotes"] as const) expect(files[name].status, name).toBe(404);
    expect(files.listNotes.body?.items ?? []).toEqual([]);
    expect(files.availability.body?.results?.find((result: any) => result.query.path === "notes.md")).toMatchObject({ openable: false, resource: null });
  }
  /** Every Files read serves P's root: the saved files. */
  function servesPsRoot(files: Files) {
    expect(files.issue.body).toMatchObject({ executionWorkspaceId: seen.pRootWorkspaceId });
    expect(files.list).toMatchObject({ status: 200, body: { state: "available", workspace: { workspaceId: seen.pRootWorkspaceId, workspaceLabel: "Task workspace" } } });
    expect(files.resolveReport).toMatchObject({ status: 200, body: { workspaceId: seen.pRootWorkspaceId, workspaceLabel: "Task workspace", displayPath: "report.md" } });
    expect(files.contentReport).toMatchObject({ status: 200, body: { resource: { workspaceId: seen.pRootWorkspaceId }, content: { data: SAVED["report.md"] } } });
    expect(files.downloadReport).toMatchObject({ status: 200, text: SAVED["report.md"] });
    expect(files.availability.body?.results?.find((result: any) => result.query.path === "report.md"))
      .toMatchObject({ openable: true, resource: { workspaceId: seen.pRootWorkspaceId } });
  }

  it("the chain ran: turn 0, R ended at the cap, P in its own root, R's late copy-back landed in R's old root", () => {
    expect(seen.failure).toBeUndefined();
    expect(seen.pRoot).not.toBe(seen.rRoot);
    expect(seen.pRootWorkspaceId).not.toBe(seen.rRootWorkspaceId);
    // The state rf-5 read: R's unsaved files ARE in R's old root (so a read that falls back there would serve them).
    expect(seen.rRootOnDisk).toMatchObject({ "report.md": "report, REWRITTEN BY R (unsaved)\n", "notes.md": "R's new notes (unsaved)\n" });
  });

  it("FU-a (NEVER-OK): with P bound, list / resolve / content / download / availability at workspace=auto never serve R's root, and serve P's root", () => {
    neverRsRoot(seen.lateApplied);
    servesPsRoot(seen.lateApplied);
  });

  it("between the cut and P (the task bound to no root), Files does not present R's root as the Task workspace", () => {
    expect(seen.unbound.issue.body).toMatchObject({ executionWorkspaceId: null });
    for (const [name, probe] of Object.entries(seen.unbound)) {
      if (name !== "issue") expect(probe.text, `${name} names R's root`).not.toContain(seen.rRootWorkspaceId);
    }
    expect(seen.unbound.list.status === 200 ? seen.unbound.list.body?.workspace ?? null : null).toBeNull();
    expect(seen.unbound.resolveReport.status).not.toBe(200);
    expect(seen.unbound.contentReport.status).not.toBe(200);
    expect(seen.unbound.downloadReport.status).not.toBe(200);
  });

  it("Recover saved files pressed for R: answered, and it never presents R's root as the task's files (the same exclusion)", () => {
    expect(seen.recover.status).toBeLessThan(500);
    neverRsRoot(seen.afterRecover);
    servesPsRoot(seen.afterRecover);
  });

  it("P2, the turn after P, is a real run on P's root: it never selects R's root", () => {
    expect(seen.p2?.inputs).toBe(4);
    expect(seen.p2?.run).toMatchObject({ runtimeMode: "native", environmentLease: { executionWorkspaceId: seen.pRootWorkspaceId } });
    expect(JSON.stringify(seen.p2?.run)).not.toContain(seen.rRootWorkspaceId);
    expect(String(seen.p2?.providerCwd)).not.toContain(seen.rRootWorkspaceId);
    expect(seen.pRootOnDisk).not.toHaveProperty("notes.md");
    expect(JSON.stringify(seen.pRootOnDisk)).not.toMatch(UNSAVED);
  });

  it("R's old root is KEPT for explicit recovery: its bytes are on disk and its row names it as abandoned, closed and never archived", () => {
    expect(seen.rRootOnDisk).toMatchObject({ "notes.md": "R's new notes (unsaved)\n", "data/keep.txt": SAVED["data/keep.txt"] });
    expect(seen.keptRow).toMatchObject({ status: 200, body: { id: seen.rRootWorkspaceId, cwd: seen.rRoot, status: "active" } });
    expect(seen.keptRow.body.closedAt).toEqual(expect.any(String));
    expect(seen.keptRow.body.metadata?.abandonedTaskRoot).toMatchObject({ runId: seen.rRunId, cwd: seen.rRoot, reason: "copy_back_bound" });
  });
});
