import { describe, expect, it } from "vitest";
import { PiRpcTransport } from "./pi-rpc-transport.js";

const spawnNode = process.execPath;

function transport(script: string): PiRpcTransport {
  return new PiRpcTransport({ command: spawnNode, args: ["-e", script], cwd: process.cwd(), shutdownTimeoutMs: 250, killTimeoutMs: 250 });
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
