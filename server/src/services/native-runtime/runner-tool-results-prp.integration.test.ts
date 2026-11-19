import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "../../__tests__/helpers/runner-api-server.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../../vendor/paperclip-runner/index.js";
import { createAssignedMcpTools } from "./assigned-mcp-tools.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { RUNNER_TOOL_RESULT_MAX_BYTES } from "./runner-tool-results.js";
import type { ToolGatewayService } from "../tool-gateway.js";
import { createNativeRunTrace } from "./native-run-trace.js";
import { createNativeToolTrace } from "./native-tool-trace.js";

describe("saved assigned results through actual PRP", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const oldSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (oldSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = oldSecret;
  });

  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21269 (WATCH row 5)
  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary()))("returns parallel managed calls, including an own-issue comment, before diagnostic persistence", async () => {
    const fixture = await server.fixture({ disableWakeOnDemand: true });
    let fleetEffects = 0;
    const assigned = await createAssignedMcpTools({ gatewayPublicId: "fixture", bearerToken: "fixture",
      gateway: { listToolsForNamedGateway: async () => [{ name: "fleet:send_to_fleet", displayName: "Send", description: "Fleet send",
        parametersSchema: { type: "object", properties: {} }, pluginId: "fixture", providerType: "mcp_remote_http", risk: "write" }],
        executeTool: async () => { ++fleetEffects; return { status: "completed", result: { content: "Queued for org." } }; },
      } as unknown as ToolGatewayService });
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture.authority.binding, assignedMcpTools: assigned });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let heldSpans = 0;
    const trace = createNativeRunTrace({ runId: fixture.runId, onEvent: async event => {
      if (event.payload?.span === "tool.execute") { ++heldSpans; await held; }
    } });
    const timing = createNativeToolTrace(trace);
    const provider = join(server.root, "parallel-callback-provider.mjs");
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
let received=0;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if (!m.method) {
  if (String(m.id).startsWith('parallel-')) {
   if (!m.result?.success) throw new Error('Managed tool failed: '+JSON.stringify(m));
   if (++received===2) {
    send({method:'item/completed',params:{threadId:'parallel-thread',turnId:'parallel-turn',item:{id:'answer',type:'agentMessage',text:'BOTH_CALLBACKS_DELIVERED'}}});
    send({method:'turn/completed',params:{turn:{id:'parallel-turn',status:'completed'}}});
   }
  }
  continue;
 }
 if(m.method==='initialize') send({id:m.id,result:{userAgent:'parallel-callback-provider'}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'parallel-thread',sessionId:'parallel-session'}}});
 else if(m.method==='turn/start') {
  send({id:m.id,result:{turn:{id:'parallel-turn',status:'inProgress'}}});
  send({method:'turn/started',params:{turn:{id:'parallel-turn'}}});
  for (const [id,tool,args] of [['fleet','${assigned.definitions()[0]!.name}',{}],['comment','comment_on_task',{taskId:'${fixture.issueId}',body:'Own issue parallel callback proof'}]])
   send({id:'parallel-'+id,method:'item/tool/call',params:{threadId:'parallel-thread',turnId:'parallel-turn',callId:'parallel-'+id,tool,arguments:args}});
 } else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({ runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, "parallel-callback-runner"), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "parallel", environmentLeaseId: "parallel-lease", runId: fixture.runId,
        normalizedSessionId: "parallel-session", turnId: "parallel-turn", itemId: "parallel-item" } });
    let handlersDone = 0, effectsDoneAtMs = 0, deliveredAtMs = 0;
    bundle.transport.setServerRequestHandler(async request => {
      const params = request.params;
      const call = { tool: String(params.tool), arguments: params.arguments, callId: String(params.callId) };
      const result = await timing.execute(call, async () => {
        const result = await authority.execute(call);
        if (++handlersDone === 2) effectsDoneAtMs = Date.now();
        return result;
      });
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delivered = false;
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: fixture.workspace, dynamicTools: authority.definitions() });
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Two parallel managed calls" }] });
      const notifications = (async () => { for await (const n of bundle.transport.notifications()) {
        if (n.method === "item/completed" && (n.params.item as { text?: string })?.text === "BOTH_CALLBACKS_DELIVERED") { delivered = true; deliveredAtMs = Date.now(); }
        if (n.method === "turn/completed") return;
      } })();
      await expect.poll(() => handlersDone, { timeout: 5_000 }).toBe(2);
      const ownComments = (await fixture.snapshot()).comments.filter(comment => comment.body === "Own issue parallel callback proof").length;
      expect(ownComments).toBe(1);
      await expect.poll(() => heldSpans, { timeout: 1000 }).toBeGreaterThan(0);
      await Promise.race([notifications, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
      console.log("ROW5_CALLBACK_PROOF", JSON.stringify({ fleetEffects, ownComments, committedHandlers: handlersDone,
        blockedDiagnosticWrites: heldSpans, callbacksDeliveredBeforeSinkRelease: delivered ? 2 : 0,
        replyAfterSecondEffectMs: delivered ? deliveredAtMs - effectsDoneAtMs : null, deadlineMs: 1000 }));
      expect(delivered, "both effects committed but the diagnostic sink held both callback replies").toBe(true);
      await new PaperclipRunnerToolAuthority(server.db, authority.binding).execute({ tool: "comment_on_task", callId: "parallel-comment",
        arguments: { taskId: fixture.issueId, body: "Own issue parallel callback proof" } });
      expect((await fixture.snapshot()).comments.filter(comment => comment.body === "Own issue parallel callback proof")).toHaveLength(1);
    } finally {
      clearTimeout(timer); release(); await trace.finish("ok"); await bundle.transport.close();
    }
  }, 20_000);

  it.skipIf(!process.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION && !existsSync(defaultCapabilityRunnerdBinary()))("delivers escape-heavy 500 KB pages through actual PRP without truncation", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    const original = { content: '🧭é"\\\n\u0000'.repeat(60_000), last: "complete-result" };
    const expected = JSON.stringify(original);
    const digest = createHash("sha256").update(expected).digest("hex");
    const inline = { content: "\\".repeat(200_000) };
    const inlineDigest = createHash("sha256").update(JSON.stringify(inline)).digest("hex");
    const executeTool = vi.fn(async (call: { parameters: Record<string, unknown> }) => ({
      status: "completed" as const, result: call.parameters.variant === "inline" ? inline : original,
    }));
    const assignedMcpTools = await createAssignedMcpTools({
      gatewayPublicId: "fixture", bearerToken: "fixture",
      gateway: {
        listToolsForNamedGateway: async () => [{ name: "app:read", displayName: "Read", description: "Fixture read",
          parametersSchema: { type: "object", properties: { variant: { type: "string", enum: ["large", "inline"] } } },
          pluginId: "fixture", providerType: "mcp_remote_http", risk: "read" }],
        executeTool,
      } as unknown as ToolGatewayService,
    });
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture.authority.binding, assignedMcpTools });
    const provider = join(server.root, "scripted-saved-result-provider.mjs");
    await writeFile(provider, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
let step=0, artifactId, restored='', inlinePending=false;
const call = (tool,args) => { step++; send({id:'call-'+step,method:'item/tool/call',params:{threadId:'saved-thread',turnId:'saved-turn',itemId:'item-'+step,callId:'saved-call-'+step,tool,arguments:args}}); };
for await (const line of createInterface({input:process.stdin})) {
  const m=JSON.parse(line);
  if (!m.method) {
    if (String(m.id).startsWith('call-')) {
      const envelope=JSON.parse(m.result.contentItems[0].text);
      const result=envelope.result ?? envelope;
      if (inlinePending) {
        if(result.artifact || createHash('sha256').update(JSON.stringify(result)).digest('hex')!=='${inlineDigest}') throw new Error('Inline result was not delivered intact');
        send({method:'item/completed',params:{threadId:'saved-thread',turnId:'saved-turn',item:{id:'saved-answer',type:'agentMessage',text:'all-pages-verified'}}});
        send({method:'turn/completed',params:{turn:{id:'saved-turn',status:'completed'}}});
      }
      else if (step===1) { artifactId=result.artifact.artifactId; call('read_tool_result',{artifactId,offsetBytes:0}); }
      else {
        if(!result.ok || result.responseText.offsetBytes!==Buffer.byteLength(restored)) throw new Error('Invalid page receipt');
        restored+=result.data;
        if(result.responseText.nextOffsetBytes!==null) call('read_tool_result',{artifactId,offsetBytes:result.responseText.nextOffsetBytes});
        else {
          if(createHash('sha256').update(restored).digest('hex')!=='${digest}') throw new Error('Provider received incomplete JSON');
          inlinePending=true;
          call('${assignedMcpTools.definitions()[0]!.name}',{variant:'inline'});
        }
      }
    }
    continue;
  }
  if(m.method==='initialize') send({id:m.id,result:{userAgent:'scripted-saved-result-provider'}});
  else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'saved-thread',sessionId:'saved-session'}}});
  else if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'saved-turn',status:'inProgress'}}});send({method:'turn/started',params:{turn:{id:'saved-turn'}}});call('${assignedMcpTools.definitions()[0]!.name}',{variant:'large'});}
  else if(m.id!==undefined) send({id:m.id,result:{}});
}
`);
    await chmod(provider, 0o700);
    const bundle = createRunnerdCodexTransport({
      runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: provider, codexArgs: [],
      stateDirectory: join(server.root, "scripted-saved-result-runner"), lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      prpIdentity: { runnerInstanceId: "saved-test", environmentLeaseId: "saved-test-lease", runId: fixture.runId,
        normalizedSessionId: "saved-test-session", turnId: "saved-test-turn", itemId: "saved-test-item" },
    });
    const sizes: Array<{ result: number; wrapper: number }> = [];
    bundle.transport.setServerRequestHandler(async request => {
      const params = request.params;
      const result = await authority.execute({ tool: String(params.tool), arguments: params.arguments, callId: String(params.callId) });
      const response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
      sizes.push({ result: Buffer.byteLength(JSON.stringify(result)), wrapper: Buffer.byteLength(JSON.stringify(response)) });
      return response;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verified = false;
    const notifications: Array<{ method: string; type: unknown; status?: string }> = [];
    try {
      await bundle.transport.request("initialize", {});
      await bundle.transport.request("thread/start", { cwd: fixture.workspace, dynamicTools: authority.definitions() });
      await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Read every saved result page" }] });
      await Promise.race([
        (async () => { for await (const notification of bundle.transport.notifications()) {
          notifications.push({ method: notification.method, type: (notification.params.item as { type?: string })?.type,
            status: (notification.params.turn as { status?: string })?.status });
          if (notification.method === "item/completed" && (notification.params.item as { text?: string })?.text === "all-pages-verified") verified = true;
          if (notification.method === "turn/completed") return;
        } })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Escaped pages did not reach the provider")), 15_000); }),
      ]);
      expect(verified, JSON.stringify({ sizes, notifications, diagnostics: bundle.evidence().diagnostics })).toBe(true);
      expect(executeTool.mock.calls.map(([call]) => call.parameters)).toEqual([{ variant: "large" }, { variant: "inline" }]);
      expect(sizes.every(size => size.result <= RUNNER_TOOL_RESULT_MAX_BYTES)).toBe(true);
      // The provider-facing text wrapper is decoded before the PRP command.
      // Its larger JSON encoding must not be mistaken for the command's size.
      expect(sizes.some(size => size.wrapper > 700_000)).toBe(true);
      expect(bundle.evidence().diagnostics).toContain("runnerd authenticated to the durable PRP control plane");
    } finally { clearTimeout(timer); await bundle.transport.close(); }
  }, 30_000);
});
