import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import { piHostInstructionSegment, replacePiHostInstructions } from "./extension/index.js";

describe("Pi native host instruction segment", () => {
  it("replaces the original CLI append without retaining FIRST or dropping home context", () => {
    const original = `AGENTS home context\n${piHostInstructionSegment("FIRST", "host-test")}\nuser append`;
    const next = replacePiHostInstructions(original, "SECOND", "host-test");
    expect(next).toContain("SECOND"); expect(next).not.toContain("FIRST");
    expect(next).toContain("AGENTS home context"); expect(next).toContain("user append");
    expect(replacePiHostInstructions(next, "", "host-test")).not.toContain("SECOND");
  });
});

describe.skipIf(!process.env.PI_TEST_BINARY)("real Pi native resources", () => {
  it("loads native home extensions/skills and replies from refreshed admitted instructions in the same child", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-resources-"));
    const workspace = join(root, "workspace"), home = join(root, "agent");
    await mkdir(workspace); await mkdir(join(home, "extensions"), { recursive: true });
    await mkdir(join(home, "skills", "paperclip-synced"), { recursive: true });
    await writeFile(join(home, "skills", "paperclip-synced", "SKILL.md"), "---\nname: paperclip-synced\ndescription: Existing home fixture skill.\n---\nNative skill body\n");
    const companyBundle = join(root, "admitted-company-bundle");
    await mkdir(companyBundle);
    await writeFile(join(companyBundle, "SKILL.md"), "---\nname: admitted-company-fixture\ndescription: Company skill delivered from an admitted external bundle.\n---\nRead references relative to this original bundle.\n");
    await writeFile(join(home, "AGENTS.md"), "NATIVE_HOME_AGENTS_PRESERVED");
    await writeFile(join(workspace, "AGENTS.md"), "REPO_AGENTS_CANNOT_REPLACE_HOST");
    await writeFile(join(home, "extensions", "native.ts"), 'export default function(pi) { pi.registerCommand("native-visible", { description: "Native home extension", handler: async () => {} }); }');
    const payloads: Array<Record<string, any>> = [];
    const upstream = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const payload = JSON.parse(body); payloads.push(payload);
        const system = String(payload.messages[0].content);
        const token = system.includes("SECOND_HOST_TOKEN") ? "SECOND_HOST_TOKEN" : system.includes("FIRST_HOST_TOKEN") ? "FIRST_HOST_TOKEN" : "MISSING";
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const delta of [{ content: token }, {}]) res.write(`data: ${JSON.stringify({ id: `reply-${payloads.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("faux bind failed");
    let native!: PiRpcTransport, launch!: PiRpcTransportOptions, session: PiRpcHarnessSession | undefined;
    try {
      session = await new PiRpcDriver({ command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), systemInstructions: "FIRST_HOST_TOKEN", runtimeContext: { skills: [{ bundle: { rootPath: companyBundle } }] }, environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: home, HOME: root, PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only" }, transportFactory: options => { launch = options; native = new PiRpcTransport(options); return native; } }).openSession({ runId: "first", normalizedSessionId: "resource-proof", workingDirectory: workspace }) as PiRpcHarnessSession;
      const pid = session.processPid();
      const commands = await native.request("get_commands");
      expect(JSON.stringify(commands.data)).toContain("native-visible");
      expect(JSON.stringify(commands.data)).toContain("skill:paperclip-synced");
      expect(JSON.stringify(commands.data)).toContain("skill:admitted-company-fixture");
      expect((await native.request("get_state")).data).toMatchObject({ sessionId: session.ids().providerSessionId });
      const file = launch.args![launch.args!.indexOf("--append-system-prompt") + 1]!;
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, "utf8")).toContain("FIRST_HOST_TOKEN");
      for (const flag of ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-mcp"]) expect(launch.args).not.toContain(flag);
      expect(launch.args).toContain("--no-themes");
      expect(launch.args).toContain("--no-approve");
      expect(launch.args).not.toContain("--no-context-files");
      const iterator = session.events()[Symbol.asyncIterator]();
      for (const token of ["FIRST_HOST_TOKEN", "SECOND_HOST_TOKEN"]) {
        if (token.startsWith("SECOND")) await session.attachRun({ runId: "second", baseInstructions: token });
        await session.startTurn({ message: { role: "user", text: "Return the current host token." } });
        let text = "";
        for (;;) {
          const next = await iterator.next(); if (next.done) throw new Error("native stream ended");
          if (next.value.eventType === "item.completed" && next.value.payload.kind === "agentMessage") text = String(next.value.payload.text);
          if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
          if (next.value.eventType === "turn.completed") break;
        }
        expect(text).toBe(token); expect(session.processPid()).toBe(pid);
      }
      expect(String(payloads[1]!.messages[0].content)).not.toContain("FIRST_HOST_TOKEN");
      expect(String(payloads[1]!.messages[0].content)).toContain("NATIVE_HOME_AGENTS_PRESERVED");
      expect(String(payloads[1]!.messages[0].content)).toContain("REPO_AGENTS_CANNOT_REPLACE_HOST");
      await writeFile(join(root, "proof.json"), JSON.stringify({ pid, sessionId: session.ids().providerSessionId, payloads }, null, 2));
      console.log(`NATIVE_RESOURCE_PROOF ${root}`);
    } finally {
      await session?.close();
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      // Preserve native session JSONL and every raw request in this root.
    }
  }, 30_000);
});
