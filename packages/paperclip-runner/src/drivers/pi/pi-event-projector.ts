import { createHash } from "node:crypto";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { redactProviderDiagnostic } from "../diagnostic-redaction.js";

/** Driver-admitted ownership, captured once for the lifetime of a Runner turn. */
export interface PiEventOrigin {
  runId: string;
  turnId: string;
}
export interface PiProjectedEvent extends PiEventOrigin {
  eventType: PrpEvent["eventType"];
  itemId?: string;
  payload: Record<string, unknown>;
  debug?: Record<string, unknown>;
}
interface Block { id: string; kind: string; text: string; terminal: boolean; truncated?: boolean }
interface Tool { id: string; name: string; args?: unknown; input: string; terminal: boolean; started: boolean }
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_IDENTITIES = 1024;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const nativeId = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? `s:${value}` : typeof value === "number" && Number.isSafeInteger(value) ? `n:${value}` : undefined;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const TEXT_TRUNCATION_MARKER = "[Pi projection truncated]";
/** Display copies only; Pi executes and persists the untouched native input. */
function boundedText(value: string, budget = MAX_TEXT_BYTES): string {
  if (Buffer.byteLength(JSON.stringify(value)) <= budget) return value;
  let low = 0, high = Math.min(value.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, mid) + TEXT_TRUNCATION_MARKER)) <= budget) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1]!)) low--;
  return value.slice(0, low) + TEXT_TRUNCATION_MARKER;
}
/** Same sensitive-parent rule as codex-boundaries.ts:364-385, before flattening. */
function displayValue(value: unknown, depth = 0, preview = (value: string) => value, previewStrings = false): unknown {
  if (depth > 32) throw new Error("pi_projection_depth_limit");
  if (typeof value === "string") return redactProviderDiagnostic(previewStrings && Buffer.byteLength(value) > MAX_TEXT_BYTES ? preview(value) : value);
  if (Array.isArray(value)) return value.map(entry => displayValue(entry, depth + 1, preview, previewStrings));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /token|secret|password|api.?key|authorization|credential|thinkingSignature|thoughtSignature/i.test(key) && !/^(?:totalTokens|inputTokens|outputTokens|cachedInputTokens|cacheWriteTokens|tokensBefore|estimatedTokensAfter)$/u.test(key) ? "[REDACTED]" : displayValue(entry, depth + 1, preview, previewStrings || /^(?:args|arguments|text|thinking|content|delta|errorMessage)$/u.test(key)),
  ]));
  return value;
}
function contentText(value: unknown): string {
  return (Array.isArray(value) ? value : []).map(block => record(block)).filter(block => block.type === "text").map(block => text(block.text)).join("\n");
}
/** Display-only preview; budget counts JSON escaping, not just native UTF-8. */
function toolOutputPreview(value: string, budget: number): string {
  if (Buffer.byteLength(JSON.stringify(value)) <= budget) return value;
  const marker = "[Pi tool output truncated] ";
  let low = 0, high = Math.min(value.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(marker + value.slice(0, mid))) <= budget) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1]!)) low--;
  return marker + value.slice(0, low);
}
/** Remove only observed tool display data when checking the control/input budget. */
function toolControlRecord(event: Record<string, unknown>): Record<string, unknown> {
  const key = event.type === "message_end" && record(event.message).role === "toolResult" ? "message"
    : event.type === "tool_execution_update" ? "partialResult"
    : event.type === "tool_execution_end" ? "result" : undefined;
  if (!key) return event;
  const result = record(event[key]);
  if (result !== event[key]) return event;
  const { details: _details, structuredContent, content, ...control } = result;
  const structured = record(structuredContent);
  return { ...event, [key]: { ...control,
    content: Array.isArray(content) ? content.map(part => record(part).type === "text" ? { ...record(part), text: "" } : part) : content,
    structuredContent: { exit_code: structured.exit_code, truncated: structured.truncated },
  } };
}

/**
 * One projector per admitted Runner turn, not per socket read or low-level Pi
 * assistant turn. Pi 1.5.2 docs/json.md is the wire authority. Mirrors native
 * Codex canonical items (codex-session-notifications.ts:614-747); no UI fork.
 *
 * The transport owns bounded UTF-8/JSONL decoding, run/session fencing, replay
 * cursors and terminal authority. In particular, agent_end is NOT settlement.
 * No display event authorizes completion, artifact registration or delegation.
 *
 * The driver supplies the admitted origin and retains this projector for any
 * delayed callbacks from that turn, even after settlement/next admission. Every
 * output carries that captured origin; an envelope must not overwrite it with
 * the driver's current run/turn. Native event payloads cannot select ownership.
 */
export function createPiEventProjector(options: PiEventOrigin & { includeThinking?: boolean }): { project(value: unknown): PiProjectedEvent[] } {
  if (typeof options.runId !== "string" || !options.runId || options.runId.length > 240) throw new Error("pi_projection_run_id_invalid");
  if (typeof options.turnId !== "string" || !options.turnId || options.turnId.length > 240) throw new Error("pi_projection_turn_id_invalid");
  // Copy primitive IDs: callers may reuse/mutate their current-origin holder.
  const origin: PiEventOrigin = { runId: options.runId, turnId: options.turnId };
  const includeThinking = options.includeThinking === true;
  const prefix = origin.turnId.length <= 120 ? origin.turnId : `pi-turn-${digest(origin.turnId)}`;
  let ordinal = 0;
  let messageId: string | undefined;
  let blocks = new Map<number, Block>();
  const tools = new Map<string, Tool>();
  const receipts = new Map<string, string>();
  const totals: Record<string, number> = {};
  let usageComplete = true;
  let estimatedCostUsd: number | undefined;
  let providerReportedCostUsd: number | undefined;
  let costComplete = true;
  let identityCount = 0;
  let diagnosticCount = 0;
  let compactionCount = 0;
  let childUsageUnknown = false;
  let displayTruncated = false;
  const projectText = (value: string, budget = MAX_TEXT_BYTES): string => {
    const preview = boundedText(value, budget);
    if (preview !== value) displayTruncated = true;
    return preview;
  };
  let originalToolOutput: { body: string; truncated: boolean } | undefined;
  const diagnostic = (type: string, code = "pi_unknown_event"): PiProjectedEvent[] => {
    // Never copy arbitrary native payloads, extension text or paths to diagnostics.
    if (diagnosticCount > 16) return [];
    const suppressed = diagnosticCount++ === 16;
    return [{ ...origin, eventType: "harness.diagnostic", payload: { code: suppressed ? "pi_diagnostics_suppressed" : code, providerMethod: suppressed ? "suppressed" : type.slice(0, 160) } }];
  };
  const emit = (eventType: PiProjectedEvent["eventType"], itemId: string, payload: Record<string, unknown>): PiProjectedEvent => ({ ...origin, eventType, itemId, payload });
  const identity = () => { if (++identityCount > MAX_IDENTITIES) throw new Error("pi_projection_identity_limit"); };
  const ensureMessage = () => messageId ??= `${prefix}:pi-message:${++ordinal}`;
  const blockFor = (index: number, kind: string): Block => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_IDENTITIES) throw new Error("pi_projection_content_index_invalid");
    let block = blocks.get(index);
    if (!block) { identity(); block = { id: `${ensureMessage()}:block:${index}`, kind, text: "", terminal: false }; blocks.set(index, block); }
    if (block.kind !== kind) throw new Error("pi_projection_content_kind_changed");
    return block;
  };
  const toolFor = (idValue: unknown, name: unknown): Tool => {
    const key = nativeId(idValue);
    if (key === undefined) throw new Error("pi_projection_tool_id_missing");
    let tool = tools.get(key);
    if (!tool) { identity(); tool = { id: `${prefix}:pi-tool:${digest(key)}`, name: text(name), input: "", terminal: false, started: false }; tools.set(key, tool); }
    if (typeof name === "string" && name) {
      if (name.length > 240) throw new Error("pi_projection_tool_name_limit");
      if (tool.name && tool.name !== name) throw new Error("pi_projection_tool_name_changed");
      tool.name = name;
    }
    return tool;
  };
  const toolPayload = (tool: Tool): Record<string, unknown> => ({ kind: tool.name === "bash" ? "commandExecution" : "tool", toolName: tool.name, ...(tool.input ? { input: tool.input } : {}), item: { type: "tool_use", id: tool.id, name: tool.name, ...(tool.args === undefined ? {} : { input: tool.args, arguments: tool.args }) } });
  const startTool = (tool: Tool, output: PiProjectedEvent[]) => {
    if (!tool.started) { tool.started = true; output.push(emit("item.started", tool.id, toolPayload(tool))); }
  };
  const argumentsFor = (tool: Tool, args: unknown) => {
    if (args === undefined) throw new Error("pi_projection_tool_arguments_missing");
    const serialized = JSON.stringify(args);
    tool.input = projectText(serialized);
    tool.args = tool.input === serialized ? structuredClone(args) : { truncated: true, preview: tool.input };
  };
  const usageFor = (message: Record<string, unknown>, key: string, output: PiProjectedEvent[]) => {
    if (message.usage === undefined) { if (message.role === "assistant") { usageComplete = false; costComplete = false; } return; }
    const usage = record(message.usage);
    const names = { input: "inputTokens", output: "outputTokens", cacheRead: "cachedInputTokens", cacheWrite: "cacheWriteTokens" };
    const counts: Record<string, number> = {};
    for (const [native, normalized] of Object.entries(names)) {
      const value = usage[native];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counts[normalized] = value;
      else usageComplete = false;
    }
    // Native Pi input excludes cache; preserve totalTokens separately rather
    // than borrowing Codex's provider-specific inclusive-input semantics.
    const total = usage.totalTokens;
    if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0) counts.totalTokens = total;
    else if (Object.keys(counts).length === 4) {
      const sum = Object.values(counts).reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(sum)) throw new Error("pi_projection_usage_overflow");
      counts.totalTokens = sum;
    }
    for (const [name, count] of Object.entries(counts)) {
      const sum = (totals[name] ?? 0) + count;
      if (!Number.isSafeInteger(sum)) throw new Error("pi_projection_usage_overflow");
      totals[name] = sum;
    }
    const cost = record(usage.cost).total;
    let costProvenance = "unknown";
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      if (record(usage.cost).totalFromProvider === true) { providerReportedCostUsd = (providerReportedCostUsd ?? 0) + cost; costProvenance = "provider_reported"; }
      else { estimatedCostUsd = (estimatedCostUsd ?? 0) + cost; costProvenance = "catalog_estimate"; }
      if (!Number.isFinite(estimatedCostUsd ?? 0) || !Number.isFinite(providerReportedCostUsd ?? 0)) throw new Error("pi_projection_cost_overflow");
    } else costComplete = false;
    const receiptItemId = `${prefix}:pi-usage:${digest(key)}`;
    // App native task chat folds per-receipt runDelta, not accumulated totals
    // (native-run-events.ts:1364-1405). Catalog prices are NOT provider billing.
    output.push(emit("usage.reported", receiptItemId, {
      provider: "pi_rpc", model: message.model ?? null, providerRequestId: digest(key),
      runDeltaAvailable: Object.keys(counts).length >= 5,
      runDelta: { ...(counts.inputTokens === undefined ? {} : { inputTokens: counts.inputTokens }), ...(counts.outputTokens === undefined ? {} : { outputTokens: counts.outputTokens }), ...(counts.cachedInputTokens === undefined ? {} : { cacheReadTokens: counts.cachedInputTokens }), ...(counts.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: counts.cacheWriteTokens }), ...(record(usage.cost).totalFromProvider === true && typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { providerCostUsd: cost } : {}) },
      childUsage: "unknown", accountingComplete: usageComplete && !childUsageUnknown,
      costProvenance, ...(costProvenance === "catalog_estimate" ? { estimatedCostUsd: cost } : {}),
    }));
    output.push(emit("item.completed", receiptItemId, {
      kind: "usage", usage: { receiptId: digest(receiptItemId), scope: message.role === "toolResult" ? "nested_tool_message" : "assistant_message", source: "pi_message_usage",
        total: { ...totals }, runDelta: { ...totals }, runDeltaComplete: usageComplete && !childUsageUnknown, childUsage: "unknown",
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }), ...(providerReportedCostUsd === undefined ? {} : { providerReportedCostUsd }), costProvenance, costComplete,
      },
    }));
  };
  const projectTool = (event: Record<string, unknown>, output: PiProjectedEvent[]) => {
    const tool = toolFor(event.toolCallId, event.toolName);
    if (tool.name === "subagent") { childUsageUnknown = true; usageComplete = false; costComplete = false; }
    if (tool.terminal) return;
    if (event.args !== undefined) argumentsFor(tool, event.args);
    startTool(tool, output);
    const end = event.type === "tool_execution_end";
    const result = record(end ? event.result : event.partialResult);
    const fullBody = contentText(result.content);
    const body = Buffer.byteLength(fullBody) <= MAX_TEXT_BYTES ? fullBody : toolOutputPreview(fullBody, MAX_TEXT_BYTES);
    const outputWasTruncated = originalToolOutput?.truncated === true || body !== fullBody;
    if (outputWasTruncated) displayTruncated = true;
    const failed = event.isError === true;
    const duration = typeof event.durationMs === "number" && Number.isSafeInteger(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null;
    if (end) tool.terminal = true;
    output.push(emit(end ? failed ? "item.failed" : "item.completed" : "item.delta", tool.id, { ...toolPayload(tool), ...(end ? { text: body, output: body } : body ? { output: body } : {}), ...(failed ? { message: body || "Pi tool execution failed." } : {}), ...(duration === null ? {} : { durationMs: duration }) }));
    output.push(emit(end ? "tool.execution.completed" : event.type === "tool_execution_start" ? "tool.execution.started" : "tool.execution.progressed", tool.id, {
      schema: "paperclip.tool.execution.v1", executionId: tool.id,
      transport: tool.name === "bash" ? "process" : "dynamic", operation: tool.name === "bash" ? "execute" : "unknown", name: (tool.name === "bash" ? text(record(tool.args).command) : tool.name) || tool.name || null,
      target: null, namespace: null, readOnly: null, status: end ? failed ? "failed" : "completed" : "running", durationMs: duration, exitCode: Number.isSafeInteger(record(result.structuredContent).exit_code) ? record(result.structuredContent).exit_code : null,
      progress: null, output: body || null, outputBytes: Buffer.byteLength(originalToolOutput?.body ?? fullBody), outputTruncated: outputWasTruncated || record(result.structuredContent).truncated === true, outputDigest: (originalToolOutput?.body ?? fullBody) ? `sha256:${digest(originalToolOutput?.body ?? fullBody)}` : null,
    }));
  };
  return { project(value: unknown): PiProjectedEvent[] {
    // Only tool output display is lossy. Inputs, receipts, usage and control
    // remain authoritative and fail clearly if they alone exceed the budget.
    const serialized = JSON.stringify(value);
    if (!serialized) throw new Error("pi_projection_record_limit");
    const recordBytes = Buffer.byteLength(serialized);
    const source = record(value);
    // Custom session entries are extension display history, not executable
    // inputs or final receipts. Digest an oversized body before redaction.
    const customDisplay = source.type === "entry_appended" && record(source.entry).type === "custom"
      && source.toolCallId === undefined && recordBytes > MAX_RECORD_BYTES;
    const control = customDisplay ? { ...source, entry: { ...record(source.entry), data: undefined } } : toolControlRecord(source);
    if (recordBytes > MAX_RECORD_BYTES && (control === source || Buffer.byteLength(JSON.stringify(control)) > MAX_RECORD_BYTES)) throw new Error("pi_projection_record_limit");
    displayTruncated = recordBytes > MAX_RECORD_BYTES;
    originalToolOutput = undefined;
    let observed: unknown = customDisplay ? control : value;
    if (control !== source && !customDisplay) {
      const key = source.type === "message_end" ? "message" : source.type === "tool_execution_update" ? "partialResult" : "result";
      const nativeResult = record(source[key]);
      const fullBody = contentText(nativeResult.content);
      const preview = Buffer.byteLength(fullBody) <= MAX_TEXT_BYTES ? fullBody : toolOutputPreview(fullBody, MAX_TEXT_BYTES);
      if (displayTruncated || preview !== fullBody) {
        // Bound before diagnostic redaction: ignored megabyte details and
        // cumulative output must not enter its regular-expression passes.
        originalToolOutput = { body: fullBody, truncated: preview !== fullBody };
        observed = { ...control, [key]: { ...record(control[key]), content: [{ type: "text", text: preview }] } };
      }
    }
    const event = record(displayValue(observed, 0, projectText));
    const output: PiProjectedEvent[] = [];
    if (event.type === "message_start" && record(event.message).role === "assistant") {
      messageId = `${prefix}:pi-message:${++ordinal}`;
      blocks = new Map();
    } else if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      const type = text(update.type);
      if (["text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end"].includes(type)) {
        const thinking = type.startsWith("thinking_");
        if (thinking && !includeThinking) return [];
        const kind = thinking ? "reasoning" : "agentMessage";
        const index = update.contentIndex;
        if (typeof index !== "number") throw new Error("pi_projection_content_index_invalid");
        const existing = blocks.has(index);
        const block = blockFor(index, kind);
        if (block.terminal) return [];
        const payload = { kind, channel: thinking ? "detail" : "unknown" };
        if (!existing) output.push(emit("item.started", block.id, { ...payload, text: "" }));
        if (type.endsWith("_delta")) {
          if (!block.truncated) {
            const combined = block.text + text(update.delta);
            // Reserve room for the marker even when prior deltas already filled
            // the preview. A terminal snapshot replaces this streamed display.
            const next = projectText(combined, MAX_TEXT_BYTES - 128);
            block.truncated = next !== combined;
            const delta = block.truncated && next.length - TEXT_TRUNCATION_MARKER.length < block.text.length
              ? TEXT_TRUNCATION_MARKER : next.slice(block.text.length);
            block.text = next;
            if (delta) output.push(emit("item.delta", block.id, { ...payload, text: delta }));
          }
        } else if (type.endsWith("_end")) {
          block.text = projectText(text(update.content));
          // The block-end snapshot is not a delta. message_end publishes its
          // authoritative final content/status without duplicating streamed text.
        }
      } else if (["toolcall_start", "toolcall_delta", "toolcall_end"].includes(type)) {
        if (type === "toolcall_start") startTool(toolFor(update.id, update.toolName), output);
        else if (type === "toolcall_end") {
          const call = record(update.toolCall); const tool = toolFor(call.id, call.name);
          argumentsFor(tool, call.arguments); startTool(tool, output);
          output.push(emit("item.delta", tool.id, toolPayload(tool)));
        }
        // Argument fragments are not executable arguments. The terminal native
        // toolCall and tool_execution_start carry exact complete input.
      } else if (!["start", "done", "error"].includes(type)) output.push(...diagnostic(`message_update.${type}`));
      // start/done/error are provider-stream wrappers; authoritative lifecycle
      // and accounting come from message_start/message_end, never twice.
    } else if (event.type === "message_end") {
      const message = record(event.message);
      if (message.role === "assistant") {
        if (nativeId(message.responseId) === undefined && (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || !text(message.provider) || !text(message.model))) throw new Error("pi_projection_receipt_identity_missing");
        const receiptKey = `assistant:${JSON.stringify([message.provider, message.model, nativeId(message.responseId) ?? message.timestamp])}`;
        const fingerprint = digest(JSON.stringify(message));
        const previous = receipts.get(receiptKey);
        if (previous !== undefined) { if (previous !== fingerprint) throw new Error("pi_projection_conflicting_receipt"); return []; }
        identity(); receipts.set(receiptKey, fingerprint);
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        if (failed) { usageComplete = false; costComplete = false; }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const [index, entry] of content.entries()) {
          const part = record(entry);
          if (part.type === "toolCall") {
            const tool = toolFor(part.id, part.name); argumentsFor(tool, part.arguments); startTool(tool, output);
            if (!tool.terminal) output.push(emit("item.delta", tool.id, toolPayload(tool)));
          } else if (part.type === "text" || (part.type === "thinking" && includeThinking && part.redacted !== true)) {
            const kind = part.type === "thinking" ? "reasoning" : "agentMessage";
            const block = blockFor(index, kind);
            if (block.terminal) continue;
            block.text = projectText(text(kind === "reasoning" ? part.thinking : part.text)); block.terminal = true;
            output.push(emit(failed ? "item.failed" : "item.completed", block.id, { kind, channel: kind === "reasoning" ? "detail" : message.stopReason === "toolUse" ? "progress" : "final", text: block.text,
              ...(failed ? { message: projectText(text(message.errorMessage) || `Pi ${message.stopReason}`) } : {}),
            }));
          }
        }
        let omittedBlock = false;
        for (const block of blocks.values()) if (!block.terminal) {
          omittedBlock = true; block.terminal = true;
          output.push(emit("item.failed", block.id, { kind: block.kind, text: "", message: projectText(text(message.errorMessage) || "Pi final receipt omitted a streamed block.") }));
        }
        if (failed && !omittedBlock && !content.some(part => record(part).type === "text")) {
          output.push(emit("item.failed", `${ensureMessage()}:failure`, { kind: "agentMessage", message: projectText(text(message.errorMessage) || `Pi ${message.stopReason}`) }));
        }
        usageFor(message, receiptKey, output);
        messageId = undefined; blocks = new Map();
      } else if (message.role === "toolResult") {
        projectTool({ type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError, durationMs: message.durationMs }, output);
        if (message.usage !== undefined) {
          const id = nativeId(message.toolCallId);
          if (id === undefined) throw new Error("pi_projection_tool_id_missing");
          const key = `tool:${id}`;
          const fingerprint = digest(JSON.stringify(message.usage));
          if (!receipts.has(key)) { identity(); receipts.set(key, fingerprint); usageFor(message, key, output); }
          else if (receipts.get(key) !== fingerprint) throw new Error("pi_projection_conflicting_receipt");
        }
      }
    } else if (["compaction_start", "compaction_end", "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished"].includes(text(event.type))) {
      // Summarization can spend outside assistant-message receipts (native
      // json.md:128-180). Do not claim complete accounting for an unqualified
      // capability. The integrator may qualify its native receipt path later.
      usageComplete = false; costComplete = false;
      output.push(emit("item.completed", `${prefix}:pi-usage:unaccounted-summary`, { kind: "usage", usage: { source: "pi_summarization_unaccounted", total: { ...totals }, runDelta: { ...totals }, runDeltaComplete: false, costComplete: false, childUsage: "unknown" } }));
      const result = record(event.result);
      if (event.type === "compaction_end" && event.aborted !== true && event.errorMessage === undefined && event.result !== undefined) {
        const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
        output.push(emit("context.compacted", `${prefix}:pi-compaction:${++compactionCount}`, { schema: "paperclip.context.compacted.v1", compactionId: `${prefix}:pi-compaction:${compactionCount}`, reason: event.reason === "manual" ? "manual" : ["threshold", "overflow"].includes(text(event.reason)) ? "context_window" : "unknown", preTokens: count(result.tokensBefore), postTokens: count(result.estimatedTokensAfter), sameSession: true }));
      } else output.push(...diagnostic(text(event.type), "pi_summarization_activity"));
    } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(text(event.type))) {
      projectTool(event, output);
    } else if (event.type === "extension_ui_request") {
      // Driver must durably bridge or send {type:extension_ui_response,id,
      // cancelled:true} for select/confirm/input/editor. This is not an answer.
      output.push(...diagnostic(`extension_ui_request.${text(event.method)}`, ["select", "confirm", "input", "editor"].includes(text(event.method)) ? "pi_extension_ui_requires_response" : "pi_extension_ui_notice"));
    } else if (["queue_update", "entry_appended", "session_info_changed", "thinking_level_changed", "auto_retry_start", "auto_retry_end", "bash_execution_update", "extension_error"].includes(text(event.type))) {
      output.push(...diagnostic(text(event.type), "pi_native_activity"));
    } else if (!["response", "session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "extension_ui_response"].includes(text(event.type))) {
      output.push(...diagnostic(text(event.type)));
    }
    // Bound the actual wire payload, including duplicate text fields and JSON
    // escapes. Inputs/arguments here are display copies, never execution authority.
    for (const projected of output) {
      if (Buffer.byteLength(JSON.stringify(projected)) <= MAX_RECORD_BYTES - 2048) continue;
      const isTool = projected.eventType.startsWith("tool.execution.") || ["tool", "commandExecution"].includes(text(projected.payload.kind));
      if (!isTool) throw new Error("pi_projection_record_limit");
      const keys = ["text", "output", "message"].filter(key => typeof projected.payload[key] === "string");
      const base = { ...projected, payload: { ...projected.payload } };
      for (const key of keys) base.payload[key] = "";
      const budget = Math.floor((MAX_RECORD_BYTES - 2048 - Buffer.byteLength(JSON.stringify(base))) / Math.max(keys.length, 1));
      if (!keys.length || budget < 128) throw new Error("pi_projection_record_limit");
      for (const key of keys) projected.payload[key] = toolOutputPreview(text(projected.payload[key]), budget);
      if (projected.eventType.startsWith("tool.execution.")) projected.payload.outputTruncated = true;
      displayTruncated = true;
    }
    if (displayTruncated) {
      const piProjection = { truncated: true, recordBytes, recordSha256: digest(serialized) };
      for (const projected of output) projected.debug = { piProjection };
    }
    return output;
  } };
}
