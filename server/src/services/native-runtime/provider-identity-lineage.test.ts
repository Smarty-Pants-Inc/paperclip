import { describe, expect, it } from "vitest";
import { agentTaskSessions, issues, type Db } from "@paperclipai/db";
import {
  appendProviderIdentityReset,
  providerIdentityChainAllows,
  recordedProviderIdentityTransitionIsAllowed,
  noteProviderIdentityBreak,
  clearPendingProviderIdentityBreaksForTest,
  clearProviderIdentityBreak,
  readPendingProviderIdentityBreak,
} from "./provider-identity-lineage.js";

// #20787 J3-17: the reset-record contract. Identities are the objects NSE
// compares: providerSessionIdentityFromDurableProviderState's output for
// pi_rpc ({ providerSessionId: state.threadId, providerBackendSessionId:
// state.providerSessionId }), compared by canonical JSON.
const scope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  taskKey: "33333333-3333-4333-8333-333333333333",
  normalizedSessionId: "44444444-4444-4444-8444-444444444444",
};
const identity = (thread: string) => ({ providerSessionId: thread, providerBackendSessionId: thread, providerSessionIdentity: null });
const record = (generation: number, from: string, to: string, overrides: Record<string, unknown> = {}) => ({
  schema: "paperclip.provider-identity-reset.v1", generation, companyId: scope.companyId, taskKey: scope.taskKey,
  normalizedSessionId: scope.normalizedSessionId, previousIdentity: identity(from), identity: identity(to),
  reason: "config_changed", recordedAt: "2026-11-16T05:51:00.000Z", runId: null, ...overrides,
});

describe("providerIdentityChainAllows", () => {
  const allows = (records: unknown[], previous: string, current: string) =>
    providerIdentityChainAllows({ records, scope, previous: identity(previous), current: identity(current) });

  it("passes a one-step chain", () => {
    expect(allows([record(1, "01a1e203", "01a1e2e9")], "01a1e203", "01a1e2e9")).toBe(true);
  });

  it("passes SMA-67's two-step chain 01a1e203 -> 01a1e2e9 -> 01a1e329", () => {
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(2, "01a1e2e9", "01a1e329")], "01a1e203", "01a1e329")).toBe(true);
    // A backup taken after the first step starts the walk there.
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(2, "01a1e2e9", "01a1e329")], "01a1e2e9", "01a1e329")).toBe(true);
  });

  it("refuses an unrecorded change", () => {
    expect(allows([], "01a1e203", "01a1e2e9")).toBe(false);
    expect(allows([record(1, "01a1e203", "01a1e2e9")], "01a1e203", "foreign-thread")).toBe(false);
  });

  it("refuses a gap in identities or generations", () => {
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(2, "01a1e300", "01a1e329")], "01a1e203", "01a1e329")).toBe(false);
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(3, "01a1e2e9", "01a1e329")], "01a1e203", "01a1e329")).toBe(false);
  });

  it("refuses a record from another session, task or company", () => {
    for (const foreign of [{ normalizedSessionId: "55555555-5555-4555-8555-555555555555" },
      { taskKey: "66666666-6666-4666-8666-666666666666" }, { companyId: "77777777-7777-4777-8777-777777777777" }]) {
      expect(allows([record(1, "01a1e203", "01a1e329", foreign)], "01a1e203", "01a1e329")).toBe(false);
      // A foreign middle link breaks an otherwise matching chain.
      expect(allows([record(1, "01a1e203", "01a1e2e9"), record(2, "01a1e2e9", "01a1e329", foreign)], "01a1e203", "01a1e329")).toBe(false);
    }
  });

  it("refuses a box on a superseded thread, a fork, and malformed records", () => {
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(2, "01a1e2e9", "01a1e329")], "01a1e203", "01a1e2e9")).toBe(false);
    expect(allows([record(1, "01a1e203", "01a1e2e9"), record(1, "01a1e203", "01a1e2ff")], "01a1e203", "01a1e2e9")).toBe(false);
    expect(allows([record(1, "01a1e203", "01a1e2e9", { reason: "anything" })], "01a1e203", "01a1e2e9")).toBe(false);
    expect(allows([record(1, "01a1e203", "01a1e2e9", { schema: "other" })], "01a1e203", "01a1e2e9")).toBe(false);
    expect(providerIdentityChainAllows({ records: [record(1, "a", "b")], scope, previous: null, current: identity("b") })).toBe(false);
  });

  it("compares the whole identity object, not re-derived thread names", () => {
    const swapped = { providerSessionId: "01a1e2e9", providerBackendSessionId: "other-backend", providerSessionIdentity: null };
    expect(providerIdentityChainAllows({ records: [record(1, "01a1e203", "01a1e2e9")], scope,
      previous: identity("01a1e203"), current: swapped })).toBe(false);
  });
});

/** One issue row and one agent_task_sessions row, with the issue → task lock order. */
function conversationDb(resets: unknown[], conversationId = scope.normalizedSessionId) {
  const row = { id: "task-session", sessionParamsJson: { sessionId: conversationId, __paperclipPiConversation: {
    schema: "paperclip.pi-conversation.v1", id: conversationId, generation: 1,
    boundary: { provider: "pi_rpc", cwd: null, workspaceId: null, trust: "trusted" },
    previousId: null, reason: "first_message", runId: "88888888-8888-4888-8888-888888888888", providerIdentityResets: resets,
  } } as Record<string, unknown> };
  const locks: string[] = [];
  const select = () => ({ from: (table: unknown) => {
    const rows = table === issues ? [{ id: scope.taskKey, companyId: scope.companyId }]
      : table === agentTaskSessions ? [structuredClone(row)] : [];
    const query: Record<string, unknown> = { then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) };
    query.where = () => query; query.limit = () => query;
    query.for = (mode: string) => { locks.push(`${table === issues ? "issue" : "task"}:${mode}`); return query; };
    return query;
  } });
  const update = (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
    if (table === agentTaskSessions) Object.assign(row, values);
  } }) });
  const tx = { select, update };
  const db = { select, update, transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(tx) } as unknown as Db;
  const stored = () => ((row.sessionParamsJson as Record<string, any>).__paperclipPiConversation.providerIdentityResets ?? []) as Array<Record<string, unknown>>;
  return { db, row, locks, stored };
}

describe("appendProviderIdentityReset", () => {
  it("writes generation n+1 on the piConversation lineage under the issue then task lock", async () => {
    const fixture = conversationDb([record(1, "01a1e203", "01a1e2e9")]);
    const written = await appendProviderIdentityReset(fixture.db, { scope, previousIdentity: identity("01a1e2e9"),
      identity: identity("01a1e329"), reason: "forced_fresh_session", runId: null, recordedAt: new Date("2026-11-16T07:01:00Z") });
    expect(written).toMatchObject({ generation: 2, reason: "forced_fresh_session", normalizedSessionId: scope.normalizedSessionId,
      taskKey: scope.taskKey, companyId: scope.companyId, recordedAt: "2026-11-16T07:01:00.000Z" });
    expect(fixture.stored().map(entry => entry.generation)).toEqual([1, 2]);
    expect(fixture.locks).toEqual(["issue:no key update", "task:update"]);
    expect(providerIdentityChainAllows({ records: fixture.stored(), scope, previous: identity("01a1e203"), current: identity("01a1e329") })).toBe(true);
  });

  it("refuses a step that does not extend the newest record, and a missing or rotated conversation", async () => {
    const fixture = conversationDb([record(1, "01a1e203", "01a1e2e9")]);
    await expect(appendProviderIdentityReset(fixture.db, { scope, previousIdentity: identity("01a1e203"),
      identity: identity("01a1e329"), reason: "config_changed", runId: null })).rejects.toThrow("provider_identity_reset_chain_broken");
    const rotated = conversationDb([], "99999999-9999-4999-8999-999999999999");
    await expect(appendProviderIdentityReset(rotated.db, { scope, previousIdentity: identity("a"),
      identity: identity("b"), reason: "config_changed", runId: null })).rejects.toThrow("provider_identity_reset_lineage_missing");
    expect(rotated.stored()).toEqual([]);
  });
});

describe("recordedProviderIdentityTransitionIsAllowed", () => {
  it("records a pending same-run replacement once, from the chain's end, and refuses without one", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(false);
    expect(fixture.stored()).toEqual([]);
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(true);
    expect(fixture.stored()).toEqual([expect.objectContaining({ generation: 1, previousIdentity: identity("01a1e203"),
      identity: identity("01a1e2e9"), reason: "resume_failed_on_new_box", runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })]);
    // The note is consumed: a later unrecorded change refuses again.
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      previous: identity("01a1e203"), current: identity("foreign-thread") })).resolves.toBe(false);
    // The durable record alone (after a restart) still allows the recorded thread.
    clearPendingProviderIdentityBreaksForTest();
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(true);
  });

  it("binds a new-box fresh start to that box: another box's state is not recorded", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    // SMA-67 05:51Z: a spare box bx_kuxnh4yq started 01a1e2e9 while the backup named 01a1e203.
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "bx_kuxnh4yq");
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_other",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(false);
    expect(fixture.stored()).toEqual([]);
    // The 06:40Z restart close on the same box records the step.
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_kuxnh4yq",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(true);
    expect(fixture.stored()).toEqual([expect.objectContaining({ generation: 1, previousIdentity: identity("01a1e203"),
      identity: identity("01a1e2e9") })]);
    // 07:00Z after the restart: no note, the record alone resumes 01a1e2e9.
    clearPendingProviderIdentityBreaksForTest();
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_kuxnh4yq",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(true);
  });

  // review-fleet-3 F1 (#20787 J3-21): the note is durable in the run that
  // starts the thread, so a restart BEFORE any suspended read keeps it.
  const conversationOf = (fixture: ReturnType<typeof conversationDb>) =>
    (fixture.row.sessionParamsJson as Record<string, any>).__paperclipPiConversation as Record<string, unknown>;

  it("stores the note durably beside the records, under the issue then task lock", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([record(1, "01a1e203", "01a1e2e9")]);
    await expect(noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "bx_kuxnh4yq", new Date("2026-11-16T05:51:00Z"))).resolves.toBe(true);
    expect(fixture.locks).toEqual(["issue:no key update", "task:update"]);
    expect(conversationOf(fixture).pendingProviderIdentityBreak).toEqual({ reason: "resume_failed_on_new_box",
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", providerLeaseId: "bx_kuxnh4yq", notedAt: "2026-11-16T05:51:00.000Z" });
    // The conversation record and its existing steps are kept as they were.
    expect(conversationOf(fixture)).toMatchObject({ id: scope.normalizedSessionId, generation: 1, reason: "first_message" });
    expect(fixture.stored().map(entry => entry.generation)).toEqual([1]);
  });

  it("a restart before any suspended read keeps the note: the first read records the step and consumes it", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "bx_kuxnh4yq");
    clearPendingProviderIdentityBreaksForTest(); // restart
    // Another box's state is still not recorded after the restart.
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_other",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(false);
    expect(fixture.stored()).toEqual([]);
    expect(await readPendingProviderIdentityBreak(fixture.db, scope)).not.toBeNull();
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_kuxnh4yq",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(true);
    expect(fixture.stored()).toEqual([expect.objectContaining({ generation: 1, previousIdentity: identity("01a1e203"),
      identity: identity("01a1e2e9"), reason: "resume_failed_on_new_box", runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })]);
    expect(conversationOf(fixture).pendingProviderIdentityBreak).toBeUndefined();
    // Consumed once: a later unrecorded change on the same box refuses.
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_kuxnh4yq",
      previous: identity("01a1e203"), current: identity("foreign-thread") })).resolves.toBe(false);
  });

  it("publishing a backup clears the durable note, so a later restart refuses an unrecorded change", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "bx_kuxnh4yq");
    fixture.locks.length = 0;
    await clearProviderIdentityBreak(fixture.db, scope);
    expect(fixture.locks).toEqual(["issue:no key update", "task:update"]);
    expect(conversationOf(fixture).pendingProviderIdentityBreak).toBeUndefined();
    clearPendingProviderIdentityBreaksForTest();
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, providerLeaseId: "bx_kuxnh4yq",
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(false);
    // Nothing to clear takes no lock.
    fixture.locks.length = 0;
    await clearProviderIdentityBreak(fixture.db, scope);
    expect(fixture.locks).toEqual([]);
  });

  it("never writes a note onto a rotated conversation; only this process's copy remains (fail closed after a restart)", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const rotated = conversationDb([], "99999999-9999-4999-8999-999999999999");
    await expect(noteProviderIdentityBreak(rotated.db, scope, "resume_failed_on_new_box", "ffffffff-ffff-4fff-8fff-ffffffffffff"))
      .resolves.toBe(false);
    expect(conversationOf(rotated).pendingProviderIdentityBreak).toBeUndefined();
  });

  it("ignores a malformed durable note", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    conversationOf(fixture).pendingProviderIdentityBreak = { reason: "anything", runId: "x", providerLeaseId: null, notedAt: "now" };
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      previous: identity("01a1e203"), current: identity("01a1e2e9") })).resolves.toBe(false);
    expect(fixture.stored()).toEqual([]);
  });
});

// #20853 PART 2 (ii): the ONE person-visible line, keyed on the provider
// identity ACTUALLY changing (a new record), never on configFreshness.reset.
describe("the person-visible line for a recorded provider-identity step (#20853 PART 2, K6)", () => {
  it("announces a newly recorded step exactly once; a retried read of the same step says nothing again", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    const announced: Array<Record<string, unknown>> = [];
    const onRecorded = (written: Record<string, unknown>) => { announced.push(written); };
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, onRecorded,
      previous: identity("01a1e203"), current: identity("01a1e2e9") } as never)).resolves.toBe(true);
    expect(announced).toEqual([expect.objectContaining({ generation: 1, previousIdentity: identity("01a1e203"),
      identity: identity("01a1e2e9"), reason: "resume_failed_on_new_box" })]);
    // A retried capture of the same state: allowed by the durable record, no second line.
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, onRecorded,
      previous: identity("01a1e203"), current: identity("01a1e2e9") } as never)).resolves.toBe(true);
    // A retried append of the same step (idempotent) is not a new record either.
    await appendProviderIdentityReset(fixture.db, { scope, previousIdentity: identity("01a1e203"), identity: identity("01a1e2e9"),
      reason: "resume_failed_on_new_box", runId: null, onRecorded } as never);
    expect(announced).toHaveLength(1);
    expect(fixture.stored()).toHaveLength(1);
  });

  it("(K6) a restore that kept the same identity records nothing and says nothing, even with a pending break", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    const announced: unknown[] = [];
    await noteProviderIdentityBreak(fixture.db, scope, "config_changed", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope, onRecorded: (r: unknown) => { announced.push(r); },
      previous: identity("01a1e203"), current: { ...identity("01a1e203") } } as never)).resolves.toBe(false);
    expect(announced).toEqual([]);
    expect(fixture.stored()).toEqual([]);
  });

  it("a failing announcement never turns a durable record into a refusal", async () => {
    clearPendingProviderIdentityBreaksForTest();
    const fixture = conversationDb([]);
    await noteProviderIdentityBreak(fixture.db, scope, "resume_failed_on_new_box", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(recordedProviderIdentityTransitionIsAllowed({ db: fixture.db, scope,
      onRecorded: async () => { throw new Error("run log closed"); },
      previous: identity("01a1e203"), current: identity("01a1e2e9") } as never)).resolves.toBe(true);
    expect(fixture.stored()).toHaveLength(1);
  });

  it("says which step happened and whether the chat history was carried", async () => {
    const notice = await import("./provider-identity-reset-notice.js").catch(() => null);
    expect(notice).not.toBeNull();
    const line = notice!.providerIdentityResetLine;
    expect(line({ reason: "resume_failed_on_new_box" }, { carriedHistory: true })).toBe("[paperclip] The agent restarted its session "
      + "because its earlier session could not be resumed on a new machine. This chat's earlier messages were given to the new session as history.\n");
    expect(line({ reason: "config_changed" }, { carriedHistory: false })).toBe("[paperclip] The agent restarted its session "
      + "because its settings changed. The new session does not have this chat's earlier context.\n");
    expect(line({ reason: "forced_fresh_session" }, { carriedHistory: false })).toContain("because a fresh session was requested.");
    // Unknown (e.g. recorded after a restart): no claim either way.
    expect(line({ reason: "resume_failed_on_new_box" }, { carriedHistory: null })).toBe("[paperclip] The agent restarted its session "
      + "because its earlier session could not be resumed on a new machine.\n");
  });
});
