// rf-4 U1 F6 (2026-11-19): the warm-candidate scan before a claim is bounded.
// A person waits on it, so past a named candidate cap or an aggregate deadline
// the claim falls back to a cold box. Keeper-level: an adopted inventory can
// hold more matching spares than any target (rf-4: adoption keeps them all).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as keeper from "./ready-spares.js";
import { ReadySpareKeeper, type ReadySpare, type ReadySpareKey, type ReadySpareOperations } from "./ready-spares.js";

const start = Date.UTC(2026, 10, 19, 0, 0, 0);
const key: ReadySpareKey = { companyId: "company-scan", environmentId: "env-scan", configHash: "hash-scan" };
const named = keeper as unknown as Record<string, unknown>;
const CAP = Number(named.MAX_WARM_CLAIM_CANDIDATES ?? 5);
const DEADLINE_MS = Number(named.WARM_CLAIM_DEADLINE_MS ?? 10_000);

function spare(n: number, sick: boolean): ReadySpare {
  const expiry = new Date(start + 1_800_000).toISOString();
  return { id: `bx_scan${n}`, key, state: "idle", warmed: true, expiresAt: expiry, ttlSeconds: 1800,
    name: `paperclip-spare:ready:${key.configHash}`,
    labels: { owner: `paperclip:${key.companyId}`, environment: key.environmentId, purpose: "spare", configHash: key.configHash, expiry },
    providerObservation: { id: `bx_scan${n}`, hydrated: true, hydratedAt: new Date().toISOString(), stop: sick ? { id: `stop_${n}`, status: "failing" } : null } };
}

function setup(boxes: ReadySpare[], getDelayMs = 0, hangIds = new Set<string>()) {
  const gets: string[] = [];
  const claims: string[] = [];
  const ops: ReadySpareOperations = {
    list: async () => boxes.map(box => ({ ...box })),
    // Like the plugin's GET, a read honours the keeper's abort signal.
    get: async (item, signal) => {
      gets.push(item.id);
      const aborted = () => new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (hangIds.has(item.id)) return aborted();
      if (getDelayMs) await Promise.race([new Promise(resolve => setTimeout(resolve, getDelayMs)), aborted()]);
      const box = boxes.find(candidate => candidate.id === item.id);
      return box ? { ...box } : undefined;
    },
    create: async () => { throw new Error("no creates in this row"); },
    claim: async item => { claims.push(item.id); return true; },
    refresh: async item => item,
    stop: async () => undefined,
  };
  const store = { reserve: async () => true, hasClaim: async () => false };
  const k = new ReadySpareKeeper(() => Date.now(), 12, store);
  return { k, ops, gets, claims };
}

async function claimOnFakeClock(k: ReadySpareKeeper, ops: ReadySpareOperations) {
  let done = false;
  const work = k.claimWithOutcome(key, "attempt-scan", 1800, ops, "run-scan").finally(() => { done = true; });
  for (let waited = 0; !done && waited < 120_000; waited += 100) await vi.advanceTimersByTimeAsync(100);
  if (!done) throw new Error("the warm claim did not settle within 120 s on the fake clock");
  return { result: await work, elapsedMs: Date.now() - startedAt };
}
let startedAt = start;

beforeEach(() => { vi.useFakeTimers({ now: start, toFake: ["setTimeout", "clearTimeout", "Date"] }); startedAt = start; });
afterEach(() => { vi.useRealTimers(); });

describe("rf-4 U1 F6: the warm-candidate scan has a candidate cap and an aggregate deadline", () => {
  it("F6-cap 7 adopted candidates, the first 6 sick: at most 5 are read, then the person gets a cold box", async () => {
    expect(CAP, "a named cap, MAX_WARM_CLAIM_CANDIDATES").toBe(5);
    const boxes = [1, 2, 3, 4, 5, 6].map(n => spare(n, true)).concat(spare(7, false));
    const { k, ops, gets, claims } = setup(boxes);
    await k.adopt(key, ops);
    expect(k.ready(key)).toHaveLength(7);
    const { result } = await claimOnFakeClock(k, ops);
    expect(gets.length, "candidate GETs before falling back cold").toBeLessThanOrEqual(CAP);
    expect(result.outcome).toBe("cold");
    expect(claims).toHaveLength(0);
  });
  it("F6-deadline each candidate GET takes 4 s and the first 3 are sick: past 10 s the person gets a cold box", async () => {
    expect(DEADLINE_MS, "a named aggregate deadline, WARM_CLAIM_DEADLINE_MS").toBe(10_000);
    const boxes = [spare(1, true), spare(2, true), spare(3, true), spare(4, false)];
    const { k, ops, gets, claims } = setup(boxes, 4_000);
    await k.adopt(key, ops);
    const { result, elapsedMs } = await claimOnFakeClock(k, ops);
    expect(result.outcome).toBe("cold");
    expect(claims).toHaveLength(0);
    expect(gets.length).toBeLessThan(4);
    expect(elapsedMs, "the whole warm attempt stays inside the aggregate deadline").toBeLessThanOrEqual(DEADLINE_MS + 200);
  });
  it("F6-deadline-hang a candidate GET that never answers: the scan stops at the aggregate deadline and the candidate stays indexed", async () => {
    const boxes = [spare(1, true), spare(2, false)];
    const { k, ops, claims } = setup(boxes, 3_000, new Set(["bx_scan2"]));
    await k.adopt(key, ops);
    const { result, elapsedMs } = await claimOnFakeClock(k, ops);
    expect(result.outcome).toBe("cold");
    expect(claims).toHaveLength(0);
    expect(elapsedMs).toBeLessThanOrEqual(DEADLINE_MS + 200);
    expect(k.ready(key).map(item => item.id), "an unread candidate is never dropped or handed out").toContain("bx_scan2");
  });
  it("F6-CONTROL a healthy candidate behind 2 sick ones inside the budget is still claimed warm", async () => {
    const boxes = [spare(1, true), spare(2, true), spare(3, false)];
    const { k, ops, claims } = setup(boxes, 1_000);
    await k.adopt(key, ops);
    const { result } = await claimOnFakeClock(k, ops);
    expect(result.outcome).toBe("spare");
    expect(claims).toEqual(["bx_scan3"]);
  });
});
