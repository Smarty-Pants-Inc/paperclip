import { randomBytes } from "node:crypto";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { redactObservabilityDiagnostic } from "../agent-observability.js";

type Attributes = Record<string, string | number | boolean>;
interface Span { id: string; name: string; start: number; end: number; failed: boolean; attributes: Attributes }
interface Turn {
  runId: string; turnId: string; traceId: string; root: Span;
  tools: Map<string, Span>; usage: Map<string, Span>; truncated: boolean;
  overflow?: Span; usageCount: number; toolCount: number; skippedUsage: number;
  incomplete: boolean; costIncomplete: boolean; totals: Record<string, number>;
}
/** Defaults preserve OpenCode's wire contract; other drivers opt into extensions. */
export interface CompanyObservabilityProfile {
  flag: string; serviceName: string; scopeName: string; turnSpanName: string; usageSpanName: string;
  providerToolPrefix: string; overflowSpanName: string;
  langfuseMapping: boolean; preserveOverflow: boolean; appendUserMessages: boolean;
}
const openCodeProfile: CompanyObservabilityProfile = {
  flag: "PAPERCLIP_OBSERVABILITY_OPENCODE", serviceName: "paperclip-opencode", scopeName: "paperclip.opencode",
  turnSpanName: "paperclip.opencode.turn", usageSpanName: "opencode.model.usage", providerToolPrefix: "opencode tool",
  overflowSpanName: "opencode.turn.overflow", langfuseMapping: false, preserveOverflow: false, appendUserMessages: false,
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const id = () => randomBytes(8).toString("hex");
const maxRows = 64;
const maxTextBytes = 8192;
const attributes = (values: Attributes) => Object.entries(values).map(([key, value]) => ({ key, value:
  typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : { doubleValue: value } }));
function pairs(value: string | undefined): Record<string, string> {
  return Object.fromEntries((value ?? "").split(",").filter(Boolean).map(entry => {
    const index = entry.indexOf("=");
    if (index < 1) throw new Error("invalid_configuration");
    return [entry.slice(0, index), decodeURIComponent(entry.slice(index + 1))];
  }));
}

function argumentDiagnostics(value: unknown): string {
  const type = (entry: unknown) => entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
  const fields = record(value);
  return JSON.stringify({
    schema: "paperclip.opencode.tool-diagnostics.v1", method: "tools/call",
    argumentType: type(value),
    fields: Object.fromEntries([
      "name", "arguments", "schema", "reportedWorkDisposition", "summary",
      "completionClaim", "verification", "evidence", "artifacts", "continuation", "blocker",
    ].filter(key => Object.hasOwn(fields, key)).map(key => [key, type(fields[key])])),
  });
}
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

/** A controller opt-in, not OpenCode's raw OTLP. Projected PRP events never include reasoning or raw provider payloads. */
export function createOpenCodeCompanyObservability(input: {
  environment: NodeJS.ProcessEnv | undefined; model: string; sensitiveValues: readonly string[];
  managedToolNames?: readonly string[];
  profile?: Partial<CompanyObservabilityProfile>; sessionId?: string;
  fetch?: typeof globalThis.fetch; onDiagnostic?: (message: string) => void;
}) {
  const profile = { ...openCodeProfile, ...input.profile };
  const env = input.environment;
  if (env?.[profile.flag] !== "1") return undefined;
  const diagnostic = (reason: string) => {
    try { input.onDiagnostic?.(`Company observability export unavailable (${reason}).`); } catch { /* Export cannot fail the task. */ }
  };
  let endpoint: string, headers: Record<string, string>, resource: Attributes;
  try {
    const url = new URL(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error();
    endpoint = url.href;
    headers = pairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS);
    const supplied = pairs(env.OTEL_RESOURCE_ATTRIBUTES);
    resource = { "service.name": profile.serviceName, ...Object.fromEntries(
      ["paperclip.company.id", "paperclip.agent.id", "paperclip.observability.revision", "paperclip.run.id", "paperclip.task.id"]
        .filter(key => supplied[key]).map(key => [key, supplied[key]])) };
  } catch { diagnostic("configuration_invalid"); return undefined; }
  const managedTools = new Set(["paperclip_finish", "paperclip_block", ...(input.managedToolNames ?? [])]
    .flatMap(name => [name, `paperclip_${name}`]));
  const capture = (key: string) => env[key] === "1";
  const clean = (value: unknown, limit = maxTextBytes): string => {
    if (typeof value !== "string") return "";
    let text = redactObservabilityDiagnostic(value, env);
    for (const secret of input.sensitiveValues.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[REDACTED]");
    const bytes = Buffer.from(text);
    if (bytes.length > limit && current) current.truncated = true;
    let end = Math.min(bytes.length, limit);
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
  };
  const pending = new Set<Promise<void>>();
  let current: Turn | undefined;
  let closed = false;
  const makeSpan = (name: string, time: number, values: Attributes): Span => ({ id: id(), name, start: time, end: time, failed: false, attributes: values });
  const content = (span: Span, direction: "input" | "output", text: string) => {
    span.attributes[`braintrust.${direction}`] = text;
    if (profile.langfuseMapping) span.attributes[`langfuse.observation.${direction}`] = text;
  };
  const overflow = (turn: Turn, time: number) => turn.overflow ??= makeSpan(profile.overflowSpanName, time, {});
  const finish = (failed: boolean, time: number) => {
    const turn = current;
    current = undefined;
    if (!turn) return;
    turn.root.end = Math.max(turn.root.start, time);
    turn.root.failed = failed;
    turn.root.attributes["paperclip.observability.truncated"] = turn.truncated;
    if (profile.preserveOverflow && (turn.incomplete || turn.costIncomplete || turn.overflow)) {
      const aggregate = overflow(turn, turn.root.start);
      aggregate.end = time;
      if (aggregate.attributes["paperclip.observability.overflow.usage_count"]) {
        // Reconcile against receipt-order run totals. Independently adding an
        // overflow subtotal can otherwise change fractional USD rounding.
        for (const [key, total] of Object.entries(turn.totals)) {
          const detailed = [...turn.usage.values()].reduce((sum, span) => sum + Number(span.attributes[key] ?? 0), 0);
          aggregate.attributes[key] = total - detailed;
        }
      }
      Object.assign(aggregate.attributes, {
        "paperclip.observability.truncated": turn.truncated,
        "paperclip.observability.incomplete": turn.incomplete,
        "paperclip.observability.cost_incomplete": turn.costIncomplete,
        "paperclip.observability.totals_exact": !turn.incomplete && !turn.costIncomplete,
        "paperclip.observability.usage_count": turn.usageCount,
        "paperclip.observability.tool_count": turn.toolCount,
        "paperclip.observability.skipped_usage_count": turn.skippedUsage,
      });
    }
    const turnResource = profile.langfuseMapping ? { ...resource, "paperclip.run.id": turn.runId,
      ...(input.sessionId ? { "session.id": input.sessionId } : {}) } : resource;
    const spans = [turn.root, ...turn.tools.values(), ...turn.usage.values(), ...(turn.overflow ? [turn.overflow] : [])].map(span => ({
      traceId: turn.traceId, spanId: span.id, ...(span !== turn.root ? { parentSpanId: turn.root.id } : {}),
      name: span.name, kind: 0, startTimeUnixNano: String(BigInt(Math.trunc(span.start)) * 1_000_000n),
      endTimeUnixNano: String(BigInt(Math.trunc(Math.max(span.start, span.end))) * 1_000_000n),
      status: { code: span.failed ? 2 : 1 }, attributes: attributes({ ...turnResource, ...span.attributes,
        "paperclip.run.id": turn.runId, "paperclip.turn.id": turn.turnId }),
    }));
    // Admit at most four terminal-turn jobs, never queue turns. A split turn
    // streams bounded requests sequentially in its slot under ONE 3s deadline.
    // Thus splitting cannot increase concurrency or create an idle worker.
    if (pending.size >= 4) { diagnostic("export_busy"); return; }
    const envelope = (batch: typeof spans) => JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes(turnResource) },
      scopeSpans: [{ scope: { name: profile.scopeName, version: "1" }, spans: batch }] }] });
    const body = envelope(spans);
    if (!profile.preserveOverflow && Buffer.byteLength(body) > 1_048_576) { diagnostic("export_too_large"); return; }
    function* bodies() {
      if (!profile.preserveOverflow || Buffer.byteLength(body) <= 1_048_576) { yield body; return; }
      const overhead = Buffer.byteLength(envelope([]));
      let batch: typeof spans = [], bytes = overhead;
      for (const span of spans) {
        const size = Buffer.byteLength(JSON.stringify(span));
        if (size + overhead > 1_048_576) throw new Error("export_span_too_large");
        if (bytes + size + (batch.length ? 1 : 0) > 1_048_576) { yield envelope(batch); batch = []; bytes = overhead; }
        bytes += size + (batch.length ? 1 : 0); batch.push(span);
      }
      if (batch.length) yield envelope(batch);
    }
    const job = (async () => {
      try {
        const signal = AbortSignal.timeout(3000);
        for (const body of bodies()) {
        signal.throwIfAborted();
        const response = await (input.fetch ?? globalThis.fetch)(endpoint, {
          method: "POST", redirect: "error", signal,
          headers: { ...headers, "content-type": "application/json", accept: "application/json" }, body,
        });
        const reader = response.body?.getReader();
        try {
          if (!response.ok) throw new Error("receiver_rejected");
          const chunks: Uint8Array[] = []; let size = 0;
          while (reader) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.length; if (size > 65536) throw new Error("invalid_response");
            chunks.push(next.value);
          }
          if (size) {
            const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_response");
            const partial = record(decoded).partialSuccess;
            if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_response");
            const rejected = record(partial).rejectedSpans ?? 0;
            if (!/^\d+$/.test(String(rejected)) || Number(rejected) !== 0) throw new Error("partial_rejection");
          }
        } finally { await reader?.cancel().catch(() => {}); }
        }
      } catch { diagnostic("export_failed"); }
    })();
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  return {
    observe(event: PrpEvent) {
      if (closed) return;
      const time = Date.parse(event.emittedAt);
      if (!Number.isFinite(time)) return;
      if (event.eventType === "turn.submitted" && event.turnId) {
        if (current) finish(true, time);
        current = { runId: event.runId, turnId: event.turnId, traceId: randomBytes(16).toString("hex"),
          root: makeSpan(profile.turnSpanName, time, { "gen_ai.operation.name": "invoke_agent", "gen_ai.request.model": input.model }),
          tools: new Map(), usage: new Map(), truncated: false, usageCount: 0, toolCount: 0, skippedUsage: 0, incomplete: false, costIncomplete: false, totals: {} };
        if (capture("OTEL_LOG_USER_PROMPTS")) content(current.root, "input", clean(record(event.payload).text));
      }
      const turn = current;
      if (!turn || event.runId !== turn.runId || event.turnId !== turn.turnId) return;
      const payload = record(event.payload);
      if (event.eventType === "item.completed" && payload.kind === "agentMessage" && capture("OTEL_LOG_ASSISTANT_RESPONSES")) {
        content(turn.root, "output", clean(payload.text));
      }
      if (profile.appendUserMessages && event.eventType === "item.completed" && payload.kind === "userMessage" && capture("OTEL_LOG_USER_PROMPTS")) {
        // Consumption can occur after submission (steers / queued follow-ups).
        // Append only in this private feed, using the same redaction/UTF-8 cap.
        const previous = String(turn.root.attributes["braintrust.input"] ?? "");
        content(turn.root, "input", clean(previous + (previous ? "\n\n" : "") + clean(payload.text)));
      }
      if (profile.preserveOverflow && event.eventType === "item.completed" && payload.kind === "usageAccounting") {
        turn.incomplete ||= payload.incomplete === true;
        if (payload.skipped === true) turn.skippedUsage++;
      }
      const dynamic = payload.kind === "dynamicToolCall" && ["item.started", "item.completed"].includes(event.eventType);
      const item = record(payload.item);
      const canonicalTool = event.eventType.startsWith("tool.execution.");
      const toolCompleted = event.eventType === "tool.execution.completed" || (dynamic && event.eventType === "item.completed");
      if (toolCompleted) turn.toolCount++;
      if ((dynamic || canonicalTool) && event.itemId && capture("OTEL_LOG_TOOL_DETAILS")) {
        const key = `${dynamic ? "dispatch" : "native"}:${event.itemId}`;
        let span = turn.tools.get(key);
        if (!span && turn.tools.size < maxRows) {
          const name = clean(dynamic ? item.name : payload.name, 128);
          span = makeSpan(`${!dynamic && managedTools.has(String(payload.name)) ? profile.providerToolPrefix : "tool"} ${name || "execution"}`, time, {
            "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name,
            "paperclip.tool.source": dynamic ? "dispatch" : "provider" });
          turn.tools.set(key, span);
        }
        if (span) {
          span.end = time; span.failed = dynamic ? item.is_error === true : payload.status === "failed";
          if (capture("OTEL_LOG_TOOL_CONTENT")) {
            if (dynamic && event.eventType === "item.started") {
              content(span, "input", argumentDiagnostics(item.arguments));
            } else {
              content(span, "output", clean(dynamic ? outputText(item.result ?? item.error) : payload.output));
            }
            if (!dynamic && payload.outputTruncated === true) turn.truncated = true;
          }
        } else {
          turn.truncated = true;
          if (profile.preserveOverflow && toolCompleted) {
            const values = overflow(turn, time).attributes;
            const key = "paperclip.observability.overflow.tool_count";
            values[key] = Number(values[key] ?? 0) + 1;
          }
        }
      }
      if (event.eventType === "item.completed" && payload.kind === "usage" && typeof payload.usageMessageId === "string") {
        const key = payload.usageMessageId;
        const usage = record(payload.usage), cache = record(usage.cache);
        const values: Attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": input.model };
        for (const [name, value] of Object.entries({ "gen_ai.usage.input_tokens": usage.input, "gen_ai.usage.output_tokens": usage.output,
          "gen_ai.usage.cache_read.input_tokens": cache.read, "gen_ai.usage.cache_creation.input_tokens": cache.write,
          "paperclip.cost.usd": usage.costUsd })) if (finite(value)) values[name] = value;
        if (profile.langfuseMapping && finite(usage.costUsd)) {
          values["gen_ai.usage.cost"] = usage.costUsd;
          if (["provider_reported", "catalog_estimate"].includes(String(payload.costProvenance))) values.costProvenance = String(payload.costProvenance);
        }
        if (profile.preserveOverflow) {
          turn.incomplete ||= payload.accountingComplete === false;
          turn.costIncomplete ||= !finite(usage.costUsd);
        }
        const previous = turn.usage.get(key);
        if (profile.preserveOverflow) for (const [name, value] of Object.entries(values)) {
          if (typeof value === "number") turn.totals[name] = (turn.totals[name] ?? 0) + value - Number(previous?.attributes[name] ?? 0);
        }
        if (!previous) turn.usageCount++;
        if (previous || turn.usage.size < maxRows) {
          turn.usage.set(key, { ...makeSpan(profile.usageSpanName, previous?.start ?? time, values), id: previous?.id ?? id(), end: time });
        } else {
          turn.truncated = true;
          if (profile.preserveOverflow) {
            // This opt-in consumes immutable per-receipt deltas, not cumulative
            // snapshots. Keep exact overflow accounting without retaining rows.
            const aggregate = overflow(turn, time).attributes;
            const count = "paperclip.observability.overflow.usage_count";
            aggregate[count] = Number(aggregate[count] ?? 0) + 1;
            if (values.costProvenance) aggregate.costProvenance = aggregate.costProvenance && aggregate.costProvenance !== values.costProvenance ? "mixed" : values.costProvenance;
          }
        }
      }
      if (["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(event.eventType)) finish(event.eventType !== "turn.completed", time);
    },
    async close() {
      if (closed) return;
      closed = true;
      finish(true, Date.now());
      await Promise.all(pending);
    },
  };
}
