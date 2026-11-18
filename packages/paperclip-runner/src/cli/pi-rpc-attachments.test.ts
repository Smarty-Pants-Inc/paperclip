import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import { PiRpcTransport } from "../drivers/pi/pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "./pi-rpc-app-server-proxy.js";

// Keep reason: trust boundary from authenticated staged paths through the
// app-server facade to Pi's actual prompt/steer JSONL input, without inference.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkAAAAABJRU5ErkJggg==", "base64");

describe("Pi RPC turn attachments", () => {
  it.each(["staged-only", "inline-and-staged", "data-url-and-staged"] as const)("sends PNG images (%s) and keeps the PDF path in prompt and steer text, without reusing prior images", async shape => {
    const root = await mkdtemp(join(tmpdir(), "pi-turn-attachments-"));
    const imagePath = join(root, "staged-image"); // Staging paths need no extension.
    const documentPath = join(root, "staged-document.pdf");
    const log = join(root, "commands.jsonl");
    await writeFile(imagePath, png);
    await writeFile(documentPath, "%PDF-1.7\nfixture\n%%EOF\n");
    const transport = new PiRpcTransport({
      command: process.execPath, cwd: root,
      args: ["-e", `
        const { appendFileSync } = require("node:fs");
        const { createInterface } = require("node:readline");
        const model = { provider: "neutral", id: "model" };
        createInterface({ input: process.stdin }).on("line", line => {
          const r = JSON.parse(line);
          appendFileSync(process.argv[1], line + "\\n");
          const data = r.type === "get_state" ? { sessionId: "attachment-session", model, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
            : r.type === "get_available_models" ? { models: [model] }
            : r.type === "get_available_thinking_levels" ? { levels: ["high"] }
            : r.type === "set_model" ? model
            : r.type === "prompt" ? { disposition: "started" }
            : r.type === "steer" ? { disposition: "queued" } : undefined;
          process.stdout.write(JSON.stringify({ id: r.id, type: "response", command: r.type, success: true, data }) + "\\n");
          if (r.type === "prompt") process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
          if (r.type === "get_messages") {
            for (const event of [
              { type: "message_start", message: { role: "assistant", id: "attachment-answer" } },
              { type: "message_end", message: { role: "assistant", id: "attachment-answer", responseId: "attachment-receipt", provider: "neutral", model: "model", timestamp: 1, content: [{ type: "text", text: "done" }], stopReason: "stop" } },
              { type: "agent_settled", aborted: false },
            ]) process.stdout.write(JSON.stringify(event) + "\\n");
          }
        }).on("close", () => process.exit(0));
      `, log], shutdownTimeoutMs: 250, killTimeoutMs: 250,
    });
    const frames: Array<Record<string, any>> = [];
    const proxy = createPiRpcAppServerProxy({
      stdout: { write(frame) { frames.push(JSON.parse(frame)); return true; }, once() {} },
      environment: { PAPERCLIP_RUN_ID: "attachment-run" },
      createDriver: () => new PiRpcDriver({
        runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
        environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport,
      }),
    });
    const request = async (id: number, method: string, params: Record<string, unknown>) => {
      await proxy.acceptLine(JSON.stringify({ id, method, params }));
      for (let i = 0; !frames.some(frame => frame.id === id) && i < 2000; i++) await new Promise(resolve => setTimeout(resolve, 2));
      const frame = frames.find(frame => frame.id === id);
      expect(frame).toBeDefined();
      expect(frame, JSON.stringify(frames)).not.toHaveProperty("error");
      return frame!.result;
    };
    try {
      await request(1, "thread/start", { cwd: root, model: "neutral/model" });
      const prompt = `Inspect the current PNG and PDF.\n${JSON.stringify({ runnerLocalPath: imagePath, contentType: "image/png" })}\n${JSON.stringify({ runnerLocalPath: documentPath, contentType: "application/pdf" })}`;
      const inlineImages = shape === "staged-only" ? [] : [shape === "inline-and-staged"
        ? { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
        : { type: "image", url: "data:image/png;base64,aGVsbG8=" }];
      const input = [{ type: "text", text: prompt }, ...inlineImages, { type: "localImage", path: imagePath }];
      const started = await request(2, "turn/start", { input });
      await request(3, "turn/steer", {
        expectedTurnId: started.turn.id,
        input: [{ type: "text", text: prompt }, ...inlineImages, { type: "localImage", path: "staged-image" }],
      });
      let commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      for (const type of ["prompt", "steer"]) {
        const command = commands.find(command => command.type === type);
        expect(command.message).toContain(documentPath);
        expect(command.images).toEqual([
          ...(shape === "staged-only" ? [] : [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]),
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ]);
      }
      await transport.request("get_messages");
      for (let i = 0; !frames.some(frame => frame.method === "turn/completed") && i < 2000; i++) await new Promise(resolve => setTimeout(resolve, 2));
      await request(4, "turn/start", { input: [{ type: "text", text: "No attachments this turn." }] });
      commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(commands.filter(command => command.type === "prompt").at(-1)).not.toHaveProperty("images");
    } finally {
      await proxy.close();
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
