import { describe, expect, it, vi } from "vitest";
import { nativeSessionEvidenceCopies, scheduleNativeSessionEvidenceCopy, type NativeSessionEvidenceSource } from "./native-session-evidence.js";

// RFL condition 1: the turn path only pays for starting the copy. Every remote
// read, upload and retry happens after the scheduling call has returned.
describe("native session evidence copy scheduling", () => {
  it("returns to the turn path before any remote read, even when the box never answers", async () => {
    let remoteCalls = 0;
    let releaseRunner!: () => void;
    const stalled = new Promise<void>(resolveStall => { releaseRunner = resolveStall; });
    const source: NativeSessionEvidenceSource = {
      runner: { execute: async () => { remoteCalls++; await stalled; return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() }; } },
      sessionScopeDigest: "0".repeat(64), normalizedSessionId: "session", providerLeaseId: "box",
      environmentId: null, environmentLeaseId: null, directories: [{ name: "codex-home", sourcePath: "/nonexistent", excludeEntries: [] }],
    };
    const samples: number[] = [];
    const copies: Array<Promise<unknown>> = [];
    for (let index = 0; index < 200; index++) {
      const started = performance.now();
      copies.push(scheduleNativeSessionEvidenceCopy({ db: {} as never, source, companyId: "company", issueId: "issue", runId: `run-${index}` }));
      samples.push(performance.now() - started);
    }
    expect(remoteCalls).toBe(0);
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)]!, p99 = samples[Math.floor(samples.length * 0.99)]!, max = samples.at(-1)!;
    console.log(JSON.stringify({ evidenceScheduleTurnPathMs: { p50: Number(p50.toFixed(4)), p99: Number(p99.toFixed(4)), max: Number(max.toFixed(4)) } }));
    expect(p99).toBeLessThan(50);
    // Same run twice: one copy, not two.
    expect(scheduleNativeSessionEvidenceCopy({ db: {} as never, source, companyId: "company", issueId: "issue", runId: "run-0" })).toBe(copies[0]);
    releaseRunner();
    // No db/lease in this probe: each copy ends pending (never complete), without throwing.
    const { nativeSessionEvidenceRetry } = await import("./native-session-evidence.js");
    nativeSessionEvidenceRetry.delayMs = 1;
    const outcomes = await Promise.all(copies);
    expect(outcomes.every(outcome => (outcome as { status: string }).status === "pending")).toBe(true);
    expect(nativeSessionEvidenceCopies.size).toBe(0);
  }, 60_000);
});

// Real server lifecycle with embedded PostgreSQL and a held provider read.
it("after real server shutdown no evidence timer or copy promise remains", async () => {
  const { randomUUID } = await import("node:crypto");
  const { createDb, companies, environmentLeases } = await import("@paperclipai/db");
  const { startRecoveryPostgres } = await import("../../__tests__/helpers/recovery-postgres.js");
  const evidence = await import("./native-session-evidence.js");
  const { nativeSessionEvidenceRetry } = evidence;
  // Observe the real join rather than timing server shutdown. Removing its call
  // lets shutdown win while the provider read is held: the copy map stays at 1.
  let joining!: () => void;
  const joinReached = new Promise<void>(resolve => { joining = resolve; });
  const originalJoin = evidence.joinNativeSessionEvidenceCopies;
  const joinSpy = vi.spyOn(evidence, "joinNativeSessionEvidenceCopies").mockImplementation(async source => {
    if (source === undefined) joining();
    await originalJoin(source);
  });
  let stopping: Promise<void> | undefined;
  const database = await startRecoveryPostgres("evidence-stop-real-server-");
  const db = createDb(database.connectionString);
  let server: Awaited<ReturnType<typeof import("../../index.js")["startServer"]>> | undefined;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const attempts = nativeSessionEvidenceRetry.attempts;
  nativeSessionEvidenceRetry.attempts = 1;
  try {
    vi.stubEnv("DATABASE_URL", database.connectionString);
    vi.stubEnv("PAPERCLIP_DISABLE_CWD_ENV_FILE", "true");
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "local_trusted");
    vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
    vi.stubEnv("PAPERCLIP_TELEMETRY_DISABLED", "1");
    vi.stubEnv("PAPERCLIP_OPEN_ON_LISTEN", "false");
    vi.stubEnv("PAPERCLIP_UPDATE_CHECK", "0");
    vi.stubEnv("PAPERCLIP_NO_BROWSER", "true");
    vi.stubEnv("HEARTBEAT_SCHEDULER_ENABLED", "false");
    vi.stubEnv("SERVE_UI", "false");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("PORT", "3997");
    const { startServer } = await import("../../index.js");
    server = await startServer();
    const companyId = randomUUID(), leaseId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Evidence lifecycle probe", issuePrefix: "STOP" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, status: "released", providerLeaseId: "fixture-box" });
    const copy = scheduleNativeSessionEvidenceCopy({ db, companyId, issueId: randomUUID(), runId,
      source: { environmentLeaseId: leaseId, environmentId: null, providerLeaseId: "fixture-box",
        normalizedSessionId: randomUUID(), sessionScopeDigest: "a".repeat(64),
        directories: [{ name: "trace", sourcePath: "/fixture-trace", excludeEntries: [] }],
        runner: { execute: async () => { entered(); await gate; return { exitCode: 1, timedOut: false,
          signal: null, stdout: "", stderr: "controlled source unavailable", pid: null, startedAt: new Date().toISOString() }; } } } });
    expect(await copy.admitted).toBe(true);
    await reached;
    stopping = server.shutdown();
    const reachedJoin = await Promise.race([joinReached.then(() => true), stopping.then(() => false)]);
    if (reachedJoin) release();
    await stopping;
    server = undefined;
    expect(nativeSessionEvidenceCopies.size, "shutdown returned with live evidence work").toBe(0);
  } finally {
    release();
    await Promise.all([...nativeSessionEvidenceCopies.values()]);
    await stopping;
    await server?.shutdown();
    joinSpy.mockRestore();
    nativeSessionEvidenceRetry.attempts = attempts;
    await db.$client.end({ timeout: 1 });
    await database.cleanup();
    vi.unstubAllEnvs();
  }
}, 120_000);
