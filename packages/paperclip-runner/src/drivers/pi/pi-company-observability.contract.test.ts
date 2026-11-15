import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_OBSERVABILITY_ENV_KEYS } from "../agent-observability.js";
import { configuredEnvironmentProjection } from "../../configured-environment.js";
import { assistant, attrs, environment, openPi, sentinel, spans, terminal, tool, user } from "./pi-observability.test-fixture.js";

let bodies: any[];
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  bodies = [];
  transport = vi.fn<typeof fetch>(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("{}"); });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function run(env = environment) {
  const pi = await openPi(env);
  try {
    await pi.start();
    pi.peer.send(...assistant("call-1", { tool: "read" }), ...tool("call-1"), ...terminal);
    await pi.settled();
    return pi;
  } finally { await pi.close(); }
}

describe("R1 native Pi / shared observability contract (obs3, revised by Addenda)", () => {
  it("exports one root/tool/usage request through the real Pi sink and observability-only adapter", async () => {
    const pi = await run();
    expect(pi.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "turn.started" }),
      expect.objectContaining({ eventType: "turn.completed" }),
      expect.objectContaining({ eventType: "tool.execution.completed" }),
      expect.objectContaining({ eventType: "usage.reported", payload: expect.objectContaining({ runDelta: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, providerCostUsd: 0.125 } }) }),
    ]));
    expect(transport).toHaveBeenCalledOnce();
    expect(spans(bodies).map(s => s.name)).toEqual(["paperclip.pi.turn", "tool read", "pi.model.usage"]);
    if (process.env.TASK_OUT) {
      await writeFile(join(process.env.TASK_OUT, "R1-pi-sink-events.json"), JSON.stringify(pi.events, null, 2));
      await writeFile(join(process.env.TASK_OUT, "R3-golden-otlp.json"), JSON.stringify(bodies, null, 2));
    }
  });
  it("A2.7 containment: subscribers/receipts never see synthetic turn.submitted or rewritten usage", async () => {
    const pi = await run();
    expect(pi.events.some(e => e.eventType === "turn.submitted")).toBe(false);
    const receipt = pi.events.find(e => e.eventType === "item.completed" && e.payload.kind === "usage");
    expect(receipt?.payload).not.toHaveProperty("usageMessageId");
    expect(receipt?.payload.usage).toHaveProperty("total.inputTokens", 10);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("disabled export: zero requests", async () => {
    await run({ ...environment, PAPERCLIP_OBSERVABILITY_PI: "0" });
    expect(transport).not.toHaveBeenCalled();
  });
});

it("R2: credentials stay out of Pi child env/argv/config, run receipts and diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const pi = await openPi();
  try {
    await pi.start(); pi.peer.send(...assistant("key-check", { tool: "read" }), ...tool("key-check"), ...terminal); await pi.settled();
    const configuration: string[] = [];
    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(file);
        else if (entry.isFile()) configuration.push(await readFile(file, "utf8"));
      }
    };
    await inspect(pi.root);
    expect(configuration.length).toBeGreaterThan(0);
    expect(JSON.stringify([pi.child, await pi.session.snapshot(), pi.events, configuration, warn.mock.calls])).not.toContain(sentinel);
    for (const key of AGENT_OBSERVABILITY_ENV_KEYS) expect(pi.child.env).not.toHaveProperty(key);
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${sentinel}` });
  } finally { await pi.close(); }
});
describe("F-1: configured and runtime credentials never enter OTLP bodies", () => {
  // These ordinary variable/argument names deliberately bypass name-based
  // scrubbing: the runner must protect the configured secret VALUES.
  const resultSecret = 'f1-result-9c1e-"quoted"\\path\nsecond-line';
  const answerSecret = "f1-answer-7d2b-independent";
  const taskEnvironment = configuredEnvironmentProjection({ RESULT_VALUE: resultSecret, ANSWER_VALUE: answerSecret }, ["RESULT_VALUE", "ANSWER_VALUE"]);
  const identity = "-----BEGIN PRIVATE KEY-----\nidentity-f1-first-line\nidentity-f1-second-line\n-----END PRIVATE KEY-----";
  const provider = "f1-provider-6e3a-credential";
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
  async function assertWire(label: string, secrets: string[], expected: string) {
    expect(transport).toHaveBeenCalled();
    for (const body of bodies) {
      const wire = JSON.stringify(body);
      for (const secret of secrets) {
        expect(wire, `${label}: raw value`).not.toContain(secret);
        expect(wire, `${label}: serialized value`).not.toContain(escaped(secret));
      }
    }
    expect(JSON.stringify(bodies)).toContain(expected);
    expect(JSON.stringify(bodies)).toContain("[REDACTED]");
    if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT, `F1-${label}-otlp.json`), JSON.stringify(bodies, null, 2));
  }
  it.each([false, true])("(a) redacts a configured task secret echoed by a TOOL RESULT (escaped=%s)", async jsonEscaped => {
    const pi = await openPi({ ...environment, ...taskEnvironment });
    try {
      await pi.start();
      pi.peer.send(...assistant("result", { tool: "read" }), ...tool("result", "read", `safe result ${jsonEscaped ? escaped(resultSecret) : resultSecret}`), ...terminal);
      await pi.settled();
    } finally { await pi.close(); }
    await assertWire(`result-${jsonEscaped}`, [resultSecret, escaped(resultSecret)], "safe result");
  });
  it("(b) redacts a SECOND configured task secret echoed in the assistant ANSWER", async () => {
    const pi = await openPi({ ...environment, ...taskEnvironment });
    try {
      await pi.start(); pi.peer.send(...assistant("answer", { text: `safe answer ${answerSecret}` }), ...terminal); await pi.settled();
    } finally { await pi.close(); }
    await assertWire("answer", [answerSecret], "safe answer");
  });
  it.each([
    ["identity-raw", identity], ["identity-escaped", escaped(identity)], ["identity-line", "identity-f1-second-line"], ["provider", provider],
  ])("redacts %s appearing in TOOL ARGS and projected bash command names", async (label, value) => {
    const pi = await openPi({ ...environment, PAPERCLIP_AGENT_PRIVATE_KEY: identity, OPENROUTER_API_KEY: provider });
    const args = { command: `echo ${value}` };
    try {
      await pi.start(); pi.peer.send(...assistant(label, { tool: "bash", args }), ...tool(label, "bash", "safe tool output", args), ...terminal); await pi.settled();
      expect(pi.events.some(e => e.eventType === "tool.execution.started" && e.payload.name === args.command)).toBe(true);
    } finally { await pi.close(); }
    await assertWire(label, [value, "identity-f1-first-line", "identity-f1-second-line", provider], "safe tool output");
  });
  it("redacts prompt content, managed provider keys, assigned MCP and runner API credentials", async () => {
    const values = { PAPERCLIP_AI_PROVIDER_KEY: "f1-managed-provider-28ab", PAPERCLIP_NATIVE_MCP_TOKEN: "f1-assigned-mcp-54cd", PAPERCLIP_API_KEY: "f1-runner-api-76ef" };
    const pi = await openPi({ ...environment, ...taskEnvironment, ...values,
      PAPERCLIP_NATIVE_MCP_NAME: "fixture", PAPERCLIP_NATIVE_MCP_URL: "https://mcp.example/rpc" });
    try {
      await pi.start(`safe prompt ${answerSecret} ${Object.values(values).join(" ")}`);
      pi.peer.send(...assistant("prompt"), ...terminal); await pi.settled();
    } finally { await pi.close(); }
    await assertWire("prompt", [answerSecret, ...Object.values(values)], "safe prompt");
  });
  it("redacts generated bind/tool socket capabilities and broker auth on initial AND warm bindings", async () => {
    const pi = await openPi({ ...environment, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: provider }, { model: "paperclip/model" });
    const secrets: string[] = [provider];
    try {
      const initial = JSON.parse(await readFile(pi.child.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
      const models = JSON.parse(await readFile(join(pi.root, "agent", "models.json"), "utf8"));
      secrets.push(pi.child.env!.PAPERCLIP_PI_BIND_SOCKET!, initial.toolSocketPath, models.providers.paperclip.apiKey);
      for (let turn = 1; turn <= 2; turn++) {
        await pi.start();
        if (turn === 2) {
          const binding = pi.bindings.findLast(b => b.type === "bind");
          expect(binding?.type).toBe("bind");
          if (binding?.type === "bind") {
            expect(binding.provider.apiKey).not.toBe(models.providers.paperclip.apiKey);
            secrets.push(binding.provider.apiKey);
          }
        }
        pi.peer.send(...assistant(`binding-${turn}`, { text: `safe binding ${secrets.join(" ")}` }), ...terminal); await pi.settled(turn);
      }
    } finally { await pi.close(); }
    expect(transport).toHaveBeenCalledTimes(2);
    await assertWire("bindings", secrets, "safe binding");
  });
});
it("R3: Langfuse golden mapping includes I/O, native session, provider cost and all Paperclip ids", async () => {
  await run();
  const all = spans(bodies);
  expect(all).toHaveLength(3);
  for (const span of all) expect(attrs(span)).toMatchObject({ "session.id": "native-pi-session", "paperclip.company.id": "company", "paperclip.agent.id": "agent", "paperclip.run.id": "run", "paperclip.task.id": "task", "paperclip.turn.id": expect.any(String) });
  expect(attrs(all[0])).toMatchObject({ "braintrust.input": "Read the fixture", "langfuse.observation.input": "Read the fixture", "langfuse.observation.output": "Fixture read" });
  expect(attrs(all[1])).toHaveProperty("langfuse.observation.output", "fixture body");
  expect(attrs(all[2])).toMatchObject({ "gen_ai.usage.cost": 0.125, costProvenance: "provider_reported" });
});
it.each([
  ["OTEL_LOG_USER_PROMPTS", "Read the fixture"], ["OTEL_LOG_ASSISTANT_RESPONSES", "Fixture read"],
  ["OTEL_LOG_TOOL_DETAILS", "tool read"], ["OTEL_LOG_TOOL_CONTENT", "fixture body"],
])("R4: %s removes only its capture category", async (key, omitted) => {
  await run({ ...environment, [key]: "0" });
  const wire = JSON.stringify(bodies);
  expect(spans(bodies).length).toBeGreaterThan(0);
  expect(wire).not.toContain(omitted);
  if (key !== "OTEL_LOG_USER_PROMPTS") expect(wire).toContain("Read the fixture");
  if (key !== "OTEL_LOG_ASSISTANT_RESPONSES") expect(wire).toContain("Fixture read");
  if (!["OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_TOOL_DETAILS"].includes(key)) expect(wire).toContain("fixture body");
});
it("R4: all four switches off leaves metadata only", async () => {
  await run({ ...environment, ...Object.fromEntries(["USER_PROMPTS", "ASSISTANT_RESPONSES", "TOOL_DETAILS", "TOOL_CONTENT"].map(k => [`OTEL_LOG_${k}`, "0"])) });
  expect(spans(bodies)).toHaveLength(2);
  expect(JSON.stringify(bodies)).not.toMatch(/Read the fixture|Fixture read|fixture body|braintrust\.(input|output)|langfuse\.observation\.(input|output)/);
});
it("A2.1: two per-receipt deltas plus cumulative items sum to the final run total exactly once", async () => {
  const pi = await openPi();
  try {
    await pi.start(); pi.peer.send(...assistant("one"), ...assistant("two"), ...terminal); await pi.settled();
  } finally { await pi.close(); }
  const cumulative = pi.events.filter(e => e.eventType === "item.completed" && e.payload.kind === "usage").at(-1)?.payload.usage as any;
  const usage = spans(bodies).filter(s => s.name === "pi.model.usage");
  expect(usage).toHaveLength(2);
  expect(usage.reduce((n, s) => n + attrs(s)["gen_ai.usage.input_tokens"], 0)).toBe(cumulative.total.inputTokens);
  expect(usage.reduce((n, s) => n + attrs(s)["gen_ai.usage.cost"], 0)).toBe(cumulative.providerReportedCostUsd);
});
it("A2.6: consumed mid-turn steer joins the prompt with a blank line, redaction and 8 KiB cap", async () => {
  const turnStart = new Date("2026-11-15T12:00:00.000Z");
  let now = turnStart;
  const pi = await openPi(environment, { now: () => now });
  try {
    await pi.start("first"); pi.peer.send(...assistant("one"));
    await vi.waitFor(() => expect(pi.events.some(e => e.eventType === "usage.reported")).toBe(true));
    const turnId = pi.events.find(e => e.eventType === "turn.started")!.turnId!;
    now = new Date(turnStart.getTime() + 5000);
    const text = `steer ${sentinel} ${"😀".repeat(3000)}`;
    await pi.session.steer!({ turnId, mode: "steer", message: { role: "user", text } });
    pi.peer.send(...user("steer", text), ...assistant("two"), ...terminal); await pi.settled();
  } finally { await pi.close(); }
  const root = spans(bodies).find(s => s.name === "paperclip.pi.turn");
  expect(root).toBeDefined();
  const started = pi.events.find(e => e.eventType === "turn.started")!;
  expect(started.emittedAt).toBe(turnStart.toISOString());
  expect(root.startTimeUnixNano).toBe(String(BigInt(turnStart.getTime()) * 1_000_000n));
  expect(attrs(root)["paperclip.turn.id"]).toBe(started.turnId);
  expect(pi.events.filter(e => e.eventType === "turn.started")).toHaveLength(1);
  const input = attrs(root)["langfuse.observation.input"];
  expect(input).toMatch(/^first\n\nsteer \[REDACTED\]/);
  expect(Buffer.byteLength(input)).toBeLessThanOrEqual(8192);
  expect(input).not.toContain("\ufffd");
  expect(attrs(root)["paperclip.observability.truncated"]).toBe(true);
});
it("R8: OFF company cannot inherit enabled company export, including reused warm sessions", async () => {
  const enabled = await openPi();
  const off = await openPi({ ...environment, PAPERCLIP_OBSERVABILITY_PI: "0", OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=client" });
  try {
    for (let turn = 1; turn <= 2; turn++) {
      for (const [label, pi] of [["enabled", enabled], ["client-private", off]] as const) {
        await pi.start(label); pi.peer.send(...assistant(`${label}-${turn}`), ...terminal); await pi.settled(turn);
      }
    }
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bodies)).not.toContain("client-private");
    expect(spans(bodies).every(s => attrs(s)["paperclip.company.id"] === "company")).toBe(true);
  } finally { await enabled.close(); await off.close(); }
});
