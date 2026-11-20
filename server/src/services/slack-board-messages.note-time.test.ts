import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatActions, chatPublications, type Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mirrorSlackBoardComment } from "./slack-board-messages.js";

// Only external side-effect/identity boundaries are replaced. The real mirror,
// author-type guard, Drizzle table identities and safe publication projection run.
vi.mock("./chat-work-notifications.js", () => ({
  notifyChatPublicationWork: vi.fn(async () => {}),
  notifyChatActionWork: vi.fn(async () => {}),
}));
vi.mock("./activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: async () => ({ enableChatConnectors: true }) }),
}));
vi.mock("./slack-board-authority.js", () => ({
  slackBoardAuthor: async () => ({ id: "principal-1" }),
}));

const iso = "2026-11-20T13:04:00.000Z";
const token = `[${iso}](#paperclip-time=${iso})`;
const note = {
  id: "notice-1", companyId: "company-1", issueId: "task-1",
  authorType: "system", authorAgentId: null, authorUserId: null,
  body: `Your message is saved: "Please keep my exact message." (${token}). Your message wasn't answered.`,
};

type Publication = { payload: { text: string }; commentId: string; state: string };

function recordingDatabase() {
  const publications: Publication[] = [];
  let selects = 0;
  const selectionRows = [
    [{ conversation: { id: "conversation-1" }, endpoint: { id: "endpoint-1", assignedAgentId: "agent-1" } }],
    [{ name: "Paul" }],
    [], // no attachments
  ];
  const db = {
    select() {
      const rows = selectionRows[selects++];
      if (!rows) throw new Error("Unexpected DB read");
      const chain = {
        from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain,
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
      };
      return chain;
    },
    insert(table: unknown) {
      return { values(value: unknown) {
        if (table === chatPublications) publications.push(value as Publication);
        else if (table !== chatActions) throw new Error("Unexpected DB write");
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: "receipt-1" }] }) };
      } };
    },
  } as unknown as Pick<Db, "select" | "insert">;
  return { db, publications, reads: () => selects };
}

function record(name: string, value: unknown) {
  if (process.env.AMMA6_EVIDENCE_DIR) writeFileSync(
    join(process.env.AMMA6_EVIDENCE_DIR, `${process.env.AMMA6_PHASE}-slack-${name}.json`), JSON.stringify(value, null, 2),
  );
}

afterEach(() => vi.restoreAllMocks());

// Keep reason: AMMA6 review-fleet-5 finding 3 is unreachable for these notes.
// Preserve the author-provenance boundary rather than making system notices
// externally publishable merely to exercise Slack date formatting.
describe("AMMA6 real Slack board mirror note reachability", () => {
  it.each([
    ["system", null], ["agent", null],
    // A stray human ID must not turn a system/agent note into a Board send.
    ["system", "user-1"], ["agent", "user-1"],
  ])("does not mirror a %s note (human ID %s)", async (authorType, authorUserId) => {
    const fixture = recordingDatabase();
    const input = { ...note, authorType, authorUserId };
    const result = await mirrorSlackBoardComment(fixture.db, input, { wakeAgent: true });
    record(`${authorType}-${authorUserId ?? "null"}`, { input, result: result ?? null, publications: fixture.publications, dbReads: fixture.reads() });
    expect(fixture.publications).toEqual([]);
    expect(fixture.reads()).toBe(0);
  });

  it("records an authenticated human mirror as the positive control, using the real projection", async () => {
    const fixture = recordingDatabase();
    const input = { ...note, id: "human-1", authorType: "user", authorUserId: "user-1" };
    await mirrorSlackBoardComment(fixture.db, input, { wakeAgent: true });
    record("human-control", {
      input, publications: fixture.publications,
      epoch: Date.parse(iso) / 1000,
      note: "This is an explicitly authored human message, not an automatic system note.",
    });
    expect(Date.parse(iso) / 1000).toBe(1795179840);
    expect(fixture.publications).toHaveLength(1);
    expect(fixture.publications[0]).toMatchObject({ commentId: "human-1", state: "pending" });
    expect(fixture.publications[0].payload.text).toContain("Paul (via Paperclip)");
    // The existing safe projection already strips non-public Markdown hrefs;
    // even this human control does NOT mirror literal #paperclip-time markup.
    expect(fixture.publications[0].payload.text).toContain(iso);
    expect(fixture.publications[0].payload.text).not.toContain("#paperclip-time");
  });
});
