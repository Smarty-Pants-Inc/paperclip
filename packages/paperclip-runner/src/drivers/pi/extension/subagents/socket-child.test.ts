import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSubagentScope, type ChildBridgeSink } from "./host.js";
import { validateRoleTemplate } from "./role-template.js";

const execute = promisify(execFile);
const origin = { epoch: 7, runId: "old-parent-run", turnId: "old-parent-turn", callId: "native-subagent-call" };
const roleText = "---\nname: probe\ntools: semantic_write\n---\nOffline probe.\n";
const sink: ChildBridgeSink = { recordSelection: async () => {}, childReady: async () => {}, startTurn: async () => "unused-local-host-turn", toolExecutionStart: async () => true, toolExecutionEnd: async () => {} };
describe("S-1 detached-realm bridge with real Pi SDK and UNIX socket (synthetic model)", () => {
  it.each(["accepted", "refused", "missing-socket", "stale-origin", "resumed"])("%s never runs semantics before the captured-origin ACK", async mode => {
    const scratch = await mkdtemp(join(tmpdir(), "s1-remote-"));
    const socketPath = join(scratch, "private-bind.sock");
    const tracePath = join(scratch, "trace.mjs");
    await writeFile(tracePath, "export default function() {}\n");
    const scope = createSubagentScope({ origin, sessionId: "parent-session", closure: { langfuseExtensionPath: tracePath }, sink });
    const requests: Array<Record<string, unknown>> = [];
    let beforeAckNonce: string | null | undefined;
    let socketError: unknown;
    const server = createServer(client => {
      client.on("error", () => {});
      let buffer = "";
      client.on("data", chunk => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.split("\n")[0]!); requests.push(request);
        void readFile(join(scratch, "socket-nonce.txt"), "utf8").catch(() => null).then(nonce => {
          beforeAckNonce = nonce;
          const activeRun = mode === "stale-origin" ? "new-parent-run" : origin.runId;
          client.end(JSON.stringify({ ...request, ack: mode === "accepted" && request.origin.runId === activeRun }) + "\n");
        }).catch(error => { socketError = error; client.destroy(); });
      });
    });
    let listening = false;
    try {
      if (mode !== "missing-socket") { await new Promise<void>(resolve => server.listen(socketPath, resolve)); listening = true; }
      const prepared = await scope.prepare({ roleText, async: true, selection: { selectionId: `remote-${mode}`, roleId: "probe", roleDigest: validateRoleTemplate(roleText).digest, paretoChoice: "quality", paretoRevision: "r1", complexity: "small", rationale: "offline socket canary", budget: 1, model: "anthropic/claude-sonnet-4-5:high" } }, () => ({ provider: "anthropic", id: "claude-sonnet-4-5", family: "claude", thinkingLevels: ["high"] }));
      const childEnv = { ...process.env, S1_CHILD_SCRATCH: scratch, S1_CHILD_MODE: mode, PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify(prepared.options.extensionBindings), PAPERCLIP_PI_BIND_SOCKET: socketPath };
      if (mode === "missing-socket") delete (childEnv as Record<string, string | undefined>).PAPERCLIP_PI_BIND_SOCKET;
      const { stdout } = await execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/socket-sdk-child.mjs", import.meta.url))], { env: childEnv, timeout: 10000 });
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.pid).not.toBe(process.pid); expect(socketError).toBeUndefined();
      if (mode === "accepted") {
        expect(result).toMatchObject({ effects: 1, nonce: "socket-child-nonce\n", requests: 2, socketInherited: socketPath });
        expect(beforeAckNonce).toBeNull();
      } else {
        expect(result).toMatchObject({ effects: 0, nonce: null });
        if (mode === "resumed" || mode === "missing-socket") expect(result.requests).toBe(0);
      }
      if (["accepted", "refused", "stale-origin"].includes(mode)) {
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ schema: 1, type: "announce", sessionId: "parent-session", toolCallId: "native-socket-call", origin: { epoch: origin.epoch, runId: origin.runId, turnId: origin.turnId } });
      } else expect(requests).toEqual([]);
      const evidenceDir = process.env.PI_CHILD_CANARY_EVIDENCE_DIR;
      if (evidenceDir) { await mkdir(evidenceDir, { recursive: true }); await writeFile(join(evidenceDir, `s1-socket-${mode}.json`), JSON.stringify({ mode, realSdk: "1.5.2", syntheticModel: true, realSeparateProcess: true, beforeAckNonce, requests, result }, null, 2) + "\n"); }
    } finally {
      await scope.revoke();
      if (listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 15000);
});
