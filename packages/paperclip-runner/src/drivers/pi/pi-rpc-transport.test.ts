import { describe, expect, it } from "vitest";
import { PiRpcTransport, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
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
