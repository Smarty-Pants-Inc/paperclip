import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { redactSensitiveText, STRICT_CREDENTIAL_SHAPES } from "../../redaction.js";
import { subscribeCompanyLiveEvents } from "../live-events.js";
import { CREDENTIAL_SHAPE_HOLD_CAP, createAgentIdentityRedactor, credentialShapeHoldStart } from "../agent-identity-redaction.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeSha256 } from "./canonical.js";

// KEEP (never-OK): a credential split across answer deltas must not reach a
// stored delta, its hash, or a live event. Synthetic values only.
const T40 = "Q7ZX" + "q7zx9KJW".repeat(4) + "M3VB";
const sig = "Zq9XwV7kLm3NpR5tYb2HcJ8dFg6SaUeQ4oTiWxYzAbC";
const rows: { name: string; text: string; secret: string }[] = [
  { name: "bearer", text: `Bearer ${T40}`, secret: T40 },
  { name: "authorization-bearer", text: `Authorization: Bearer ${T40}`, secret: T40 },
  { name: "sk-proj", text: `sk-proj-${T40}`, secret: T40 },
  { name: "ghp", text: `ghp_${T40.slice(0, 36)}`, secret: T40.slice(0, 36) },
  { name: "github_pat", text: `github_pat_11${T40.slice(0, 20)}_${T40}${T40.slice(0, 19)}`, secret: T40 },
  { name: "jwt", text: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.${sig}`, secret: sig },
  { name: "aws-key-id", text: "AKIAQ7ZX9KJWM3VB5TYN", secret: "Q7ZX9KJWM3VB5TYN" },
  { name: "ansi-scheme", text: `Authorization: \u001b[31mBearer ${T40}\u001b[0m`, secret: T40 },
  { name: "ansi-token", text: `Authorization: Bearer \u001b[31m${T40}\u001b[0m`, secret: T40 },
  { name: "json-escaped", text: `{\\"Authorization\\":\\"Bearer ${T40}\\"}`, secret: T40 },
  { name: "json", text: `{"authorization": "Bearer ${T40}"}`, secret: T40 },
  { name: "header-split", text: "Authorization: Bearer abcdefgh", secret: "abcdefgh" },
  { name: "quote-split", text: "'Bearer abcdefgh'", secret: "abcdefgh" },
  { name: "padded-quote-split", text: '"  Bearer abcdefgh  "', secret: "abcdefgh" },
];
const embedded = rows.map(row => ({ ...row, name: `${row.name}+prose`, text: `The value is ${row.text}\nand then more words follow.` }));
const allRows = [...rows, ...embedded];
const windows = (secret: string, size = 4) => Array.from({ length: secret.length - size + 1 }, (_, index) => secret.slice(index, index + size));
const leaked = (text: string, secret: string) => windows(secret).some(window => text.includes(window));
const cuts2 = (text: string) => Array.from({ length: text.length - 1 }, (_, index) => [text.slice(0, index + 1), text.slice(index + 1)]);
function* cuts3(text: string, near?: number) {
  for (let first = 1; first < text.length - 1; first++) {
    for (let second = first + 1; second < text.length; second++) {
      if (near !== undefined && second - first > near) break;
      yield [text.slice(0, first), text.slice(first, second), text.slice(second)];
    }
  }
}
/** The append path's order: the buffer, then the per-event strict scan. */
function throughBuffer(parts: string[], terminal = true) {
  const redactor = createAgentIdentityRedactor();
  const deltas = parts.map(text => redactSensitiveText(String(redactor.delta("source:turn:item", { kind: "agentMessage", text }, "item").text)));
  const settled = terminal ? redactor.settleDeltas("source:turn:item", { kind: "agentMessage" }, false) as Record<string, unknown> : {};
  const tails = ((settled.outputTails ?? []) as { payload: { text: string } }[]).map(tail => redactSensitiveText(tail.payload.text));
  return { deltas, tails };
}
const out = (name: string, value: unknown) => {
  if (process.env.TASK_OUT) writeFileSync(join(process.env.TASK_OUT, name), JSON.stringify(value, null, 2) + "\n");
};

describe("strict credential shapes split across answer deltas", () => {
  it("the hold reads the scanner's own shape table: every listed shape is masked whole", () => {
    for (const row of rows) expect(leaked(redactSensitiveText(row.text), row.secret), row.name).toBe(false);
    const samples: Record<string, string> = { "sk-": `sk-${T40}`, AKIA: "AKIAQ7ZX9KJWM3VB5TYN", eyJ: rows[5]!.text,
      github_pat_: rows[4]!.text };
    for (const prefix of STRICT_CREDENTIAL_SHAPES.tokenPrefixes) {
      const sample = samples[prefix] ?? `${prefix}${T40.slice(0, 36)}`;
      expect(redactSensitiveText(`key ${sample} end`), prefix).toBe("key ***REDACTED*** end");
      // Every proper prefix of a listed shape is held at the end of a delta.
      for (let size = 1; size <= sample.length; size++) expect(credentialShapeHoldStart(`key ${sample.slice(0, size)}`), `${prefix}:${size}`).toBe(4);
    }
    for (const word of [STRICT_CREDENTIAL_SHAPES.headerWord, ...STRICT_CREDENTIAL_SHAPES.schemeWords.slice(0, 1)]) {
      for (let size = 1; size <= word.length; size++) expect(credentialShapeHoldStart(`x. ${word.slice(0, size)}`), `${word}:${size}`).toBe(3);
    }
  });

  it("no token piece in any delta or tail, at every byte boundary across 2 and 3 deltas", () => {
    const report: Record<string, unknown>[] = [];
    for (const row of allRows) {
      const whole = redactSensitiveText(row.text);
      let cases = 0, maxHold = 0, unequal = 0;
      const check = (parts: string[]) => {
        cases++;
        const { deltas, tails } = throughBuffer(parts);
        for (const piece of [...deltas, ...tails]) {
          if (leaked(piece, row.secret)) throw new Error(`${row.name}: ${JSON.stringify(parts)} stored ${JSON.stringify(piece)}`);
        }
        expect(tails.length, `${row.name}: one settle at most`).toBeLessThanOrEqual(1);
        if ([...deltas, ...tails].join("") !== whole) unequal++;
        maxHold = Math.max(maxHold, ...tails.map(tail => tail.length));
        // Without a terminal event the held fragment is in memory only.
        for (const piece of throughBuffer(parts, false).deltas) expect(leaked(piece, row.secret)).toBe(false);
      };
      for (const parts of cuts2(row.text)) check(parts);
      for (const parts of cuts3(row.text)) check(parts);
      report.push({ row: row.name, length: row.text.length, cases, joinedDiffersFromWholeScan: unequal, maxSettledTail: maxHold });
    }
    out("rows-buffer.json", report);
    expect(report.reduce((sum, row) => sum + Number(row.cases), 0)).toBeGreaterThan(50_000);
  }, 240_000);

  // Ordinary answers still stream: nothing lost, repeated or reordered, and a
  // held fragment leaves with the next delta or two.
  const prose = [
    "The Bearer of bad news arrived early, and a task-list was ready. Ask the author about authorization;",
    "it's a bear market, he said, so skip the basics. Keys such as `id` stay; gh is a CLI, sk is a suffix.",
    "A JSON reader sees {\"a\": 1, \"b\": [2, 3]} and 'single quotes' too. See eye-level notes, AK and AKI.",
    "",
    "Second paragraph: because beautiful beasts bear burdens, authors authorize a basic plan. Done.",
  ].join("\n");
  function chunked(text: string, max: number, seed: number) {
    const parts: string[] = [];
    for (let at = 0; at < text.length;) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const size = 1 + (seed % max);
      parts.push(text.slice(at, at + size));
      at += size;
    }
    return parts;
  }
  it("an interrupted bare shape and a known-secret tail after the cap cannot enter outputTails raw", () => {
    for (const prefix of ["eyJhbGciOiJIUzI1NiJ9", "sk-proj-"]) {
      const result = throughBuffer([prefix]);
      expect(result).toEqual({ deltas: [""], tails: ["***REDACTED***"] });
    }
    const redactor = createAgentIdentityRedactor();
    redactor.values.push("ZZZZZZZZZZ");
    const first = redactor.delta("source:turn:item", { text: "eyJ" + "QUJD".repeat(5_000) });
    const last = redactor.delta("source:turn:item", { text: "ZZZZ" });
    const settled = redactor.settleDeltas("source:turn:item", {}, false);
    expect(first.text).toBe("***REDACTED***");
    expect(last.text).toBe("");
    expect(settled).toEqual({});
  });

  it("ordinary prose is neither lost, repeated nor reordered, and stays progressive", () => {
    expect(redactSensitiveText(prose)).toBe(prose);
    const report: Record<string, unknown>[] = [];
    for (const [max, seeds] of [[1, 1], [4, 40], [12, 40], [40, 40]] as const) {
      let maxHeld = 0, maxDelay = 0, heldDeltas = 0, deltasTotal = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const parts = chunked(prose, max, seed);
        const redactor = createAgentIdentityRedactor();
        let received = 0, released = 0;
        const waiting: number[] = [];
        let joined = "";
        parts.forEach((text, index) => {
          const output = String(redactor.delta("source:turn:item", { kind: "agentMessage", text }, "item").text);
          expect(redactSensitiveText(output)).toBe(output);
          joined += output;
          received += text.length;
          released += output.length;
          waiting.push(index);
          // Deltas whose text is fully released leave the queue; the oldest left shows the delay.
          let arrived = 0;
          const ends = parts.slice(0, index + 1).map(part => arrived += part.length);
          while (waiting.length && ends[waiting[0]!]! <= released) waiting.shift();
          if (waiting.length) { heldDeltas++; maxDelay = Math.max(maxDelay, index - waiting[0]! + 1); }
          maxHeld = Math.max(maxHeld, received - released);
        });
        deltasTotal += parts.length;
        const settled = redactor.settleDeltas("source:turn:item", { kind: "agentMessage" }, false) as Record<string, unknown>;
        const tails = (settled.outputTails ?? []) as { payload: { text: string } }[];
        expect(joined + tails.map(tail => tail.payload.text).join("")).toBe(prose);
      }
      report.push({ maxDeltaChars: max, deltas: deltasTotal, deltasEndingWithHeldText: heldDeltas, maxHeldChars: maxHeld, maxDelayInDeltas: maxDelay });
      expect(maxHeld).toBeLessThanOrEqual(48);
    }
    out("prose-progressive.json", report);
  });

  it("a value longer than the hold cap is released masked and its remainder dropped; a long plain run is kept whole", () => {
    const long = "Q7ZX".repeat(6_000);
    const credential = throughBuffer(["Bearer ", ...chunked(long, 997, 7), " tail words"]);
    expect([...credential.deltas, ...credential.tails].join("")).toBe("Bearer ***REDACTED*** tail words");
    // A non-shape blob is prose; an open eyJ shape past the bound is not.
    const suspicious = throughBuffer(["eyJ" + "QUJD".repeat(10_000)]);
    expect([...suspicious.deltas, ...suspicious.tails].join("")).toBe("***REDACTED***");
    const blob = "QUJD".repeat(10_000);
    const plain = throughBuffer(["blob ", ...chunked(blob, 997, 7), " end"]);
    expect([...plain.deltas, ...plain.tails].join("")).toBe(`blob ${blob} end`);
    expect(CREDENTIAL_SHAPE_HOLD_CAP).toBe(16_384);
  });
});

describe("split credential shapes through the real append, Postgres and the live stream", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  const published: { payload: Record<string, unknown> }[] = [];
  let unsubscribe: () => void;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("split-shape-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Split shape guard", issuePrefix: "SS" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Split guard", adapterType: "codex_local", status: "running" });
    unsubscribe = subscribeCompanyLiveEvents(companyId, event => { published.push(event as never); });
  }, 30_000);
  afterAll(async () => { unsubscribe?.(); await temporary?.cleanup(); });
  async function fixture() {
    const issueId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Split text", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: sessionId, runnerInstanceId: sourceInstanceId, contextSnapshot: { issueId } });
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId, sourceInstanceId,
      controlPlaneSourceInstanceId: "control-" + runId, completionContractId: randomUUID(), completionContractSha256: "guard" });
    let sourceSeq = 0;
    const event = (eventType: string, itemId: string | undefined, payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId, sourceEventId: `${sourceInstanceId}:${++sourceSeq}`,
      sourceSeq, runId, normalizedSessionId: sessionId, turnId: "turn", ...(itemId ? { itemId } : {}), eventType: eventType as PrpEvent["eventType"],
      priority: 0, emittedAt: "2026-11-18T00:00:00.000Z", payload,
    });
    const stored = async () => (await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq)))
      .map(row => {
        const committed = row.payload!.prpEvent as unknown as PrpEvent;
        // Stored bytes are the hashed bytes.
        expect(row.sourcePayloadSha256).toBe(nativeSha256(committed));
        return committed;
      });
    const live = () => published.filter(entry => entry.payload.runId === runId);
    return { runId, port, event, stored, live };
  }
  const tailsOf = (event: PrpEvent) => ((event.payload.outputTails ?? []) as { itemId?: string; payload: { text: string; executionId?: string } }[]);

  it("no token in any stored delta, hash or published event, at every byte boundary", async () => {
    const report: Record<string, unknown>[] = [];
    for (const row of allRows) {
      const f = await fixture();
      const cases: { itemId: string; parts: string[] }[] = [];
      for (const parts of [...cuts2(row.text), ...(row.name.includes("+prose") ? [] : cuts3(row.text, 1))]) {
        const itemId = `case-${cases.length}`;
        cases.push({ itemId, parts });
        for (const text of parts) await f.port.appendEvent(f.event("item.delta", itemId, { itemId, kind: "agentMessage", text }));
        await f.port.appendEvent(f.event("item.completed", itemId, { itemId, kind: "agentMessage", text: row.text }));
      }
      const events = await f.stored(), live = f.live();
      expect(events.length).toBe(cases.reduce((sum, entry) => sum + entry.parts.length + 1, 0));
      // Every committed event was published, with the committed bytes.
      expect(live.length).toBe(events.length);
      for (const text of [JSON.stringify(events), JSON.stringify(live)]) {
        for (const window of windows(row.secret, Math.min(8, row.secret.length))) expect(text.includes(window), `${row.name}:${window}`).toBe(false);
      }
      const byItem = new Map<string, PrpEvent[]>();
      for (const event of events) byItem.set(event.itemId!, [...(byItem.get(event.itemId!) ?? []), event]);
      let settledTails = 0, maxTail = 0;
      for (const entry of cases) {
        const own = byItem.get(entry.itemId)!;
        const deltas = own.filter(event => event.eventType === "item.delta"), final = own.at(-1)!;
        expect(final.eventType).toBe("item.completed");
        for (const event of own) {
          if (leaked(String(event.payload.text ?? ""), row.secret) || tailsOf(event).some(tail => leaked(tail.payload.text, row.secret))) {
            throw new Error(`${row.name}: ${JSON.stringify(entry.parts)} stored ${JSON.stringify(event.payload)}`);
          }
        }
        // A held fragment is settled once, masked, by the terminal event; deltas never carry tails.
        expect(deltas.every(event => tailsOf(event).length === 0)).toBe(true);
        expect(tailsOf(final).length).toBeLessThanOrEqual(1);
        settledTails += tailsOf(final).length;
        maxTail = Math.max(maxTail, ...tailsOf(final).map(tail => tail.payload.text.length));
        // supersedes(split json row form: either masked marker form; RFL record SUPERSEDE-REDACT-COMPOSE-AUTHZ-MARKER-1118)
        // A stored JSON text is masked leaf by leaf (`{"authorization":"Bearer ***REDACTED***"}`); the
        // plain scan masks the whole value (`{"authorization": "***REDACTED***"}`). Both are masked.
        if (row.name === "json") {
          expect(leaked(String(final.payload.text), row.secret)).toBe(false);
          expect([redactSensitiveText(row.text), '{"authorization":"Bearer ***REDACTED***"}']).toContain(final.payload.text);
        } else {
          expect(final.payload.text).toBe(redactSensitiveText(row.text));
        }
      }
      report.push({ row: row.name, cases: cases.length, storedEvents: events.length, publishedEvents: live.length,
        casesSettledByTerminal: settledTails, maxSettledTailChars: maxTail, tokenInStoredOrPublished: false });
    }
    out("rows-append-postgres-live.json", report);
  }, 280_000);

  it.each([
    ["two", ["Bearer ", T40]],
    ["three", ["Bea", "rer ", T40]],
    ["three-token-pieces", ["Bearer ", T40.slice(0, 17), T40.slice(17)]],
  ] as const)("N1 tool progress %s stores and publishes zero key material before settling once", async (_name, parts) => {
    const f = await fixture();
    const tool = { schema: "paperclip.tool.execution.v1", executionId: "execution-a", transport: "process", operation: "execute", status: "running", outputBytes: 0, outputTruncated: false, outputDigest: null };
    for (const output of parts) {
      await f.port.appendEvent(f.event("tool.execution.progressed", "tool", { ...tool, output }));
      // Own-event checks happen while the stream is still live, not after a join.
      for (const event of await f.stored()) expect(leaked(JSON.stringify(event.payload), T40)).toBe(false);
      for (const live of f.live()) expect(leaked(JSON.stringify(live.payload), T40)).toBe(false);
    }
    const terminal = f.event("tool.execution.completed", "tool", { ...tool, status: "completed", output: parts.join("") });
    await f.port.appendEvent(terminal);
    expect((await f.port.appendEvent(terminal)).disposition).toBe("duplicate");
    await f.port.appendEvent(f.event("turn.completed", undefined, { status: "completed" }));
    const events = await f.stored();
    const final = events.find(event => event.eventType === "tool.execution.completed")!;
    expect(final.payload.output).toBe("Bearer ***REDACTED***");
    expect(final.payload.outputTails).toEqual([{ itemId: "tool", payload: { executionId: "execution-a", text: "Bearer ***REDACTED***" } }]);
    const joined = events.filter(event => event.eventType === "tool.execution.progressed").map(event => event.payload.output).join("")
      + events.flatMap(tailsOf).map(tail => tail.payload.text).join("");
    expect(joined).toBe("Bearer ***REDACTED***");
    expect(events.flatMap(tailsOf)).toHaveLength(1);
    expect(f.live()).toHaveLength(events.length);
    for (const event of events) expect(leaked(JSON.stringify(event.payload), T40)).toBe(false);
    for (const live of f.live()) expect(leaked(JSON.stringify(live.payload), T40)).toBe(false);
    out(`n1-${_name}.json`, { events, live: f.live() });
  });

  it.each(["failed", "cancelled"])("N1 tool terminal status %s settles its own execution, not its neighbour", async status => {
    const f = await fixture();
    const tool = (executionId: string) => ({ schema: "paperclip.tool.execution.v1", executionId, transport: "process", operation: "execute", status: "running", outputBytes: 0, outputTruncated: false, outputDigest: null });
    for (const executionId of ["a", "b"]) await f.port.appendEvent(f.event("tool.execution.progressed", "shared", { ...tool(executionId), output: "Bearer " + T40 }));
    await f.port.appendEvent(f.event("tool.execution.completed", "shared", { ...tool("a"), status, output: "Bearer " + T40 }));
    const before = await f.stored();
    expect(before.flatMap(tailsOf).map(tail => tail.payload.executionId)).toEqual(["a"]);
    await f.port.appendEvent(f.event("turn.cancelled", undefined, { status: "cancelled" }));
    const events = await f.stored();
    expect(events.flatMap(tailsOf).map(tail => tail.payload.executionId)).toEqual(["a", "b"]);
    for (const event of events) expect(leaked(JSON.stringify(event.payload), T40)).toBe(false);
    for (const live of f.live()) expect(leaked(JSON.stringify(live.payload), T40)).toBe(false);
  });

  it("N1 tool progress prose joins unchanged, isolates executions and settles on run terminals", async () => {
    for (const terminalType of ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted", "session.closed", "run.terminal"]) {
      const f = await fixture();
      const tool = (executionId: string, output: string) => ({ schema: "paperclip.tool.execution.v1", executionId, transport: "process", operation: "execute", status: "running", output, outputBytes: Buffer.byteLength(output), outputTruncated: false, outputDigest: null });
      // Same envelope itemId, different executionId: no cross-tool context.
      for (const part of ["Progress: ", "building a task-list", ", done."]) {
        await f.port.appendEvent(f.event("tool.execution.progressed", "shared", tool("prose", part)));
      }
      await f.port.appendEvent(f.event("tool.execution.progressed", "shared", tool("credential", "Bearer " + T40)));
      const terminal = f.event(terminalType, undefined, { status: "ended" });
      await f.port.appendEvent(terminalType === "run.terminal" ? { ...terminal, schema: "paperclip.prp.event.v3", schemaVersion: 3 } : terminal);
      const events = await f.stored();
      const proseEvents = events.filter(event => event.payload.executionId === "prose");
      const tails = events.flatMap(tailsOf);
      expect(proseEvents.map(event => event.payload.output).join("") + tails.filter(tail => tail.payload.executionId === "prose").map(tail => tail.payload.text).join(""))
        .toBe("Progress: building a task-list, done.");
      expect(tails.filter(tail => tail.payload.executionId === "credential").map(tail => tail.payload.text)).toEqual(["Bearer ***REDACTED***"]);
      for (const event of events) expect(leaked(JSON.stringify(event.payload), T40)).toBe(false);
      for (const live of f.live()) expect(leaked(JSON.stringify(live.payload), T40)).toBe(false);
    }
  });

  it("N1 actual Pi projector's duplicated tool output is safe in both progress streams", async () => {
    const { createPiEventProjector } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/pi/pi-event-projector.ts", import.meta.url).href);
    const f = await fixture();
    const projector = createPiEventProjector({ runId: f.runId, turnId: "turn", spillDirectory: process.env.TMPDIR! });
    for (const [type, output] of [["tool_execution_update", "Bearer "], ["tool_execution_update", T40], ["tool_execution_end", "Bearer " + T40]]) {
      const result = { content: [{ type: "text", text: output }] };
      const projected = projector.project({ type, toolCallId: "shell", toolName: "bash", ...(type === "tool_execution_end" ? { result } : { partialResult: result }) });
      for (const entry of projected) await f.port.appendEvent(f.event(entry.eventType, entry.itemId, entry.payload));
      for (const event of await f.stored()) expect(leaked(JSON.stringify(event.payload), T40)).toBe(false);
      for (const live of f.live()) expect(leaked(JSON.stringify(live.payload), T40)).toBe(false);
    }
    const events = await f.stored();
    expect(events.some(event => event.eventType === "tool.execution.progressed")).toBe(true);
    // The Pi projector's whole-output scanner uses its existing [REDACTED] marker.
    expect(events.find(event => event.eventType === "tool.execution.completed")!.payload.output).toBe("Bearer [REDACTED]");
    out("n1-real-pi.json", { events, live: f.live() });
  });

  // Never-OK: rf-2's 26,765-character JWT crosses the cap before its first dot.
  it("G1 capped unfinished JWT never releases raw held bytes in deltas or outputTails", async () => {
    const f = await fixture();
    const header = Buffer.from(JSON.stringify({ alg: "HS256", padding: "x".repeat(19_996) })).toString("base64url");
    const payload = Buffer.from('{"sub":"synthetic"}').toString("base64url");
    const signature = "Q7ZXa9KpW8rL2mN6vC4zB0tH5efS3jD1xABCDE";
    const jwt = `${header}.${payload}.${signature}`;
    expect(jwt.length).toBe(26_765);
    const parts = [jwt.slice(0, CREDENTIAL_SHAPE_HOLD_CAP + 1), jwt.slice(CREDENTIAL_SHAPE_HOLD_CAP + 1)];
    for (const text of parts) await f.port.appendEvent(f.event("item.delta", "item", { kind: "agentMessage", text }));
    await f.port.appendEvent(f.event("item.completed", "item", { kind: "agentMessage", text: jwt }));
    const events = await f.stored();
    out("g1-cap-jwt.json", { length: jwt.length, events, live: f.live() });
    for (const event of events) {
      const own = JSON.stringify(event.payload);
      for (const raw of [header.slice(0, 16), header.slice(-16), payload, signature]) expect(own).not.toContain(raw);
      for (const tail of tailsOf(event)) expect(tail.payload.text).not.toContain(payload + "." + signature);
    }
    for (const entry of f.live()) {
      const own = JSON.stringify(entry);
      for (const raw of [header.slice(0, 16), header.slice(-16), payload, signature]) expect(own).not.toContain(raw);
    }
    expect(events.slice(0, 2).map(event => event.payload.text).join("") + events.flatMap(tailsOf).map(tail => tail.payload.text).join("")).toBe("***REDACTED***");
    expect(events.at(-1)!.payload.text).toBe("***REDACTED***");
  });

  it.each([
    ["final", "item.completed", true], ["item error", "item.failed", true],
    ["turn final", "turn.completed", false], ["turn error", "turn.failed", false], ["Stop", "turn.cancelled", false],
    ["interrupt", "turn.interrupted", false], ["session closed", "session.closed", false],
  ] as const)("a held tail is flushed once, masked, on %s (%s)", async (_name, eventType, item) => {
    const f = await fixture();
    await f.port.appendEvent(f.event("item.delta", "item", { itemId: "item", kind: "agentMessage", text: "Use Bearer " }));
    await f.port.appendEvent(f.event("item.delta", "item", { itemId: "item", kind: "agentMessage", text: T40 }));
    const terminal = f.event(eventType, item ? "item" : undefined, item ? { itemId: "item", kind: "agentMessage" } : { status: "ended" });
    expect((await f.port.appendEvent(terminal)).disposition).toBe("committed");
    expect((await f.port.appendEvent(terminal)).disposition).toBe("duplicate");
    await f.port.appendEvent(f.event("session.closed", undefined, { status: "closed" })).catch(() => undefined);
    const events = await f.stored();
    expect(events.slice(0, 2).map(event => event.payload.text)).toEqual(["Use ", ""]);
    expect(events.flatMap(tailsOf)).toEqual([{ itemId: "item", payload: { itemId: "item", kind: "agentMessage", text: "Bearer ***REDACTED***" } }]);
    expect(tailsOf(events[2]!).length).toBe(1);
    for (const text of [JSON.stringify(events), JSON.stringify(f.live())]) expect(leaked(text, T40)).toBe(false);
    expect(JSON.stringify(f.live().map(entry => entry.payload)).split("Bearer ***REDACTED***").length - 1).toBe(1);
  });

  it("runner loss or a server restart before the terminal event: the held tail is never stored or published", async () => {
    const f = await fixture();
    await f.port.appendEvent(f.event("item.delta", "item", { itemId: "item", kind: "agentMessage", text: "Use Bearer " }));
    await f.port.appendEvent(f.event("item.delta", "item", { itemId: "item", kind: "agentMessage", text: T40 }));
    const events = await f.stored();
    expect(events.map(event => event.payload.text)).toEqual(["Use ", ""]);
    for (const text of [JSON.stringify(events), JSON.stringify(f.live())]) expect(leaked(text, T40)).toBe(false);
  });
});
