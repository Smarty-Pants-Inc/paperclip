import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";

// Keep reason: real process-boundary/data-safety regression. The fact exists
// only in Pi assistant history, never the next prompt or a controller replay.
// Explicit-only, no paid model. The remote case is a split-filesystem adapter
// harness on this machine, not qualification on Boat/SSH or a separate host.
const pack = process.env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH;
const runner = process.env.PAPERCLIP_RUNNERD_PATH;
const enabled = process.platform === "linux" && !!pack && !!runner
  && process.env.PAPERCLIP_PI_RECOVERY_E2E === "1";
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
function live(pid: number): boolean {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "); }
  catch { return false; }
}
function piChild(runnerPid: number): number | undefined {
  const parents = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { const stat = readFileSync(`/proc/${name}/stat`, "utf8"); parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])); } catch { /* exited */ }
  }
  for (const [pid] of parents) {
    let parent = pid;
    while (parents.has(parent) && parent !== runnerPid) parent = parents.get(parent)!;
    if (parent !== runnerPid || pid === runnerPid) continue;
    try { const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase(); if (comm === "pi" || cmd.includes("--mode rpc") && cmd.includes("cli.js")) return pid; } catch { /* exited */ }
  }
}

it.skipIf(!enabled).each([false, true])("restores real Pi-only history after SIGKILL of idle runnerd (split runner filesystem=%s)", async remote => {
  const root = await mkdtemp(join(process.env.PI_RECOVERY_PROOF_DIR ?? tmpdir(), `pi-restart-${remote ? "remote" : "local"}-`));
  const privateFact = `PI_PRIVATE_${randomUUID()}`;
  const requests: Array<{ hasPrivateFactInAssistantHistory: boolean; hasPrivateFactInPrompt: boolean; reply: string }> = [];
  const model = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      const hasPrivateFactInAssistantHistory = parsed.messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
      const hasPrivateFactInPrompt = JSON.stringify(parsed.messages.at(-1)?.content).includes(privateFact);
      const reply = requests.length === 0 ? privateFact : hasPrivateFactInAssistantHistory ? `RECALLED_${privateFact}` : "HISTORY_LOST";
      requests.push({ hasPrivateFactInAssistantHistory, hasPrivateFactInPrompt, reply });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ content: reply }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: `msg-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("model did not bind");
  const workspace = join(root, "workspace"), home = join(root, "agent"), remoteRoot = join(root, "assigned-runner-filesystem");
  await mkdir(workspace); await mkdir(home); await mkdir(remoteRoot);
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { localFaux: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-faux-only", models: [{ id: "faux", name: "faux", contextWindow: 8192, maxTokens: 256 }] } } }));
  const manifest = JSON.parse(await readFile(join(pack!, "provider-pack.json"), "utf8"));
  const artifact = (name: string): { path: string; sha256: string } => ({ ...manifest.payload.artifacts[name], path: join(pack!, manifest.payload.artifacts[name].path) });
  const node = artifact("nodeCommand"), proxy = artifact("piRpcProxy"), pi = artifact("piRpcExecutable");
  const runnerState = join(remote ? remoteRoot : root, "runner");
  const piRuntime = join(remote ? remoteRoot : root, "pi");
  const bundle = createRunnerdCodexTransport({ provider: "pi_rpc", runnerBinary: runner!, stateDirectory: join(root, "controller"),
    ...(remote ? { runnerFilesystemRoot: remoteRoot, runnerStateDirectory: runnerState,
      readRunnerState: async () => JSON.parse(await readFile(join(runnerState, "runner-state.json"), "utf8")) } : {}),
    sourceCodexHome: "", providerNodeCommand: node.path, providerNodeCommandSha256: node.sha256,
    piCommand: pi.path, piCommandSha256: pi.sha256, piProxyPath: proxy.path, piProxySha256: proxy.sha256,
    piRuntimeDirectory: piRuntime, piRpcThinkingLevel: "off", runnerReconnectGraceMs: 10_000,
    environment: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1" },
  });
  const notifications: unknown[] = [];
  let completed = 0, pumpFailure: unknown;
  let pump: Promise<void> | undefined;
  const pids: Array<{ runner: number; pi: number }> = [];
  let primaryError: unknown;
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: workspace, model: "localFaux/faux" });
    const sessionId = String(record(record(opened).thread).sessionId);
    expect(sessionId).not.toBe("undefined");
    pump = (async () => { for await (const event of bundle.transport.notifications()) { notifications.push(event); if (event.method === "turn/completed") completed++; if (event.method === "turn/failed") throw new Error(JSON.stringify(event)); } })().catch(error => { pumpFailure = error; });
    const turn = async (prompt: string, count: number) => {
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: prompt }] });
      await vi.waitFor(() => { if (pumpFailure) throw pumpFailure; expect(completed).toBe(count); }, { timeout: 25_000, interval: 50 });
      const runnerPid = bundle.transport.processInfo!().pid!;
      const piPid = piChild(runnerPid); expect(piPid).toBeTypeOf("number");
      pids.push({ runner: runnerPid, pi: piPid! });
    };
    await turn("Invent a private fact and keep it only in your history.", 1);
    const filenames = readdirSync(piRuntime).filter(name => name.endsWith(".jsonl")); expect(filenames).toHaveLength(1);
    const sessionFile = join(piRuntime, filenames[0]!);
    expect(JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]!).id).toBe(sessionId);
    expect(readFileSync(sessionFile, "utf8")).toContain(privateFact);
    process.kill(pids[0]!.runner, "SIGKILL");
    await vi.waitFor(() => { if (pumpFailure) throw pumpFailure; expect(bundle.evidence().diagnostics).toContain("runner process restored its durable PRP session"); }, { timeout: 20_000, interval: 50 });
    await vi.waitFor(() => expect(live(pids[0]!.pi)).toBe(false), { timeout: 5000 });
    await turn("Recall the private fact from earlier assistant history.", 2);
    expect(pids[1]!.runner).not.toBe(pids[0]!.runner); expect(pids[1]!.pi).not.toBe(pids[0]!.pi);
    const readback = await bundle.transport.request("thread/read", {});
    expect(record(record(readback).thread).sessionId).toBe(sessionId);
    expect(requests[1]).toMatchObject({ hasPrivateFactInAssistantHistory: true, hasPrivateFactInPrompt: false, reply: `RECALLED_${privateFact}` });
    expect(readdirSync(piRuntime).filter(name => name.endsWith(".jsonl"))).toEqual(filenames);
    await turn("Recall it once again, without replacing this process.", 3);
    expect(pids[2]).toEqual(pids[1]);
    expect(requests[2]?.hasPrivateFactInAssistantHistory).toBe(true);
    await writeFile(join(root, "proof.json"), JSON.stringify({ scope: remote ? "split-filesystem remote adapter, local execution" : "local execution", sessionId, sessionFile, pids, requests, privateFact, actualCrash: "SIGKILL runnerd between settled turns" }, null, 2));
  } catch (error) { primaryError = error; throw error; }
  finally {
    try { await bundle.transport.close(); await pump; }
    catch (error) { if (primaryError) throw new AggregateError([primaryError, error], "recovery proof and cleanup failed"); throw error; }
    finally {
      await writeFile(join(root, "diagnostics.json"), JSON.stringify(bundle.evidence(), null, 2));
      await writeFile(join(root, "notifications.json"), JSON.stringify(notifications, null, 2));
      await new Promise<void>(resolve => model.close(() => resolve()));
      console.log(`Pi restart evidence: ${root}`);
      for (const pair of pids) expect(live(pair.runner), "owned runner gone after cleanup").toBe(false);
      if (!existsSync(join(root, "proof.json"))) await writeFile(join(root, "failure.txt"), String(primaryError ?? pumpFailure));
    }
  }
}, 90_000);
