import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";

const spawnNode = process.execPath;

function transport(script: string): PiRpcTransport {
  return new PiRpcTransport({ command: spawnNode, args: ["-e", script], cwd: process.cwd(), shutdownTimeoutMs: 250, killTimeoutMs: 250 });
}

// Real pipe writes honor native stdout backpressure; the response is a fence so
// tests deliberately leave the event consumer behind until every event arrived.
function emittingTransport(script: string, options: Partial<PiRpcTransportOptions> = {}): PiRpcTransport {
  return new PiRpcTransport({
    command: spawnNode,
    args: ["-e", `
      const { once } = require("node:events");
      async function write(value) {
        if (!process.stdout.write(value)) await once(process.stdout, "drain");
      }
      async function emit(record) { await write(JSON.stringify(record) + "\\n"); }
      process.stdin.once("data", async chunk => {
        const request = JSON.parse(chunk.toString());
        ${script}
        await emit({ type: "response", id: request.id, success: true, command: request.type });
      });
      process.stdin.on("end", () => process.exit(0));
      process.stdin.resume();
    `],
    cwd: process.cwd(), shutdownTimeoutMs: 250, killTimeoutMs: 250,
    ...options,
  });
}

const updateScript = `
  function update(toolCallId, text) {
    return { type: "tool_execution_update", toolCallId, toolName: "bash",
      args: { command: "cat SKILL; find . -type f" },
      partialResult: { content: [{ type: "text", text }], details: {} } };
  }
`;

async function queuedRecords(child: PiRpcTransport): Promise<PiRpcRecord[]> {
  await child.request("emit");
  await child.close();
  const records: PiRpcRecord[] = [];
  for await (const record of child.events()) records.push(record);
  return records;
}

describe("PiRpcTransport large tool output and lagging consumers", () => {
  it("never coalesces away changed args or state before a lagging projector validates them", async () => {
    const child = emittingTransport(`
      await emit({ type: "tool_execution_update", toolCallId: "same", toolName: "paperclip", args: { input: "x".repeat(300000) }, state: "first", partialResult: { content: [{ type: "text", text: "old" }] } });
      await emit({ type: "tool_execution_update", toolCallId: "same", toolName: "paperclip", args: { input: "small" }, state: "second", partialResult: { content: [{ type: "text", text: "new" }] } });
    `);
    try {
      const records = await queuedRecords(child);
      const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
      expect(() => projector.project(records[0])).toThrow("pi_projection_record_limit");
      expect(records.slice(0, 2).map(record => record.state)).toEqual(["first", "second"]);
      expect(records[1]).toMatchObject({ args: { input: "small" } });
    } finally { await child.close(); }
  });
  it("admits a real-shaped cumulative tool update larger than 4 MiB without altering its ID or final result", async () => {
    const child = emittingTransport(`${updateScript}
      await emit(update("original-call", "path\\n".repeat(1024 * 1024)));
      await emit({ type: "tool_execution_end", toolCallId: "original-call", toolName: "bash",
        result: { content: [{ type: "text", text: "native 50KB final" }],
          details: { fullOutputPath: "/tmp/native-spill" } }, isError: false });
    `);
    try {
      const records = await queuedRecords(child);
      expect(records[0]).toMatchObject({ type: "tool_execution_update", toolCallId: "original-call" });
      const partial = records[0]!.partialResult as { content: { text: string }[] };
      expect(partial.content[0]!.text).toBe("path\n".repeat(1024 * 1024));
      expect(records[1]).toEqual({ type: "tool_execution_end", toolCallId: "original-call", toolName: "bash",
        result: { content: [{ type: "text", text: "native 50KB final" }],
          details: { fullOutputPath: "/tmp/native-spill" } }, isError: false });
      expect(records.at(-1)?.type).toBe("process_exit");
    } finally { await child.close(); }
  });

  it("keeps only the newest pending update per ID beyond 4096 updates and preserves end, response, error and terminal order", async () => {
    const child = emittingTransport(`${updateScript}
      for (let i = 0; i < 5000; i++) {
        await emit(update("a", String(i)));
        await emit(update("b", "b-" + i));
      }
      await emit({ type: "tool_execution_end", toolCallId: "a", result: { exact: "final-a" } });
      await emit({ type: "response", id: "unmatched", success: false, error: "preserved" });
      await emit({ type: "extension_error", error: "preserved-error" });
      await emit({ type: "tool_execution_end", toolCallId: "b", result: { exact: "final-b" } });
      await emit({ type: "agent_settled", outcome: "completed" });
    `);
    try {
      const records = await queuedRecords(child);
      expect(records).toHaveLength(8);
      expect(records.slice(0, 2)).toMatchObject([
        { toolCallId: "a", partialResult: { content: [{ text: "4999" }] } },
        { toolCallId: "b", partialResult: { content: [{ text: "b-4999" }] } },
      ]);
      expect(records.slice(2)).toEqual([
        { type: "tool_execution_end", toolCallId: "a", result: { exact: "final-a" } },
        { type: "response", id: "unmatched", success: false, error: "preserved" },
        { type: "extension_error", error: "preserved-error" },
        { type: "tool_execution_end", toolCallId: "b", result: { exact: "final-b" } },
        { type: "agent_settled", outcome: "completed" },
        { type: "process_exit", code: 0, signal: null },
      ]);
    } finally { await child.close(); }
  });

  it.each(["tool_execution_end", "tool_execution_start", "turn_end", "turn_start", "agent_end", "agent_settled", "response"])(
    "does not collapse reused IDs across a %s barrier", async type => {
      const child = emittingTransport(`${updateScript}
        await emit(update("same", "before"));
        await emit({ type: ${JSON.stringify(type)}, toolCallId: "same" });
        await emit(update("same", "after"));
      `);
      try {
        const records = await queuedRecords(child);
        expect(records.map(record => record.type)).toEqual(["tool_execution_update", type, "tool_execution_update", "process_exit"]);
        expect(records[0]).toMatchObject({ partialResult: { content: [{ text: "before" }] } });
        expect(records[2]).toMatchObject({ partialResult: { content: [{ text: "after" }] } });
      } finally { await child.close(); }
    },
  );

  it("replaces an existing update even at queue capacity", async () => {
    const child = emittingTransport(`${updateScript}
      for (let i = 0; i < 4095; i++) await emit({ type: "message_end", index: i });
      await emit(update("last", "old"));
      await emit(update("last", "new"));
    `);
    try {
      await child.request("emit");
      const iterator = child.events()[Symbol.asyncIterator]();
      for (let i = 0; i < 4095; i++) expect((await iterator.next()).value).toEqual({ type: "message_end", index: i });
      expect((await iterator.next()).value).toMatchObject({ toolCallId: "last", partialResult: { content: [{ text: "new" }] } });
      await child.close();
      expect((await iterator.next()).value).toMatchObject({ type: "process_exit" });
      expect((await iterator.next()).done).toBe(true);
    } finally { await child.close(); }
  });

  it("clears consumed update identity and delivers waiting consumers and close waiters", async () => {
    const child = emittingTransport(`${updateScript} await emit(update("same", "one")); await emit(update("same", "two"));`);
    try {
      const iterator = child.events()[Symbol.asyncIterator]();
      const waiting = iterator.next();
      await child.request("emit");
      expect((await waiting).value).toMatchObject({ partialResult: { content: [{ text: "one" }] } });
      expect((await iterator.next()).value).toMatchObject({ partialResult: { content: [{ text: "two" }] } });
      const terminal = iterator.next();
      const done = iterator.next();
      await Promise.all([child.close(), child.close()]);
      expect((await terminal).value).toMatchObject({ type: "process_exit" });
      expect((await done).done).toBe(true);
      await expect(child.request("closed")).rejects.toThrow("closed");
    } finally { await child.close(); }
  });

  it.each(["ordinary", "distinct", "unidentified"])("fails closed visibly for non-coalescible %s overflow", async kind => {
    const child = emittingTransport(`${updateScript}
      for (let i = 0; i < 4097; i++) await emit(${kind === "ordinary" ? '{ type: "message_end", index: i }' : kind === "distinct" ? 'update(String(i), "output")' : 'update(undefined, "output")'});
    `);
    try {
      await expect(child.request("emit")).rejects.toThrow("event queue exceeded its limit");
      const drain = async () => { for await (const _record of child.events()) { /* drain to visible failure */ } };
      await expect(drain()).rejects.toThrow("event queue exceeded its limit");
    } finally { await child.close(); }
  });

  it.each([0, 1])("enforces the default 64 MiB record byte boundary (+%i)", async extra => {
    const limit = 64 * 1024 * 1024;
    const overhead = Buffer.byteLength(JSON.stringify({ type: "tool_execution_update", toolCallId: "boundary", text: "" }));
    const child = emittingTransport(`await emit({ type: "tool_execution_update", toolCallId: "boundary", text: "x".repeat(${limit - overhead + extra}) });`);
    try {
      if (extra) await expect(child.request("emit")).rejects.toThrow(`record exceeded ${limit} bytes`);
      else {
        await child.request("emit");
        const iterator = child.events()[Symbol.asyncIterator]();
        const record = (await iterator.next()).value as PiRpcRecord;
        expect((record.text as string).length).toBe(limit - overhead);
      }
    } finally { await child.close(); }
  }, 30_000);

  it("counts UTF-8 bytes rather than UTF-16 units and splits only on LF, accepting CRLF", async () => {
    const record = { type: "message_end", text: "é😀\u2028\u2029".repeat(100) };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    for (const extra of [0, -1]) {
      const child = emittingTransport(`await write(${JSON.stringify(JSON.stringify(record) + "\r\n")});`, { maxRecordBytes: bytes + 1 + extra });
      try {
        if (extra) await expect(child.request("emit")).rejects.toThrow(`record exceeded ${bytes} bytes`);
        else {
          await child.request("emit");
          expect((await child.events()[Symbol.asyncIterator]().next()).value).toEqual(record);
        }
      } finally { await child.close(); }
    }
  });

  it.each([
    ['{bad}\\n', "invalid JSONL"],
    ['[]\\n', "non-object JSON"],
    ['{"type":"partial"}', "unterminated JSONL"],
    ['x'.repeat(257), "record exceeded 256 bytes"],
  ])("still refuses malformed or oversized framing (%s)", async (line, error) => {
    const child = emittingTransport(`await write(${JSON.stringify(line.replaceAll("\\n", "\n"))}); process.stdout.end();`, { maxRecordBytes: 256 });
    try { await expect(child.request("emit")).rejects.toThrow(error); }
    finally { await child.close(); }
  });
});

describe("PiRpcTransport", () => {
  it("correlates out-of-order responses and reconstructs partial JSONL records", async () => {
    const child = transport(`
      let input = "";
      const requests = [];
      process.stdin.on("data", chunk => {
        input += chunk;
        let index;
        while ((index = input.indexOf("\\n")) >= 0) {
          const request = JSON.parse(input.slice(0, index)); input = input.slice(index + 1);
          requests.push(request);
          if (requests.length === 2) {
            process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
            const later = JSON.stringify({ type: "response", id: requests[1].id, command: requests[1].type, success: true, data: { answered: 2 } }) + "\\n";
            const earlier = JSON.stringify({ type: "response", id: requests[0].id, command: requests[0].type, success: true, data: { answered: 1 } }) + "\\n";
            process.stdout.write(later.slice(0, 11));
            setTimeout(() => process.stdout.write(later.slice(11) + earlier), 5);
          }
        }
      });
      process.stdin.on("end", () => process.exit(0));
    `);
    const first = child.request("first");
    const second = child.request("second");
    const [one, two] = await Promise.all([first, second]);
    expect(one.data).toEqual({ answered: 1 });
    expect(two.data).toEqual({ answered: 2 });
    const iterator = child.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "agent_start" }, done: false });
    await child.close();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "process_exit", code: 0 }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects outstanding commands and emits a terminal event when the child exits", async () => {
    const child = transport(`process.stdin.resume(); setTimeout(() => process.exit(17), 15);`);
    const pending = child.request("never");
    await expect(pending).rejects.toThrow("process exited");
    const records: Record<string, unknown>[] = [];
    for await (const record of child.events()) records.push(record);
    expect(records.at(-1)).toMatchObject({ type: "process_exit", code: 17 });
    await child.close();
  });
});
