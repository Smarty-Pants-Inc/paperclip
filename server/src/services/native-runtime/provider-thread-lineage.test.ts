import { describe, expect, it } from "vitest";
import {
  canonicalProviderIdentity, planProviderThreadReplacement, providerThreadChainLinks, providerThreadRestartLine,
  type ProviderThreadReplacementRecord,
} from "./provider-thread-lineage.js";

// smarty-dev#20853 PART 2 + RECORD CONTRACT. Identities are the manifest's
// providerSessionIdentityFromDurableProviderState objects (pi_rpc shape).
const pi = (thread: string, backend: string) => ({ providerSessionId: thread, providerBackendSessionId: backend, providerSessionIdentity: null });
const A = pi("thread-a", "pi-a"), B = pi("thread-b", "pi-b"), C = pi("thread-c", "pi-c");
const scope = { normalizedSessionId: "11111111-1111-4111-8111-111111111111", companyId: "company-1", taskId: "issue-1" };

function step(previousIdentity: object, identity: object, generation: number): ProviderThreadReplacementRecord {
  const record = planProviderThreadReplacement({ ...scope, runId: `run-${generation}`, previousIdentity, identity,
    reason: "resume_failed_on_new_box", priorRecords: [], now: new Date(Date.UTC(2026, 10, 16, 7, generation)) });
  return { ...record!, generation };
}

describe("provider thread replacement record (#20853 PART 2)", () => {
  it("(R4/R3) a changed identity is recorded with generation+1, the previous identity and a named reason", () => {
    const first = planProviderThreadReplacement({ ...scope, runId: "run-2", previousIdentity: A, identity: B,
      reason: "resume_failed_on_new_box", priorRecords: [] });
    expect(first).toMatchObject({ ...scope, generation: 2, previousIdentity: A, identity: B, reason: "resume_failed_on_new_box",
      schema: "paperclip.provider-thread-replacement.v1" });
    expect(Date.parse(first!.recordedAt)).not.toBeNaN();
    const second = planProviderThreadReplacement({ ...scope, runId: "run-3", previousIdentity: B, identity: C,
      reason: "provider_thread_replaced", priorRecords: [first!] });
    expect(second).toMatchObject({ generation: 3, previousIdentity: B, identity: C });
  });

  it("(K6) the same identity (a restore that kept the thread) is never a replacement, whatever key order", () => {
    expect(planProviderThreadReplacement({ ...scope, runId: "run-2", previousIdentity: A,
      identity: { providerSessionIdentity: null, providerBackendSessionId: "pi-a", providerSessionId: "thread-a" },
      reason: "resume_failed_on_new_box", priorRecords: [] })).toBeNull();
    expect(canonicalProviderIdentity({ b: 1, a: 2 })).toBe(canonicalProviderIdentity({ a: 2, b: 1 }));
  });

  it("the first thread (no previous identity) is not a replacement", () => {
    expect(planProviderThreadReplacement({ ...scope, runId: "run-1", previousIdentity: null, identity: A,
      reason: "resume_failed_on_new_box", priorRecords: [] })).toBeNull();
  });

  it("the person-visible line names the restart and says whether history was carried", () => {
    expect(providerThreadRestartLine({ reason: "resume_failed_on_new_box" }, { carriedHistory: true }))
      .toMatch(/^\[paperclip\] The agent restarted its session because .+ earlier messages were given to the new session as history\.\n$/);
    expect(providerThreadRestartLine({ reason: "provider_thread_replaced" }, { carriedHistory: false }))
      .toMatch(/does not have this chat's earlier context\.\n$/);
  });
});

describe("providerThreadChainLinks (RECORD CONTRACT 2-4)", () => {
  const ab = step(A, B, 2), bc = step(B, C, 3);
  it("a one-step chain links the manifest identity to the current identity", () => {
    expect(providerThreadChainLinks({ ...scope, records: [ab], manifestIdentity: A, currentIdentity: B })).toBe(true);
  });
  it("a two-step chain links (records in any order)", () => {
    expect(providerThreadChainLinks({ ...scope, records: [bc, ab], manifestIdentity: A, currentIdentity: C })).toBe(true);
  });
  it("a gap refuses", () => {
    expect(providerThreadChainLinks({ ...scope, records: [bc], manifestIdentity: A, currentIdentity: C })).toBe(false);
  });
  it("an unrecorded change refuses", () => {
    expect(providerThreadChainLinks({ ...scope, records: [], manifestIdentity: A, currentIdentity: B })).toBe(false);
  });
  it("a record from another session, company or task refuses", () => {
    expect(providerThreadChainLinks({ ...scope, records: [{ ...ab, normalizedSessionId: "22222222-2222-4222-8222-222222222222" }],
      manifestIdentity: A, currentIdentity: B })).toBe(false);
    expect(providerThreadChainLinks({ ...scope, records: [{ ...ab, companyId: "company-2" }], manifestIdentity: A, currentIdentity: B })).toBe(false);
    expect(providerThreadChainLinks({ ...scope, records: [{ ...ab, taskId: "issue-2" }], manifestIdentity: A, currentIdentity: B })).toBe(false);
    // Without an explicit company/task, a chain still cannot cross tasks mid-way.
    expect(providerThreadChainLinks({ normalizedSessionId: scope.normalizedSessionId, records: [ab, { ...bc, taskId: "issue-2" }],
      manifestIdentity: A, currentIdentity: C })).toBe(false);
  });
  it("identical identities are a zero-step chain; a malformed record is ignored", () => {
    expect(providerThreadChainLinks({ ...scope, records: [], manifestIdentity: A, currentIdentity: { ...A } })).toBe(true);
    expect(providerThreadChainLinks({ ...scope, records: [{ ...ab, schema: "other" }], manifestIdentity: A, currentIdentity: B })).toBe(false);
  });
});
