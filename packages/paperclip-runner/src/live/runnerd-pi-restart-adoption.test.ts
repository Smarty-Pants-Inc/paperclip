import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { createRunnerdCodexTransport, readRunnerdArtifactBinding } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary } from "../../test/support/runnerd-transport.js";

const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

// Keep reason: recorded restart failure at the controller -> actual runnerd
// process/PRP trust boundary. Only the model facade is synthetic; the journal,
// authenticated adoption, snapshot, process and command settlement are real.
// No Pi/model credentials or external service is used. This is not Boat proof.
it.skipIf(process.platform === "win32").each(["adopt", "wrong session"] as const)(
  "recovers an in-flight native Pi run without controller launch assets (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "pi-restart-adoption-"));
    const proxy = join(root, "pi-proxy.cjs"), executable = join(root, "pi.cjs");
    const journal = join(root, "facade-requests.jsonl");
    await writeFile(executable, "// The fixture facade owns the synthetic provider.\n", { mode: 0o600 });
    await writeFile(proxy, `
const fs = require("node:fs");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let activeTurn = null;
const thread = () => ({ id: "pi-restart-session", sessionId: "pi-restart-session", cwd: ${JSON.stringify(root)},
  turns: activeTurn ? [{ id: activeTurn, status: "inProgress" }] : [] });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(journal)}, JSON.stringify(message) + "\\n");
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { user: { sessionId: "pi_rpc" }, serverInfo: { name: "fixture", version: "1" } };
  else if (["thread/start", "thread/resume", "thread/read"].includes(message.method)) result = {
    thread: thread(), model: "localFaux/faux", piNativeAdmission: { model: "localFaux/faux", piRpcThinkingLevel: "low" } };
  else if (message.method === "turn/start") {
    activeTurn = "pi-inflight-turn";
    result = { turn: { id: activeTurn, status: "inProgress" } };
    send({ method: "turn/started", params: { threadId: "pi-restart-session", turnId: activeTurn, turn: result.turn } });
  } else if (message.method === "turn/interrupt") activeTurn = null;
  else if (["run.attach", "session.revalidate", "thread/close"].includes(message.method)) result = true;
  else if (message.method === "paperclip/host_park_ready") result = { ready: !activeTurn, reasons: activeTurn ? ["active_turn"] : [] };
  else if (message.method === "collaborationMode/list") result = { data: [] };
  send({ id: message.id, result });
});
`, { mode: 0o600 });
    const server = createServer();
    let authority: DurablePrpControlPlane | undefined;
    server.on("upgrade", (request, socket, head) => {
      if (authority) authority.handleUpgrade(request, socket, "/runner", head);
      else socket.destroy();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
    const identity = { runnerInstanceId: "pi-retained-runner", environmentLeaseId: "pi-retained-lease",
      runId: "pi-retained-run", normalizedSessionId: "pi-retained-session", turnId: "pi-retained-turn", itemId: "pi-retained-item" };
    const binary = defaultCapabilityRunnerdBinary();
    const shared = {
      provider: "pi_rpc" as const, stateDirectory: join(root, "controller"), prpIdentity: identity,
      runnerBinary: binary, runnerArtifact: readRunnerdArtifactBinding(binary),
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
      piRpcThinkingLevel: "low" as const,
      controlPlaneRegistration: async (next: DurablePrpControlPlane) => {
        authority = next;
        return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: async () => {
          if (authority === next) authority = undefined;
        } };
      },
    };
    const first = createRunnerdCodexTransport({ ...shared,
      providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
      piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy),
      piRuntimeDirectory: join(root, "pi-runtime"),
    });
    let adopted: ReturnType<typeof createRunnerdCodexTransport> | undefined;
    let pid: number | null = null;
    try {
      const opened = await first.transport.request("thread/start", { cwd: root, model: "localFaux/faux" });
      const sessionId = String(record(opened.thread).sessionId);
      expect(sessionId).toBe("pi-restart-session");
      await first.transport.request("turn/start", { input: [{ type: "text", text: "Keep this existing turn in flight" }] });
      await vi.waitFor(() => expect(authority!.store.state.committedEvents.some(event => event.eventType === "turn.started")).toBe(true));
      pid = first.transport.processInfo!().pid;
      expect(pid).toBeTypeOf("number");
      const startedAt = first.transport.processInfo!().startedAt;
      await first.detachControllerForRestart();
      expect(() => process.kill(pid!, 0)).not.toThrow();
      // Model a retained journal whose bounded identity events were compacted;
      // the authenticated live snapshot must still match the exact checkpoint.
      const checkpointPath = join(shared.stateDirectory, "control-plane", "control-plane-state.json");
      const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
      checkpoint.committedEvents = checkpoint.committedEvents.filter((event: { eventType: string }) =>
        !["harness.ready", "session.started", "session.resumed"].includes(event.eventType));
      await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
      // An upgraded controller has neither a fresh environment nor its old pack.
      // Remove launch assets to catch accidental digest/proxy resolution too.
      await rm(proxy); await rm(executable);
      const duplicateLauncher = vi.fn(() => { throw new Error("duplicate runner launch"); });
      adopted = createRunnerdCodexTransport({ ...shared,
        runnerBinary: join(root, "retired-controller", "runnerd"),
        runnerProcessLauncher: duplicateLauncher,
        resumeProviderSession: { driverSessionId: sessionId, providerSessionId: mode === "wrong session" ? "foreign-session" : sessionId },
        resumeActiveTurnId: "pi-inflight-turn",
        adoptExistingRunner: { pid: pid!, processGroupId: pid, startedAt,
          isAlive: () => { try { process.kill(pid!, 0); return true; } catch { return false; } } },
      });
      if (mode === "wrong session") {
        await expect(adopted.transport.request("thread/read", {})).rejects.toThrow("native_adopted_provider_identity_mismatch");
      } else {
        const recovered = await adopted.transport.request("thread/read", {});
        expect(record(recovered.thread).id).toBe(sessionId);
        expect(adopted.transport.processInfo!().pid).toBe(pid);
        expect(authority!.store.state.identity).toEqual(identity);
        expect(authority!.store.state.commands.filter(command => command.type === "turn.start")).toHaveLength(1);
        expect(authority!.store.state.commands.some(command => command.type === "turn.stop" || command.type === "runner.suspend")).toBe(false);
        expect(adopted.evidence().diagnostics).toContain(`adopted runner ${pid} authenticated to its durable PRP authority`);
      }
      expect(duplicateLauncher).not.toHaveBeenCalled();
      const calls = (await readFile(journal, "utf8")).trim().split("\n").map(line => record(JSON.parse(line)));
      expect(calls.filter(call => call.method === "thread/start")).toHaveLength(1);
      expect(calls.filter(call => call.method === "turn/start")).toHaveLength(1);
      expect(() => process.kill(pid!, 0)).not.toThrow();
    } finally {
      await adopted?.transport.close().catch(() => undefined);
      await first.transport.close().catch(() => undefined);
      await authority?.stop();
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* normal suspend already stopped it */ } }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000,
);

it("still requires the qualified Pi executable for a new provider launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-launch-required-"));
  const bundle = createRunnerdCodexTransport({ provider: "pi_rpc", stateDirectory: root, runnerBinary: defaultCapabilityRunnerdBinary() });
  try {
    await expect(bundle.transport.request("thread/start", { cwd: root, model: "localFaux/faux" }))
      .rejects.toThrow("runner_native_pi_executable_required");
  } finally { await bundle.transport.close(); await rm(root, { recursive: true, force: true }); }
});
