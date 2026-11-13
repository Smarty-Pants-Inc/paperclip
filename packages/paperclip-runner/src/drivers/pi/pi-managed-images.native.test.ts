// Keep: J1 real image-loss incident; real Pi/provider request trust boundary.
// Opt in: PI_TEST_BINARY=<real Pi 1.5.2 dist/cli.js> PI_MANAGED_IMAGES_OUT=<dir>
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";
import { parsePiUserInput } from "./pi-user-input.js";

const binary = process.env.PI_TEST_BINARY;
const output = process.env.PI_MANAGED_IMAGES_OUT;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
async function bounded<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("image proof deadline")), 15000); })]); }
  finally { clearTimeout(timer); }
}

it.skipIf(!binary || !output).each(["inline", "staged"] as const)("real Pi 1.5.2 forwards a %s PNG through the managed loopback provider", async form => {
  const root = await mkdtemp(join(tmpdir(), "j1-image-"));
  const agent = join(root, "agent"), workspace = join(root, "workspace");
  await mkdir(agent); await mkdir(workspace); await mkdir(output!, { recursive: true });
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: {} }));
  // Do not inherit the caller's original Pi home or account model overrides.
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  await writeFile(join(workspace, "attachment.png"), Buffer.from(png, "base64"));
  const requests: any[] = [];
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body)); res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [{ choices: [{ index: 0, delta: { content: "Image received." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]) {
        res.write(`data: ${JSON.stringify({ id: "j1-local", object: "chat.completion.chunk", ...chunk })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(done => peer.listen(0, "127.0.0.1", done));
  const address = peer.address(); if (!address || typeof address === "string") throw new Error("loopback unavailable");
  let native: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined;
  const proof: Record<string, any> = { form, requests, status: "running", evidenceLevel: "real_pi_1.5.2_controlled_loopback_no_live_credentials" };
  try {
    const executable = await realpath(binary!);
    proof.version = JSON.parse(await readFile(join(dirname(dirname(executable)), "package.json"), "utf8")).version;
    proof.binarySha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
    expect(proof.version).toBe("1.5.2");
    session = await new PiRpcDriver({ command: executable, model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "xhigh", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 15000,
      environment: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => { native = new PiRpcTransport(options); proof.pid = native.pid; return native; },
    }).openSession({ runId: "j1", normalizedSessionId: `j1-${form}`, workingDirectory: workspace }) as PiRpcHarnessSession;
    proof.model = ((await bounded(native!.request("get_state"))).data as any).model;
    const events = session.events()[Symbol.asyncIterator]();
    const message = parsePiUserInput([{ type: "text", text: "Describe this PNG." }, form === "inline"
      ? { type: "image", url: `data:image/png;base64,${png}` }
      : { type: "localImage", path: "attachment.png" }]);
    proof.input = message;
    proof.events = [];
    proof.capturedImageCounts = [];
    for (const runId of ["j1", "warm"]) {
      if (runId === "warm") {
        await session.attachRun({ runId });
        proof.warmModel = ((await bounded(native!.request("get_state"))).data as any).model;
        // The preserved catalog discriminator appears on extension registration;
        // Pi's models.json parser omits it on the initial selection.
        expect(proof.warmModel).toEqual({ ...proof.model, type: "chat", baseUrl: proof.warmModel.baseUrl });
        expect(proof.warmModel.baseUrl).not.toBe(proof.model.baseUrl);
      }
      await session.startTurn({ message });
      for (;;) {
        const next = await bounded(events.next()); if (next.done) throw new Error("Pi events ended");
        proof.events.push(next.value);
        if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
        if (next.value.eventType === "turn.completed") break;
      }
      // Assert the real first request before testing warm registration, so RED
      // identifies image loss rather than a secondary metadata difference.
      const user = requests.at(-1)?.messages.filter((entry: any) => entry.role === "user").at(-1);
      const images = Array.isArray(user?.content) ? user.content.filter((part: any) => part.type === "image_url") : [];
      proof.capturedImageCounts.push(images.length);
      expect(images).toHaveLength(1);
      expect(images[0].image_url.url).toBe(`data:image/png;base64,${png}`);
    }
    expect(requests).toHaveLength(2);
    expect(proof.capturedImageCounts).toEqual([1, 1]);
    expect(proof.model.input).toEqual(["text", "image"]);
    // Anthropic-only dialect metadata must not contaminate the chat route.
    expect(proof.model.compat?.forceAdaptiveThinking).toBeUndefined();
    proof.status = "passed";
  } catch (error) { proof.status = "failed"; proof.error = String(error); throw error; }
  finally {
    await session?.close(); if (!session) await native?.close();
    peer.closeAllConnections(); await new Promise<void>(done => peer.close(() => done()));
    proof.childExited = native?.exited;
    proof.nativePidAbsent = native?.pid === undefined || !existsSync(`/proc/${native.pid}`);
    await writeFile(join(output!, `${form}-proof.json`), JSON.stringify(proof, null, 2));
    vi.unstubAllEnvs();
    expect(proof.childExited).toBe(true); expect(proof.nativePidAbsent).toBe(true);
  }
}, 60000);
