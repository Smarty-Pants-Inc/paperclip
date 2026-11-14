import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode, noticeHeldUnfinishedPredecessor,
  REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT } from "./native-session-executor.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";

const launchMessage = "Pi run.prepare launch does not match the runner-owned qualified profile";
const failure = (commandType = "run.attach", resultMessage = launchMessage) => new Error(
  `native_session_recovery_failed: Error: PRP command ${commandType} failed: ${JSON.stringify({
    commandType, status: "failed", result: { code: "command_execution_failed", message: resultMessage },
  })}`,
);

describe("Runner qualified-launch rejection", () => {
  it.each(["run.attach", "run.prepare"])("classifies %s as terminal instead of retrying the old runner", commandType => {
    const code = nativeSessionFailureSourceCode(failure(commandType));
    expect(code).toBe("native_runner_launch_profile_mismatch");
    expect(nativeSessionFailureDisposition(1, new Date(0), code)).toEqual({
      phase: "terminal_failure", failureCode: "native_runner_launch_profile_mismatch", nextAttemptAt: null,
    });
  });
  it.each(["Pi", "OpenCode", "Cursor Cloud"])("also refuses a %s durable-recovery launch-profile change", provider => {
    const code = nativeSessionFailureSourceCode(failure("run.attach", `${provider} runner launch profile changed across durable recovery`));
    expect(code).toBe("native_runner_launch_profile_mismatch");
    expect(nativeSessionFailureDisposition(1, new Date(0), code).nextAttemptAt).toBeNull();
  });
  it("retains the command receipt through a nested transport cause", () => {
    const cause = Object.assign(new Error("command failed"), { runnerCommandResult: { commandType: "run.attach", status: "failed",
      result: { code: "command_execution_failed", message: launchMessage } } });
    expect(nativeSessionFailureSourceCode(new Error("recovery failed", { cause }))).toBe("native_runner_launch_profile_mismatch");
  });
  it.each([
    new Error(launchMessage),
    new Error("Pi runner launch profile changed across durable recovery"),
    failure("turn.start"),
    failure("run.attach", "run.attach requires a settled session: active_turn"),
    new Error('PRP command run.attach failed: {"status":"failed","result":{"message":"' + launchMessage + '"}}'),
    new Error("Model says: PRP command run.attach failed: " + JSON.stringify({ commandType: "run.attach", status: "failed", result: { code: "command_execution_failed", message: launchMessage } })),
  ])("does not infer a profile rejection from unrelated prose or an incomplete receipt: %s", error => {
    expect(nativeSessionFailureSourceCode(error)).not.toBe("native_runner_launch_profile_mismatch");
  });
});

describe("Pi cold-open after Runner replacement", () => {
  it.each(["live", "already archived", "identical replay", "foreign live"])("archives the process-scoped Pi facade, not its transcript: %s", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "pi-release-archive-"));
    try {
      const runner = join(root, "runner"), archive = join(root, "epoch"), pi = join(root, "pi");
      await Promise.all([mkdir(runner), mkdir(archive), mkdir(pi)]);
      const facade = join(runner, "codex-provider-state.json"), savedFacade = join(archive, "codex-provider-state.json");
      await writeFile(join(runner, "runner-state.json"), "suspended prior authority");
      // This process-scoped snapshot binds C8 paths/digests. It must not be
      // loaded by M1's run.prepare; Pi's session.open restores the independent
      // transcript. This is the existing local-Pi cold-open protocol remotely.
      if (scenario !== "already archived") await writeFile(facade, scenario === "foreign live" ? "foreign state" : "C8 qualified profile");
      if (scenario !== "live") await writeFile(savedFacade, "C8 qualified profile");
      await writeFile(join(pi, "conversation.jsonl"), "prior daily conversation\n");
      const archiveOnce = () => spawnSync("sh", ["-c", REMOTE_RUNNER_AUTHORITY_ARCHIVE_SCRIPT, "pi-release-archive",
        join(runner, "runner-state.json"), archive, join(archive, "runner-state.json"), facade, savedFacade], { encoding: "utf8" });
      expect(archiveOnce().status).toBe(scenario === "foreign live" ? 1 : 0);
      if (scenario === "foreign live") expect(await readFile(facade, "utf8")).toBe("foreign state");
      else {
        await expect(stat(facade)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(savedFacade, "utf8")).toBe("C8 qualified profile");
        expect(archiveOnce().status).toBe(0);
      }
      expect(await readFile(join(pi, "conversation.jsonl"), "utf8")).toBe("prior daily conversation\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("idle-chat launch refusal notice", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runner-launch-profile-refusal-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  it.each(["running", "failed", "durable profile change", "pre-native setup", "stale generation", "wrong owner", "foreign native binding"])("handles the %s run without silence or duplicate notices", async mode => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Daily conversation", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Idle daily chat", status: "todo", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: "daily-person", conversationState: "waiting", conversationSessionGeneration: 1 });
    const foreignIssueId = randomUUID();
    if (mode === "foreign native binding") await db.insert(issues).values({ id: foreignIssueId, companyId, title: "Other task", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: mode === "failed" ? "failed" : "running",
      runtimeMode: "native", nativeIssueId: mode === "pre-native setup" ? null : mode === "foreign native binding" ? foreignIssueId : issueId, nativeSessionId: sessionId,
      contextSnapshot: { issueId, conversationSessionGeneration: mode === "stale generation" ? 0 : 1 } }).returning();
    const input = { db, execution: { provider: { kind: "pi_rpc" }, binding: { companyId, agentId: mode === "wrong owner" ? randomUUID() : agentId,
      issueId, runId: run!.id }, session: { normalizedSessionId: sessionId } } as never };
    // This is the executor wrapper's actual catch/notice entry, not a mocked writer.
    const rejection = mode === "durable profile change" ? failure("run.attach", "Pi runner launch profile changed across durable recovery") : failure();
    await noticeHeldUnfinishedPredecessor(input, rejection);
    await noticeHeldUnfinishedPredecessor(input, rejection);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    if (["stale generation", "wrong owner", "foreign native binding"].includes(mode)) { expect(comments).toHaveLength(0); return; }
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("could not run");
    expect(comments[0]!.body).toContain("preserved");
    expect(comments[0]!.metadata?.authorizationReason).toBe(`runner_launch_profile_mismatch:${run!.id}`);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.nativeSessionId).toBe(sessionId);
  });

  it.each(["writer first", "sweep first"])("keeps ONE notice when the unanswered-message sweep also visits: %s", async order => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sessionId = randomUUID(), messageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Unanswered daily message", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Daily agent", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Idle chat turn", status: "todo", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: "daily-person",
      body: "Continue our earlier work", createdAt: new Date(Date.now() - 180_000) });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: sessionId, error: failure().message, finishedAt: new Date(Date.now() - 120_000),
      contextSnapshot: { wakeCommentId: messageId } }).returning();
    const refuse = () => noticeHeldUnfinishedPredecessor({ db, execution: { provider: { kind: "pi_rpc" },
      binding: { companyId, agentId, issueId, runId: run!.id }, session: { normalizedSessionId: sessionId } } as never }, failure());
    const sweep = () => settleUnansweredPersonMessage(db, { companyId, issueId });
    if (order === "writer first") { await refuse(); expect((await sweep()).kind).toBe("explained"); }
    else { expect((await sweep()).kind).toBe("noticed"); await refuse(); }
    await refuse();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter(comment => comment.authorType === "system")).toHaveLength(1);
    expect(comments.find(comment => comment.id === messageId)?.body).toBe("Continue our earlier work");
  });
});
