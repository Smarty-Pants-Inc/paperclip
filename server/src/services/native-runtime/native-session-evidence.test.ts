import { describe, expect, it } from "vitest";
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
