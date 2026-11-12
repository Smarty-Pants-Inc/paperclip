import { describe, expect, it } from "vitest";
import { createPiEventProjector } from "./pi-event-projector.js";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ownedPaths = ["./extension/index.ts", "./extension/subagents/child-bridge.ts"].map(path => realpathSync(fileURLToPath(new URL(path, import.meta.url))));

const spawnNode = process.execPath;

function transport(script: string, options: Partial<PiRpcTransportOptions> = {}): PiRpcTransport {
  return new PiRpcTransport({ command: spawnNode, args: ["-e", script], cwd: process.cwd(), shutdownTimeoutMs: 250, killTimeoutMs: 250, fatalSessionStartExtensionPaths: ownedPaths, ...options });
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
  it("retains an oversized control input for projector rejection before a safe same-ID update", async () => {
    const child = emittingTransport(`${updateScript}
      await emit({ ...update("same", "first"), args: { input: "x".repeat(300000) } });
      await emit({ ...update("same", "second"), args: { input: "safe" } });
    `);
    try {
      const records = await queuedRecords(child);
      const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
      expect(() => projector.project(records[0])).toThrow("pi_projection_record_limit");
      expect(records[0]).toMatchObject({ args: { input: "x".repeat(300000) } });
      expect(records[1]).toMatchObject({ args: { input: "safe" } });
    } finally { await child.close(); }
  });

  it("preserves changed args and control fields in order across interleaved display updates", async () => {
    const child = emittingTransport(`${updateScript}
      await emit(update("a", "a-before"));
      await emit(update("b", "b-before"));
      await emit({ ...update("a", "a-state"), args: { input: "changed" } });
      await emit(update("b", "b-after"));
      await emit({ ...update("a", "a-control"), args: { input: "changed" }, isError: true });
    `);
    try {
      const records = await queuedRecords(child);
      expect(records.slice(0, -1).map(record => [record.toolCallId, record.args, record.isError])).toEqual([
        ["a", { command: "cat SKILL; find . -type f" }, undefined],
        ["b", { command: "cat SKILL; find . -type f" }, undefined],
        ["a", { input: "changed" }, undefined],
        ["b", { command: "cat SKILL; find . -type f" }, undefined],
        ["a", { input: "changed" }, true],
      ]);
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
      const projector = createPiEventProjector({ runId: "run", turnId: "turn" });
      expect(records.slice(0, 2).flatMap(record => projector.project(record))
        .filter(event => event.eventType === "item.delta").map(event => event.payload.output)).toEqual(["4999", "b-4999"]);
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

  it.each(["ordinary", "distinct", "unidentified", "state"])("fails closed visibly for non-coalescible %s overflow", async kind => {
    const child = emittingTransport(`${updateScript}
      for (let i = 0; i < 4097; i++) await emit(${kind === "ordinary" ? '{ type: "message_end", index: i }' : kind === "distinct" ? 'update(String(i), "output")' : kind === "state" ? '{ ...update("same", "output"), args: { input: i } }' : 'update(undefined, "output")'});
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

  it.each(ownedPaths)("refuses an owned startup handler error from %s even with a successful response in the same chunk", async extensionPath => {
    const child = transport(`
      process.stdin.once("data", chunk => {
        const request = JSON.parse(chunk.toString().trim());
        process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: ${JSON.stringify(extensionPath)}, event: "session_start", error: "startup failed" }) + "\\n"
          + JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "must-not-admit" } }) + "\\n");
      });
    `);
    try { await expect(child.request("get_state")).rejects.toThrow("Pi RPC extension session_start failed"); }
    finally { await child.close(); }
    expect(child.exited).toBe(true);
  });

  it("attributes symlink aliases by realpath, not the reported spelling", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-error-path-"));
    const alias = join(root, "alias.ts");
    await symlink(ownedPaths[0], alias);
    const child = transport(`
      process.stdin.once("data", () => process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: ${JSON.stringify(alias)}, event: "session_start", error: "owned alias" }) + "\\n"));
    `);
    try { await expect(child.request("get_state")).rejects.toThrow("Pi RPC extension session_start failed"); }
    finally { await child.close(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps unknown, missing and name-collision paths nonfatal with one bounded diagnostic", async () => {
    const child = transport(`
      process.stdin.once("data", chunk => {
        const request = JSON.parse(chunk.toString().trim());
        for (const extensionPath of [${JSON.stringify(ownedPaths[0] + ".third-party")}, undefined, ${JSON.stringify(ownedPaths[1] + ".third-party")}]) {
          process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath, event: "session_start", error: "x".repeat(8192), stack: "must not forward" }) + "\\n");
        }
        process.stdout.write(JSON.stringify({ type: "response", id: request.id, success: true, data: { sessionId: "still-alive" } }) + "\\n");
      });
      process.stdin.on("end", () => process.exit(0));
    `);
    try {
      await expect(child.request("get_state")).resolves.toMatchObject({ data: { sessionId: "still-alive" } });
      await child.close();
      const records = []; for await (const record of child.events()) records.push(record);
      const diagnostics = records.filter(record => record.type === "extension_error");
      expect(diagnostics).toHaveLength(1);
      expect(String(diagnostics[0].error)).toHaveLength(2048);
      expect(diagnostics[0]).not.toHaveProperty("stack");
      expect(String(diagnostics[0].extensionPath).length).toBeLessThanOrEqual(1024);
    } finally { await child.close(); }
  });

  it("keeps non-startup extension errors observable without treating them as startup admission", async () => {
    const child = transport(`
      process.stdin.once("data", chunk => {
        const request = JSON.parse(chunk.toString().trim());
        process.stdout.write(JSON.stringify({ type: "extension_error", event: "tool_result", error: "nonfatal activity" }) + "\\n"
          + JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} }) + "\\n");
      });
      process.stdin.on("end", () => process.exit(0));
    `);
    try {
      await expect(child.request("get_state")).resolves.toMatchObject({ success: true });
      await expect(child.events()[Symbol.asyncIterator]().next()).resolves.toMatchObject({ value: { type: "extension_error", event: "tool_result" } });
    } finally { await child.close(); }
  });

  it("keeps native startup stderr in pending rejections without draining events", async () => {
    const child = transport(`
      process.stdin.once("data", () => {
        process.stderr.write("Error: Failed to load extension: Cannot find module yaml\\n", () => process.exit(1));
      });
    `);
    try {
      const failures = await Promise.allSettled([child.request("get_state"), child.request("get_available_models")]);
      for (const failure of failures) {
        expect(failure.status).toBe("rejected");
        if (failure.status !== "rejected") throw new Error("Pi startup unexpectedly succeeded");
        expect(failure.reason.message).toContain("Pi RPC process exited (code=1, signal=none)");
        expect(failure.reason.message).toContain("Error: Failed to load extension: Cannot find module yaml");
      }
    } finally {
      await child.close();
    }
  });

  it("redacts credential-shaped stderr before bounding the startup diagnostic tail", async () => {
    const child = transport(`
      process.stdin.once("data", () => {
        process.stderr.write("discarded-prefix" + "x".repeat(9000)
          + "\\nAuthorization: Bearer startup-bearer-canary\\napi_key=startup-key-canary\\n"
          + "https://startup-user:startup-password@example.test/\\n"
          + "Error: Cannot find module yaml\\n", () => process.exit(1));
      });
    `);
    try {
      const failure = await child.request("get_state").catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("Error: Cannot find module yaml");
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("startup-bearer-canary");
      expect(message).not.toContain("startup-key-canary");
      expect(message).not.toContain("startup-password");
      expect(message).not.toContain("discarded-prefix");
      const prefix = "Pi RPC process exited (code=1, signal=none)\nPi stderr (tail):\n";
      expect(message.startsWith(prefix)).toBe(true);
      expect(Buffer.byteLength(message.slice(prefix.length))).toBeLessThanOrEqual(4096);
    } finally {
      await child.close();
    }
  });

  it.each([
    ["final tail bound", "token=" + "boundary-secret-canary".repeat(100) + "\n" + "x".repeat(3000)],
    ["raw capture bound", "token=" + "boundary-secret-canary".repeat(500)],
    ["UTF-8 byte bound", "😀".repeat(1500)],
  ])("keeps the %s safe and bounded", async (_label, stderr) => {
    const diagnostic = "\nError: Cannot find module yaml\n";
    const child = transport(`
      process.stdin.once("data", () => {
        process.stderr.write(${JSON.stringify(stderr + diagnostic)}, () => process.exit(1));
      });
    `);
    try {
      const failure = await child.request("get_state").catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("Error: Cannot find module yaml");
      expect(message).not.toContain("boundary-secret-canary");
      expect(message).not.toContain("�");
      const prefix = "Pi RPC process exited (code=1, signal=none)\nPi stderr (tail):\n";
      expect(message.startsWith(prefix)).toBe(true);
      expect(Buffer.byteLength(message.slice(prefix.length))).toBeLessThanOrEqual(4096);
    } finally {
      await child.close();
    }
  });

  it("preserves the generic exit error when native stderr is empty", async () => {
    const child = transport(`process.stdin.once("data", () => process.exit(1));`);
    try {
      await expect(child.request("get_state")).rejects.toThrow(/^Pi RPC process exited \(code=1, signal=none\)$/);
    } finally {
      await child.close();
    }
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
