import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { authorizedToolSetForProvider, createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import type { NativeRunRuntimeGrant } from "../contracts/runtime-context.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const tools = (name: string) => [{ name, description: `Read ${name}`, inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

// This tests the controller -> actual runnerd attachment trust boundary. The
// fake facade removes model/extension behavior, which has a separate real-Pi
// FIRST PROOF; it does not replace PRP authority or command-result settlement.
it.skipIf(process.platform !== "linux")("stages Pi tool replacements and publishes only a successful attach, retaining the prior catalog after rejection", async () => {
  const root = await mkdtemp(join(process.env.PI_ATTACH_EVIDENCE_DIRECTORY ?? tmpdir(), "runnerd-pi-attach-catalog-"));
  const proxy = join(root, "fake-pi-proxy.cjs");
  const executable = join(root, "unused-faux-pi.cjs");
  await writeFile(executable, "#!/usr/bin/env node\nthrow new Error('faux facade must not start a real Pi');\n", { mode: 0o555 });
  await writeFile(proxy, `
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const fs = require("node:fs");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(join(root, "facade-requests.jsonl"))}, JSON.stringify(message) + "\\n");
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "initialize") result = { user: { sessionId: "pi_rpc" }, serverInfo: { name: "fixture", version: "1" } };
  else if (["thread/start", "thread/resume", "thread/read"].includes(message.method)) result = { thread: { id: "pi-attach-fixture", sessionId: "pi-attach-fixture", cwd: ${JSON.stringify(root)}, turns: [] }, model: "localFaux/faux", piNativeAdmission: { model: "localFaux/faux", piRpcThinkingLevel: "low" } };
  else if (["run.attach", "session.revalidate"].includes(message.method)) result = true;
  else if (message.method === "paperclip/host_park_ready") result = { ready: true, reasons: [] };
  else if (message.method === "collaborationMode/list") result = { data: [] };
  else if (message.method === "thread/close") result = true;
  else if (message.method === "turn/interrupt") result = true;
  send({ id: message.id, result });
});
`, { mode: 0o600 });
  const payloads: Record<string, unknown>[] = [];
  const catalogs: Record<string, unknown>[] = [];
  const queuedCommands: { commandId: string; type: string }[] = [];
  let core: DurablePrpControlPlane | undefined;
  let rejectNext = false;
  const bundle = createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary: process.env.PAPERCLIP_RUNNERD_PATH ?? defaultCapabilityRunnerdBinary(),
    piRpcThinkingLevel: "low",
    stateDirectory: join(root, "state"), sourceCodexHome: "", baseInstructions: "unchanged instructions",
    providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
    // The provider child is the explicitly faux facade above, not a model.
    piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy),
    piRuntimeDirectory: join(root, "pi-runtime"),
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    controlPlaneRegistration: async authority => {
      if (!core) {
        core = authority;
        const untrackedQueue = authority.queueCommand.bind(authority);
        const queue: typeof untrackedQueue = (...args) => {
          const command = untrackedQueue(...args);
          queuedCommands.push({ commandId: command.commandId, type: command.type });
          if (queuedCommands.length > 12) queuedCommands.shift();
          return command;
        };
        vi.spyOn(authority, "queueCommand").mockImplementation((type, payload = {}, id, immediate) => {
          if (type !== "run.attach") return queue(type, payload, id, immediate);
          payloads.push(structuredClone(payload));
          catalogs.push(structuredClone(record(payload.authorizedTools)));
          if (rejectNext) {
            rejectNext = false;
            return queue(type, { ...payload, provider: { ...record(payload.provider), model: "deliberately-rejected-profile" } }, id, immediate);
          }
          return queue(type, payload, id, immediate);
        });
        await authority.start();
      }
      return { connectUrl: authority.connectUrl, release: async () => {} };
    },
  });
  const first = tools("first_run_context");
  const rejected = tools("must_not_be_published");
  const replacement = tools("read_proof_context");
  const attach = (runId: string, dynamicTools?: ReturnType<typeof tools>, currentRunGrant?: NativeRunRuntimeGrant) => bundle.transport.attachRun!({
    runId, turnId: `turn-${runId}`, itemId: `item-${runId}`,
    ...(dynamicTools === undefined ? {} : { dynamicTools }),
    ...(currentRunGrant === undefined ? {} : { currentRunGrant }),
  });
  let primaryError: unknown;
  try {
    await bundle.transport.request("thread/start", { cwd: root, model: "localFaux/faux", baseInstructions: "unchanged instructions", dynamicTools: first });
    rejectNext = true;
    await expect(attach("rejected", rejected)).rejects.toThrow("Pi native profile, version, or model differs");
    expect(catalogs[0]).toEqual(authorizedToolSetForProvider("pi_rpc", rejected));
    await attach("after-rejection");
    expect(catalogs[1], "rejected tools must not become the default catalog").toEqual(authorizedToolSetForProvider("pi_rpc", first));
    await attach("replacement", replacement);
    expect(catalogs[2]).toEqual(authorizedToolSetForProvider("pi_rpc", replacement));
    await attach("after-success");
    expect(catalogs[3], "successful tools must become the next run's default").toEqual(authorizedToolSetForProvider("pi_rpc", replacement));
    for (const payload of payloads) {
      expect(record(payload.provider).model).toBe("localFaux/faux");
      expect(record(payload.provider).instructions).toBe("unchanged instructions");
    }
    await attach("fresh-grant", undefined, { instructions: "SECOND admitted instructions", runtimeContext: null });
    expect(record(payloads[4]!.provider)).toMatchObject({ kind: "pi_rpc", instructions: "SECOND admitted instructions", runtimeContext: null });
    await attach("no-new-grant");
    expect(record(payloads[5]!.provider).instructions).toBe("SECOND admitted instructions");
    const requests = readFileSync(join(root, "facade-requests.jsonl"), "utf8").trim().split("\n").map(line => record(JSON.parse(line)));
    const attached = requests.filter(frame => frame.method === "run.attach");
    expect(record(attached.at(-2)!.params).baseInstructions).toContain("SECOND admitted instructions");
    expect(record(attached.at(-1)!.params).baseInstructions).toContain("SECOND admitted instructions");
    expect(record(attached.at(-2)!.params).baseInstructions).not.toContain("unchanged instructions");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await bundle.transport.close();
    } catch (error) {
      cleanupErrors.push(error);
      // A close failure used to hide the first failed operation. Print only
      // bounded command outcomes (not launch payloads) so CI exposes the
      // runner's session.open / runner.suspend rejection reason.
      const diagnostic = JSON.stringify({
        root, primaryError: String(primaryError).slice(0, 2_048),
        commands: queuedCommands.map(command => {
          const outcome = core?.commandOutcome(command.commandId);
          return { ...command, status: outcome?.status ?? "rotated", result: JSON.stringify(outcome?.result ?? null).slice(0, 2_048) };
        }),
      });
      console.error(`[pi-attach teardown] ${diagnostic}`);
      try { await writeFile(join(root, "teardown-diagnostic.json"), `${diagnostic}\n`); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await bundle.retireProbeResources?.(5_000); }
    catch (error) { cleanupErrors.push(error); }
    try { await writeFile(join(root, "attach-payloads.json"), `${JSON.stringify(payloads, null, 2)}\n`); }
    catch (error) { cleanupErrors.push(error); }
    // Retain evidence even when close fails, and never replace the primary
    // failure with a later cleanup error.
    if (cleanupErrors.length > 0) {
      const errors = primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors];
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "Pi attach probe and teardown failed", { cause: errors[0] });
    }
  }
}, 40_000);

it("refuses the optional tool replacement for every non-Pi provider before attachment", async () => {
  for (const provider of ["codex", "opencode", "acpx"] as const) {
    const root = await mkdtemp(join(tmpdir(), "runnerd-non-pi-attach-"));
    const bundle = createRunnerdCodexTransport({ provider, stateDirectory: root });
    try {
      await expect(bundle.transport.attachRun!({ runId: "new", turnId: "turn-new", itemId: "item-new", dynamicTools: tools("not-pi") })).rejects.toThrow("native_runner_tool_replacement_requires_pi");
    } finally { await bundle.transport.close(); }
  }
});
