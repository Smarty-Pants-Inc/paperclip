import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import type { SessionSnapshot } from "@paperclipai/paperclip-runner";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import corpus from "../../__tests__/fixtures/redact-store-corpus.json" with { type: "json" };
import { redactSensitiveText } from "../../redaction.js";
import { issueService } from "../issues.js";
import { readCompletedAssistantMessageCandidate, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";
import { buildNativeSessionHandoff } from "./native-session-handoff.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeSha256 } from "./canonical.js";
import { createNativeRunLogExporter } from "./native-run-log-export.js";
const { createPiEventProjector } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts", import.meta.url).href) as {
  createPiEventProjector(options: { runId: string; turnId: string; spillDirectory: string }): {
    project(value: unknown): { eventType: string; payload: Record<string, unknown> }[];
  };
};

const { applyPrpEvent, createSessionSnapshotFromMetadata } = await import(new URL("../../../../packages/paperclip-runner/src/reducer/session-reducer.ts", import.meta.url).href) as Pick<
  typeof import("@paperclipai/paperclip-runner"), "applyPrpEvent" | "createSessionSnapshotFromMetadata"
>;
const { buildTranscript } = await import(new URL("../../../../packages/paperclip-runner/src/browser/transcript-model.ts", import.meta.url).href) as {
  buildTranscript(snapshot: SessionSnapshot, events: PrpEvent[]): { kind: string; item?: { text: string } }[];
};

// KEEP: provider credentials must never be stored in agent-authored transcript/comment text.
const keys = ["sk-proj-" + "aB3-_".repeat(8), "sk-ant-api03-" + "cD4-_".repeat(8), "sk-or-v1-" + "a1".repeat(32), "sk-" + "eF5g".repeat(8)];
const echo = keys.join("\n");

describe("redact-store G1/G4 durable boundaries", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("redact-store-");
    db = createDb(temporary.connectionString);
    directory = await mkdtemp(join(tmpdir(), "redact-store-spill-"));
    await db.insert(companies).values({ id: companyId, name: "Storage redaction guard", issuePrefix: "RS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Storage guard", adapterType: "codex_local", status: "running" });
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function fixture() {
    const issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Stored text", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: sessionId, runnerInstanceId: sourceInstanceId, contextSnapshot: { issueId } });
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId, sourceInstanceId,
      controlPlaneSourceInstanceId: "control-" + runId, completionContractId: randomUUID(), completionContractSha256: "guard" });
    const event = (text: string, sourceSeq = 1, payload: Record<string, unknown> = {}): PrpEvent => ({
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId, sourceEventId: `${sourceInstanceId}:${sourceSeq}`,
      sourceSeq, runId, normalizedSessionId: sessionId, turnId: "turn", itemId: "item", eventType: "item.completed", priority: 0,
      emittedAt: "2026-11-18T00:00:00.000Z", payload: { kind: "commandExecution", text, ...payload },
    });
    const stored = () => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    return { issueId, runId, port, event, stored, sourceInstanceId };
  }

  // Never-OK: every durable delta must be safe, not only the final receipt.
  it.each([
    { name: "quote-split", parts: ["'", "Bearer abcdefgh", "'"], secret: "abcdefgh" },
    { name: "header-split", parts: ["Authorization: ", "Bearer abcdefgh"], secret: "abcdefgh" },
    { name: "padded-quote-split", parts: ['\"  ', "Bearer abcdefgh", '  \"'], secret: "abcdefgh" },
    { name: "ansi-scheme", parts: ["Authorization: \u001b[31mBearer abcdefgh\u001b[0m"], secret: "abcdefgh" },
    { name: "ansi-token", parts: ["Authorization: Bearer \u001b[31mabcdefgh\u001b[0m"], secret: "abcdefgh" },
    { name: "ansi-osc", parts: ["Bearer abcd\u001b]0;terminal title\u0007efgh"], secret: "efgh" },
    { name: "live-bearer", parts: ['the Bearer of bad news arrived\n\"Bearer SYNTHabcdefghij\"'], secret: "SYNTHabcdefghij" },
    ...[".", ":", "!", "?", ")", "}", "]", '\"', "'", "`", ",", ";", "a", "-", "_", "/"].map(tail => ({
      name: `marker-tail-${tail.charCodeAt(0)}`, parts: [`Bearer ***REDACTED***${tail}abc123def456ghi789`], secret: "abc123def456ghi789",
    })),
    { name: "bracket-marker-key-tail", parts: ["Bearer [REDACTED]" + keys[0]], secret: keys[0]! },
    { name: "unclosed-marker-tail", parts: ["Bearer [REDACTEDabc123def456ghi789"], secret: "abc123def456ghi789" },
    { name: "marker-space-key", parts: ["Bearer [REDACTED] " + keys[0]], secret: keys[0]! },
    { name: "marker-newline-key", parts: ["Bearer [REDACTED]\n" + keys[0]], secret: keys[0]! },
  ])("rf-2 $name through Pi -> append -> Postgres -> agent comment", async ({ name, parts, secret }) => {
    const f = await fixture();
    const projector = createPiEventProjector({ runId: f.runId, turnId: "turn", spillDirectory: directory });
    const projected = parts.flatMap(delta => projector.project({
      type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
    }));
    projected.push(...projector.project({ type: "message_end", message: {
      role: "assistant", provider: "neutral", model: "model", responseId: "reply", stopReason: "stop",
      content: [{ type: "text", text: parts.join("") }],
    } }));
    let seq = 0;
    for (const event of projected.filter(event => event.payload.kind === "agentMessage")) {
      await f.port.appendEvent({ ...f.event("", ++seq, event.payload), eventType: event.eventType as PrpEvent["eventType"] });
    }
    const rows = await f.stored();
    expect(rows.some(row => (row.payload!.prpEvent as unknown as PrpEvent).eventType === "item.delta")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(secret);
    const stored = rows.map(row => {
      const event = row.payload!.prpEvent as unknown as PrpEvent;
      expect(row.sourcePayloadSha256).toBe(nativeSha256(event));
      return { eventType: event.eventType, text: event.payload.text, hashAgrees: row.sourcePayloadSha256 === nativeSha256(event) };
    });
    const final = stored.find(row => row.eventType === "item.completed")!;
    const posted = await issueService(db).addComment(f.issueId, String(final.text), { agentId, runId: f.runId });
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, posted.id));
    expect(comment!.body).toBe(final.text);
    expect(comment!.body).not.toContain(secret);
    if (name === "live-bearer") {
      expect(final.text).toBe('the Bearer [REDACTED] bad news arrived\n\"Bearer [REDACTED]\"');
      expect(stored.filter(row => row.eventType === "item.delta").map(row => row.text).join("")).toBe(final.text);
    }
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `durable-${name}.json`), JSON.stringify({
      name, runId: f.runId, issueId: f.issueId, parts, stored, comment: comment!.body, syntheticOccurrences: JSON.stringify(rows).split(secret).length - 1,
    }, null, 2) + "\n");
  });

  it("r1 shell-printed provider keys are masked before hash, retry, replay and exporter integrity checks", async () => {
    const f = await fixture();
    const printed = execFileSync("/bin/sh", ["-c", 'printf "%s" "$1"', "guard", echo], { encoding: "utf8" });
    const event = f.event(printed, 1, { output: [{ text: printed }], item: { message: printed }, exitCode: 0 });
    const receipt = await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload.text).toBe(redactSensitiveText(printed));
    expect(JSON.stringify(committed.payload)).not.toContain(keys[0]);
    for (const key of keys) expect(JSON.stringify(committed)).not.toContain(key);
    expect(committed.payload.exitCode).toBe(0);
    expect(committed.payload.output).toEqual([{ text: redactSensitiveText(printed) }]);
    expect(committed.payload.item).toEqual({ message: redactSensitiveText(printed) });
    expect(committed.sourceEventId).toBe(event.sourceEventId);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
    expect(await f.port.appendEvent(event)).toEqual({ ...receipt, disposition: "duplicate" });
    expect(await f.port.appendEvent(committed)).toEqual({ ...receipt, disposition: "duplicate" });
    const replay = await f.port.replayEvents({ runId: f.runId, sourceInstanceId: f.sourceInstanceId, afterSourceSeq: 0, limit: 100 });
    expect(replay.events).toEqual([committed]);
    expect(replay.highestContiguousSourceSeq).toBe(1);
    expect(f.port.normalizeReplayPayload(event.payload)).toEqual(committed.payload);
    const chunks: string[] = [];
    await createNativeRunLogExporter({ db, companyId, runId: f.runId, afterCursor: 0,
      enqueue: async (_cursor, chunk) => { chunks.push(chunk); }, flush: async () => {} }).recover();
    expect(chunks.map(chunk => JSON.parse(chunk).event)).toEqual([committed]);
  });

  it.each(["item.delta", "semantic_tool.result"] as const)("G1 %s text leaves and debug are masked without changing envelope or numeric metrics", async eventType => {
    const f = await fixture();
    const event: PrpEvent = { ...f.event(echo), eventType, debug: { message: echo }, payload: { text: echo, content: [{ text: echo }], inputTokens: 123 } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual({ text: redactSensitiveText(echo), content: [{ text: redactSensitiveText(echo) }], inputTokens: 123 });
    expect(committed.debug).toEqual({ message: redactSensitiveText(echo) });
    expect({ ...committed, payload: event.payload, debug: event.debug }).toEqual(event);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("G1 a schema-valid tool.execution.completed masks output without changing its receipt fields", async () => {
    const f = await fixture();
    const event: PrpEvent = { ...f.event(""), eventType: "tool.execution.completed", payload: {
      schema: "paperclip.tool.execution.v1", executionId: "shell", transport: "process", operation: "execute", status: "completed",
      output: echo, outputBytes: Buffer.byteLength(echo), outputTruncated: false, outputDigest: null,
    } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual({ ...event.payload, output: redactSensitiveText(echo) });
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("F1 turn.completed text/message are masked before storage, hashing, retry, replay and exporter recovery", async () => {
    const f = await fixture();
    const text = "sk-proj-" + "A".repeat(40);
    const event: PrpEvent = { ...f.event(text), eventType: "turn.completed", payload: { text, message: text }, debug: { message: text } };
    const receipt = await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual({ text: "***REDACTED***", message: "***REDACTED***" });
    expect(committed.debug).toEqual({ message: "***REDACTED***" });
    expect({ ...committed, payload: event.payload, debug: event.debug }).toEqual(event);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
    expect(await f.port.appendEvent(event)).toEqual({ ...receipt, disposition: "duplicate" });
    expect(await f.port.appendEvent(committed)).toEqual({ ...receipt, disposition: "duplicate" });
    const replay = await f.port.replayEvents({ runId: f.runId, sourceInstanceId: f.sourceInstanceId, afterSourceSeq: 0, limit: 100 });
    expect(replay.events).toEqual([committed]);
    const chunks: string[] = [];
    await createNativeRunLogExporter({ db, companyId, runId: f.runId, afterCursor: 0,
      enqueue: async (_cursor, chunk) => { chunks.push(chunk); }, flush: async () => {} }).recover();
    expect(chunks.map(chunk => JSON.parse(chunk).event)).toEqual([committed]);
  });

  it.each([
    "runner.diagnostic", "runtime.phase.changed", "workspace.ready", "harness.diagnostic", "plan.updated",
    "research.completed", "delegation.completed", "model.route.changed", "context.compacted", "artifact.generated",
    "review.mode.changed", "hook.completed", "memory.citation.referenced", "safety.review.completed", "terminal.input.sent",
    "wait.completed", "provider.notice.recorded", "session.failed", "mcp_app.tool_result", "runtime_request.created",
    "interaction.response.resolved", "run.result.accepted", "attention.request.proposed", "work.assessment.recorded",
    "issue.status.decision.recorded",
  ] as const)("F1 %s content/debug leaves are masked without changing the envelope", async eventType => {
    const f = await fixture();
    // V2 permits extensible content for these kinds, including diagnostic text.
    const event: PrpEvent = { ...f.event(echo), schema: "paperclip.prp.event.v2", schemaVersion: 2,
      eventType, payload: { text: echo, count: 7 }, debug: { message: echo } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual({ text: redactSensitiveText(echo), count: 7 });
    expect(committed.debug).toEqual({ message: redactSensitiveText(echo) });
    expect({ ...committed, payload: event.payload, debug: event.debug }).toEqual(event);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("F1 v3 external_provider dispatch text/instructions are masked before storage and hash", async () => {
    const f = await fixture();
    const original = f.event(echo);
    const event: PrpEvent = { ...original, schema: "paperclip.prp.event.v3", schemaVersion: 3,
      eventType: "external_provider.dispatch_requested", payload: {
        binding: { companyId, agentId, bindingId: "external", runId: f.runId, normalizedSessionId: original.normalizedSessionId,
          turnId: original.turnId, bindingGeneration: 1, assignmentRevision: 1 },
        text: echo, instructions: echo, acceptByUnixMs: 1, expiresAtUnixMs: 2,
        completionContract: { revision: "1", criterionIds: ["done"] }, tools: [],
      } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual({ ...event.payload, text: redactSensitiveText(echo), instructions: redactSensitiveText(echo) });
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("F2 serialized tool input decodes escaped newlines and recursively masks JSON string leaves", async () => {
    const f = await fixture();
    const providerKey = "sk-proj-" + "B".repeat(40), githubKey = "ghp_" + "C".repeat(36);
    const input = JSON.stringify({ output: "line1\n" + providerKey + "\n" + githubKey,
      nested: [{ text: "line1\n" + providerKey }, JSON.stringify({ output: "line1\n" + githubKey })],
      unchanged: "a \\\"quote\\\" and slash / é", count: 42, enabled: true, nothing: null });
    const expected = input.replaceAll(providerKey, "***REDACTED***").replaceAll(githubKey, "***REDACTED***");
    const event: PrpEvent = { ...f.event(""), eventType: "semantic_tool.input", payload: { input }, debug: { input } };
    const receipt = await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload.input).toBe(expected);
    expect(committed.debug).toEqual({ input: expected });
    expect(JSON.parse(String(committed.payload.input))).toEqual({ ...JSON.parse(input),
      output: "line1\n***REDACTED***\n***REDACTED***",
      nested: [{ text: "line1\n***REDACTED***" }, JSON.stringify({ output: "line1\n***REDACTED***" })] });
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
    expect(f.port.normalizeReplayPayload(event.payload)).toEqual(committed.payload);
    expect(await f.port.appendEvent(event)).toEqual({ ...receipt, disposition: "duplicate" });
    expect(await f.port.appendEvent(committed)).toEqual({ ...receipt, disposition: "duplicate" });
  });

  it.each([
    '  { "text" : "line1\\nno key", "number": 1.00, "escaped": "\\u0061" }\n',
    ' \n[ { "text": "line1\\nno key" }, 1.00, null, true ]  ',
    '{not JSON: line1\\nno key',
  ])("F2 unchanged JSON-looking input remains byte-identical: %s", async input => {
    const f = await fixture();
    const event: PrpEvent = { ...f.event(""), eventType: "semantic_tool.input", payload: { input } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload.input).toBe(input);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("F2 invalid JSON starting with a brace retains the plain-text redaction path", async () => {
    const f = await fixture();
    const input = "{not JSON: line1\n" + keys[0];
    await f.port.appendEvent(f.event("", 1, { input }));
    const [row] = await f.stored();
    expect((row!.payload!.prpEvent as unknown as PrpEvent).payload.input).toBe(redactSensitiveText(input));
  });

  it.each(["sandbox.metric", "usage.reported", "auth.credentials.updated"] as const)("J1 %s masks payload and debug before storage and hashing", async eventType => {
    const f = await fixture();
    const text = "sk-proj-" + "J".repeat(40);
    // auth.credentials.updated has a closed schema: use its permitted string
    // field rather than inventing a text property the real append rejects.
    const payload = eventType === "auth.credentials.updated"
      ? { schema: "paperclip.auth.credentials.updated.v1", provider: text, bindingId: "harness-auth", revision: 1, detection: "credential_store" }
      : { text, count: 7 };
    const event: PrpEvent = { ...f.event(""), schema: "paperclip.prp.event.v2", schemaVersion: 2,
      eventType, payload, debug: { message: text } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload).toEqual(eventType === "auth.credentials.updated"
      ? { ...payload, provider: "***REDACTED***" } : { text: "***REDACTED***", count: 7 });
    expect(committed.debug).toEqual({ message: "***REDACTED***" });
    expect({ ...committed, payload: event.payload, debug: event.debug }).toEqual(event);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("J2 a JSON string-literal leaf decodes escaped newlines and stays valid JSON", async () => {
    const f = await fixture();
    const input = JSON.stringify("line1\n" + "sk-proj-" + "K".repeat(40));
    const event: PrpEvent = { ...f.event(""), eventType: "semantic_tool.input", payload: { input }, debug: { input } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(JSON.parse(String(committed.payload.input))).toBe("line1\n***REDACTED***");
    expect(committed.payload.input).toBe(JSON.stringify("line1\n***REDACTED***"));
    expect(committed.debug).toEqual({ input: committed.payload.input });
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("J3 a 6000-deep JSON array leaf is stored without throwing and masks its key", async () => {
    const f = await fixture();
    const key = "sk-proj-" + "L".repeat(40);
    const input = "[".repeat(6000) + JSON.stringify(key) + "]".repeat(6000);
    const event = f.event("", 1, { input });
    await expect(f.port.appendEvent(event)).resolves.toMatchObject({ disposition: "committed" });
    const [row] = await f.stored();
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    expect(committed.payload.input).toBe(input.replace(key, "***REDACTED***"));
    expect(String(committed.payload.input)).not.toContain(key);
    expect(() => JSON.parse(String(committed.payload.input))).not.toThrow();
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(committed));
  });

  it("J1-J3 an ordinary credential-free event and JSON string keep their exact bytes", async () => {
    const f = await fixture();
    const event: PrpEvent = { ...f.event(""), schema: "paperclip.prp.event.v2", schemaVersion: 2,
      eventType: "sandbox.metric", payload: { text: '  "line1\\nno key \\u0061"  ', status: "ready", count: 7 },
      debug: { message: "ordinary diagnostic\nunchanged" } };
    await f.port.appendEvent(event);
    const [row] = await f.stored();
    expect(row!.payload!.prpEvent).toEqual(event);
    expect((row!.payload!.prpEvent as unknown as PrpEvent).payload.text).toBe(event.payload.text);
    expect((row!.payload!.prpEvent as unknown as PrpEvent).debug).toEqual(event.debug);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(event));
  });

  const four = ["sk-proj-"+"P".repeat(40), "sk-ant-api03-"+"Q".repeat(40), "sk-or-v1-"+"a2".repeat(32), "sk-"+"R".repeat(40)];
  const projectFinal = (f: Awaited<ReturnType<typeof fixture>>, text: string) => createPiEventProjector({ runId: f.runId, turnId: "turn", spillDirectory: directory }).project({ type: "message_end", message: { role: "assistant", provider: "judge", model: "model", responseId: "reply", stopReason: "stop", content: [{type:"text",text}] } }).find(e => e.eventType === "item.completed" && e.payload.kind === "agentMessage")!;
  async function evidence(name:string, event:PrpEvent, row:typeof heartbeatRunEvents.$inferSelect) {
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `${process.env.JUDGE_LABEL ?? "judge"}-${name}.evidence.json`), JSON.stringify({ input:event, stored:row.payload, storedSha:row.sourcePayloadSha256, recomputedSha:nativeSha256(row.payload!.prpEvent) },null,2)+"\n");
  }
  // KEEP: rf-2 F1/F2 guard durable confidentiality and valid-event availability.
  it.each([64,6000])("JUDGE F-new depth %i fallback must not leak keys after escaped newlines",async depth=>{
    const f=await fixture();const raw="[".repeat(depth)+JSON.stringify("line1\n"+four.join("\n"))+"]".repeat(depth);
    const projected=projectFinal(f,raw);expect(projected.payload.text).toBe(raw);
    const event=f.event("",1,projected.payload);await f.port.appendEvent(event);const [row]=await f.stored();await evidence("fallback-"+depth,event,row!);
    const stored=row!.payload!.prpEvent as unknown as PrpEvent;
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(stored));
    for(const key of four) expect(String(stored.payload.text)).not.toContain(key);
    expect(String(stored.payload.text)).toContain("***REDACTED***");
  });
  it("JUDGE F-object credential-free structured payload at depth 70 remains appendable",async()=>{
    const f=await fixture();let nested:unknown={status:"ready",requestId:"req_123"};for(let i=0;i<70;i++) nested={nested};
    const event=f.event("",1,{nested});
    await expect(f.port.appendEvent(event)).resolves.toMatchObject({disposition:"committed"});
    const [row]=await f.stored();expect(row!.payload!.prpEvent).toEqual(event);
  });
  it("JUDGE F-object credential-free structured payload at depth 6000 remains appendable",async()=>{
    const f=await fixture();let nested:unknown={status:"ready",requestId:"req_123"};for(let i=0;i<6000;i++) nested={nested};
    const event=f.event("",1,{nested});
    await expect(f.port.appendEvent(event)).resolves.toMatchObject({disposition:"committed"});
    const [row]=await f.stored();expect(row!.payload!.prpEvent).toEqual(event);
  });

  it("r2 agent comments echoing every provider key are stored and returned masked with run attribution and dedupe", async () => {
    const f = await fixture();
    const svc = issueService(db);
    const actor = { agentId, runId: f.runId };
    const posted = await svc.addComment(f.issueId, echo, actor);
    expect(posted.body).toBe(redactSensitiveText(echo));
    expect(posted.createdByRunId).toBe(f.runId);
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, posted.id));
    expect(stored!.body).toBe(redactSensitiveText(echo));
    expect((await svc.addComment(f.issueId, posted.body, actor)).id).toBe(posted.id);
    expect((await svc.getComment(posted.id))!.body).toBe(posted.body);
  });

  it("r3 a PERSON comment remains byte-equal even when it contains all four key shapes", async () => {
    const f = await fixture();
    const posted = await issueService(db).addComment(f.issueId, echo, { userId: "storage-guard-person" });
    const [stored] = await db.select().from(issueComments).where(eq(issueComments.id, posted.id));
    expect(posted.body).toBe(echo);
    expect(stored!.body).toBe(echo);
  });

  it("iv continuation and transcript readers consume the masked native final message", async () => {
    const f = await fixture();
    await f.port.appendEvent(f.event(echo, 1, { kind: "agentMessage", channel: "final" }));
    const [row] = await f.stored();
    const candidate = readCompletedAssistantMessageCandidate({ seq: row!.seq, prpEvent: row!.payload!.prpEvent });
    expect(candidate!.text).toBe(redactSensitiveText(echo));
    const committed = row!.payload!.prpEvent as unknown as PrpEvent;
    const snapshot = applyPrpEvent(createSessionSnapshotFromMetadata({ fixtureName: "stored-native-text", identity: {
      schema: "paperclip.prp.identity.v1", companyId, issueId: f.issueId, runId: f.runId, environmentLeaseId: "local",
      runnerInstanceId: f.sourceInstanceId, normalizedSessionId: committed.normalizedSessionId, driverSessionId: "thread",
    }, capabilities: { schema: "paperclip.prp.capabilities.v1", sessionReusePolicy: "reuse_per_issue", driver: { kind: "codex", version: "1" },
      steer: true, interrupt: true, resume: true, runtimeRequests: true, structuredResult: true, typedEvents: true } }), committed);
    const transcript = buildTranscript(snapshot, [committed]);
    expect(transcript.filter(entry => entry.kind === "item").map(entry => entry.item!.text)).toEqual([redactSensitiveText(echo)]);
    const handoff = await buildNativeSessionHandoff({ db, companyId, issueId: f.issueId, agentId, before: new Date(Date.now() + 1000) });
    expect(handoff).toContain("***REDACTED***");
    for (const key of keys) expect(handoff).not.toContain(key);
  });

  it.each(["equality", "12000-prefix"])("ii accepted summary %s still chooses the whole masked answer", async mode => {
    const f = await fixture();
    const summary = ("Start " + keys[0] + " " + "s".repeat(12_000)).slice(0, 12_000);
    const answer = mode === "equality" ? summary : summary + " THE_REST_OF_THE_ANSWER";
    await f.port.appendEvent(f.event(answer, 1, { kind: "agentMessage", channel: "final" }));
    const [row] = await f.stored();
    const candidate = readCompletedAssistantMessageCandidate({ seq: row!.seq, prpEvent: row!.payload!.prpEvent });
    const response = resolveHeartbeatRunResponse({ resultJson: { finalizationPhase: "committed", finalizationReasonCode: "external_chat_response_waiting",
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary,
        continuation: { kind: "response_wake", summary: "continue", idempotencyKey: "guard" } } },
      preferFinalResponseOverExistingComment: true, externalChatResponseWakeSummaryAuthorized: true, finalAgentMessage: candidate });
    expect(redactSensitiveText(response.text!)).toBe(redactSensitiveText(answer));
  });

  it.each([249, 251])("r5 %i KiB real Pi final -> native append keeps the base whole/excerpt+spill shape", async kib => {
    const f = await fixture();
    const prefix = "a".repeat(125 * 1024) + " ";
    const answer = prefix + keys[0] + " " + "z".repeat(kib * 1024 - prefix.length - keys[0]!.length - 1);
    const neutral = answer.replace(keys[0]!, "N".repeat(keys[0]!.length));
    const project = (text: string) => createPiEventProjector({ runId: f.runId, turnId: "turn", spillDirectory: directory }).project({
      type: "message_end", message: { role: "assistant", provider: "neutral", model: "model", responseId: "reply", stopReason: "stop", content: [{ type: "text", text }] },
    }).find(event => event.eventType === "item.completed" && event.payload.kind === "agentMessage")!;
    const projected = project(answer), unmasked = project(neutral);
    await f.port.appendEvent(f.event("", 1, projected.payload));
    const [row] = await f.stored();
    const payload = (row!.payload!.prpEvent as unknown as PrpEvent).payload;
    if (kib === 249) {
      expect(payload.text).toBe(redactSensitiveText(answer));
      expect(String(payload.text)).toContain("z".repeat(1000));
      expect(payload).not.toHaveProperty("fullText");
      expect(unmasked.payload.text).toBe(neutral);
    } else {
      expect(payload.text).toBe(unmasked.payload.text);
      expect(String(payload.text)).toMatch(/^This answer is longer than one message/);
      expect(String(payload.text)).toContain("Excerpt (the start of the answer, not the whole answer):");
      const full = projected.payload.fullText as { path: string; bytes: number };
      const neutralFull = unmasked.payload.fullText as { path: string; bytes: number };
      expect(await readFile(full.path, "utf8")).toBe(answer); // Existing spill policy is unchanged by these storage boundaries.
      expect(full.bytes).toBe(neutralFull.bytes);
      expect(String(payload.text).length).toBe(String(unmasked.payload.text).length);
    }
    expect(payload).not.toHaveProperty("truncated");
    const candidate = readCompletedAssistantMessageCandidate({ seq: row!.seq, prpEvent: row!.payload!.prpEvent });
    const response = resolveHeartbeatRunResponse({ resultJson: { nativeResult: { schema: "paperclip.run_result.v1", summary: answer.slice(0, 12_000) } }, finalAgentMessage: candidate });
    expect(response.text).toBe(payload.text);
    const posted = await issueService(db).addComment(f.issueId, response.text!, { agentId, runId: f.runId });
    expect(posted.body).toBe(payload.text);
    expect(row!.sourcePayloadSha256).toBe(nativeSha256(row!.payload!.prpEvent));
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `whole-answer-${kib}.json`), JSON.stringify({
      kib, inputBytes: Buffer.byteLength(answer), storedTextBytes: Buffer.byteLength(String(payload.text)), deliveredBytes: Buffer.byteLength(posted.body),
      whole: kib === 249, spill: !!projected.payload.fullText, sameExcerptAsUnmasked: kib === 251 ? payload.text === unmasked.payload.text : null,
      hashAgrees: row!.sourcePayloadSha256 === nativeSha256(row!.payload!.prpEvent),
    }, null, 2) + "\n");
  });
});

// supersedes(d29fcfe4 bearer-prose expectations; RFL record SUPERSEDE-BEARER-PROSE-1117)
it("r4/r6 all 218 corpus inputs stay byte-equal to base and redaction is idempotent", () => {
  expect(corpus).toHaveLength(218);
  for (const { input, expected } of corpus) {
    expect(redactSensitiveText(input), input).toBe(expected);
    expect(redactSensitiveText(redactSensitiveText(input)), input).toBe(expected);
  }
  for (const key of keys) expect(redactSensitiveText(redactSensitiveText(key))).toBe(redactSensitiveText(key));
});
