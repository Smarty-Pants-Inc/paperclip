import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcTransport } from "./pi-rpc-transport.js";

const captureScript = `
const { appendFileSync } = require("node:fs");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    appendFileSync("captured.jsonl", buffer.slice(0, newline + 1));
    buffer = buffer.slice(newline + 1);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function startCapture(): Promise<{ child: PiRpcTransport; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-rpc-ui-transport-"));
  const scriptPath = join(directory, "capture.cjs");
  await writeFile(scriptPath, captureScript);
  const child = new PiRpcTransport({
    command: process.execPath,
    args: [scriptPath],
    cwd: directory,
    shutdownTimeoutMs: 250,
    killTimeoutMs: 250,
  });
  return { child, directory };
}

function responseInput(value: unknown) {
  return value as Parameters<PiRpcTransport["sendExtensionUiResponse"]>[0];
}

describe("PiRpcTransport extension UI responses", () => {
  it("writes exact response JSONL without waiting for a Pi acknowledgement", async () => {
    const { child, directory } = await startCapture();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const sent = (async () => {
        await child.sendExtensionUiResponse(responseInput({ id: 0, value: "", type: "prompt", command: "not-a-response-field" }));
        await child.sendExtensionUiResponse({ id: "cancel", cancelled: true });
        await child.sendExtensionUiResponse({ id: "confirm", confirmed: false });
        return "sent";
      })();
      const outcome = await Promise.race([
        sent,
        new Promise<string>((resolve) => { timeout = setTimeout(() => resolve("timed out waiting for Pi"), 1000); }),
      ]);
      expect(outcome).toBe("sent");
      await child.close();
      await expect(readFile(join(directory, "captured.jsonl"), "utf8")).resolves.toBe([
        '{"type":"extension_ui_response","id":0,"value":""}',
        '{"type":"extension_ui_response","id":"cancel","cancelled":true}',
        '{"type":"extension_ui_response","id":"confirm","confirmed":false}',
        "",
      ].join("\n"));
    } finally {
      if (timeout) clearTimeout(timeout);
      await child.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid IDs and response shapes, and refuses writes after close", async () => {
    const { child, directory } = await startCapture();
    try {
      for (const invalid of [
        { id: "", value: "answer" },
        { id: "x".repeat(1025), value: "answer" },
        { id: 1.5, value: "answer" },
        { id: Number.NaN, value: "answer" },
        { id: Number.POSITIVE_INFINITY, value: "answer" },
        { id: Number.MAX_SAFE_INTEGER + 1, value: "answer" },
        { id: "missing-answer" },
        { id: "ambiguous-answer", value: "answer", confirmed: true },
        { id: "invalid-cancel", cancelled: false },
        { id: "invalid-value", value: 1 },
      ]) {
        await expect(child.sendExtensionUiResponse(responseInput(invalid))).rejects.toThrow();
      }
      await child.close();
      await expect(child.sendExtensionUiResponse({ id: "closed", cancelled: true })).rejects.toThrow("closed");
      await expect(readFile(join(directory, "captured.jsonl"), "utf8")).rejects.toThrow();
    } finally {
      await child.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects writes after the Pi process exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-rpc-ui-transport-exited-"));
    const child = new PiRpcTransport({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
      shutdownTimeoutMs: 250,
      killTimeoutMs: 250,
    });
    try {
      for await (const record of child.events()) {
        if (record.type === "process_exit") break;
      }
      expect(child.exited).toBe(true);
      await expect(child.sendExtensionUiResponse({ id: "exited", cancelled: true })).rejects.toThrow("closed");
    } finally {
      await child.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
});
