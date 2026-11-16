import { notifyActiveRunSilence } from "../live-run-recovery-notifications.js";
import { retryThroughStorageOutage, storageOutageWaitFor } from "../../storage/storage-unavailable.js";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterInvocationMeta, AdapterRuntimeEvent } from "../../adapters/index.js";
import { redactCurrentUserText, type CurrentUserRedactionOptions } from "../../log-redaction.js";
import type { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { touchHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { publishLiveEvent } from "../live-events.js";
import { isRunLogStoreType, type RunLogHandle, type RunLogStore } from "../run-log-store.js";
import { appendExcerpt, canonicalNativeRunLogRedactionForms, compactRunLogChunk, redactCanonicalNativeRunLogChunk } from "./run-log.js";
import { createNativeRunLogExporter, nativeRunLogPrefixCursor } from "../native-runtime/native-run-log-export.js";
import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";
import {
  isHeartbeatRunRuntimeStatusActive,
  publishHeartbeatRunRuntimeProgress,
  type createHeartbeatLifecycle,
} from "./run-lifecycle.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
// Tool-output adapter events carry streamed text, like onLog chunks.
const TOOL_OUTPUT_EVENT = /^tool[._]/;
// The text fields the native delta path streams, plus the event's message.
const STREAMED_EVENT_TEXT = /^(text|delta|output|patch)$/;
const isStreamedEventText = (path: string[]) => path.length === 1 ? path[0] === "message"
  : STREAMED_EVENT_TEXT.test(path[path.length - 1]!);
const TOOL_CALL_KEYS = ["toolCallId", "callId", "toolUseId", "itemId", "executionId"];
type AppendRunEventInput = Parameters<ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"]>[1];
export const ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS = 60 * 1000;
export const ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS = 5 * 1000;

type Run = typeof heartbeatRuns.$inferSelect;
type CanonicalNativeLog = { kind: "canonical_native"; sourceCursor: number };

export interface HeartbeatRunOutputInput {
  run: Run;
  runId: string;
  issueId: string | null;
  runLogStore: Pick<RunLogStore, "begin" | "append" | "enqueue" | "flush"> & Partial<Pick<RunLogStore, "read" | "recordVerifiedSourcePrefix">>;
  identityRedactor: Pick<ReturnType<typeof createAgentIdentityRedactor>, "chunk" | "redact">
    & Partial<Pick<ReturnType<typeof createAgentIdentityRedactor>, "holds" | "finish">>;
  secretKeys: Set<string>;
  appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  assertWriterAuthority?: () => Promise<void>;
  runtimeLogSecretValues?: readonly string[];
  deferNativeLogRecovery?: boolean;
  signal?: AbortSignal;
}

/**
 * True only when the persisted run row proves no earlier attempt began its log.
 * The first begin() records logStore/logRef before any output can be appended
 * or mirrored to object storage; output sequence and final size are recorded
 * after that. A row with none of them has no durable log prefix to restore.
 */
export function isNewRunLog(
  run: Pick<Run, "logStore" | "logRef" | "logBytes" | "lastOutputSeq">,
): boolean {
  return (
    run.logStore == null &&
    run.logRef == null &&
    run.logBytes == null &&
    Number(run.lastOutputSeq ?? 0) === 0
  );
}

/** One recorder per execution attempt; the log store itself stays service-scoped. */
export function createHeartbeatRunOutput(db: Db, input: HeartbeatRunOutputInput) {
  const {
    run,
    runId,
    issueId,
    runLogStore,
    identityRedactor,
    secretKeys,
    appendRunEvent,
    getCurrentUserRedactionOptions,
  } = input;
  let handle: RunLogHandle | null = null;
  let stdoutExcerpt = "";
  let stderrExcerpt = "";
  let outputSeq = Number(run.lastOutputSeq ?? 0);
  let lastOutputFlushAt: Date | null = run.lastOutputAt ?? null;
  let lastLogRuntimeStatusTouchMs = 0;
  const outputProgressState: {
    pending: {
      at: Date;
      seq: number;
      stream: "stdout" | "stderr";
      bytes: number;
    } | null;
  } = { pending: null };
  let persistedLogBytes = Number(run.logBytes ?? 0);
  let progressWrite: Promise<void> | null = null;
  let recordingFailureReported = false;
  let deferredLogRecovery: Promise<void> | null = null;
  const flushOutputProgress = async (opts?: { force?: boolean }) => {
    if (progressWrite) {
      await progressWrite;
      if (opts?.force) return flushOutputProgress(opts);
      return;
    }
    const pendingOutputProgress = outputProgressState.pending;
    if (!pendingOutputProgress) return;
    const shouldFlush =
      opts?.force === true ||
      !lastOutputFlushAt ||
      pendingOutputProgress.at.getTime() - lastOutputFlushAt.getTime() >=
        ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS;
    if (!shouldFlush) return;
    progressWrite = db.transaction(async tx => {
      await notifyActiveRunSilence(tx, { companyId: run.companyId, runId: run.id });
      await tx.update(heartbeatRuns)
      .set({
        lastOutputAt: pendingOutputProgress.at,
        lastOutputSeq: pendingOutputProgress.seq,
        lastOutputStream: pendingOutputProgress.stream,
        lastOutputBytes: pendingOutputProgress.bytes,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
    })
      .then(() => {
        lastOutputFlushAt = pendingOutputProgress.at;
        if (outputProgressState.pending === pendingOutputProgress)
          outputProgressState.pending = null;
      })
      .finally(() => {
        progressWrite = null;
      });
    await progressWrite;
  };
  // Bind handlers to the run row persisted at execution start. Progress writes
  // above use only the immutable run ID from the initial row.
  async function begin(currentRun: Run) {
    const run = currentRun;
    if (run.logStore != null && !isRunLogStoreType(run.logStore))
      throw new Error("Run log backend is not supported");
    const previousStore = run.logStore ?? undefined;
    handle = await storageOutageWaitFor("starting the run log", () => retryThroughStorageOutage(() => runLogStore.begin({
      companyId: run.companyId,
      agentId: run.agentId,
      runId,
      newRun: isNewRunLog(run),
      assertWriterAuthority: input.assertWriterAuthority,
      previousStore,
      signal: input.signal,
    }), input.signal));

    outputSeq = handle.initialSequence ?? outputSeq;
    persistedLogBytes = handle.initialBytes ?? persistedLogBytes;
    await db
      .update(heartbeatRuns)
      .set({
        logStore: handle.store,
        logRef: handle.logRef,
        ...(handle.store === "s3_segments" ? { logBytes: null, logSha256: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId));

    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const reportRecordingFailure = async () => {
      if (recordingFailureReported) return;
      recordingFailureReported = true;
      await appendRunEvent(currentRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run log persistence is incomplete",
        payload: { reason: "object_log_persistence_failed" },
      }).catch(() => undefined);
    };
    const appendIdentityRedactedLog = async (
      stream: "stdout" | "stderr",
      chunk: string,
      waitForCommit = true,
      source?: CanonicalNativeLog,
    ) => {
      const sourceCursor = source?.sourceCursor;
      const sanitizedChunk = source?.kind === "canonical_native"
        ? redactCanonicalNativeRunLogChunk(chunk, {
            redactIdentity: identityRedactor.redact,
            currentUser: currentUserRedactionOptions,
          })
        : compactRunLogChunk(redactCurrentUserText(chunk, currentUserRedactionOptions));
      if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
      if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
      const ts = new Date().toISOString();

      outputSeq += 1;
      const chunkSeq = outputSeq;
      let committed: Promise<number> = Promise.resolve(0);
      if (handle) {
        let nativeLooking = chunk.includes('"paperclip.prp.event"');
        try { nativeLooking ||= JSON.parse(chunk)?.type === "paperclip.prp.event"; } catch { /* Diagnostics need not be JSON. */ }
        const event = {
          stream,
          chunk: sanitizedChunk,
          ts,
          seq: chunkSeq,
          sourceCursor,
          preservesSourceCoverage: source?.kind === "canonical_native" || !nativeLooking,
        };
        committed = runLogStore.enqueue
          ? (await runLogStore.enqueue(handle, event)).committed
          : runLogStore.append(handle, event);
      }
      const recorded = committed.then(async (appendedBytes) => {
        persistedLogBytes += appendedBytes;
        outputProgressState.pending = {
          at: new Date(ts),
          seq: chunkSeq,
          stream,
          bytes: persistedLogBytes,
        };
        await flushOutputProgress();

        // Streamed CLI output is real run activity: keep the in-memory
        // runtime status ("Working... / X ago") fresh between structured
        // events so sandbox runs with mid-run log streaming never show a
        // minutes-stale timestamp. Throttled to avoid churning the live
        // event stream on every 250ms tail chunk.
        const logActivityAt = new Date(ts);
        if (
          isHeartbeatRunRuntimeStatusActive(run.status) &&
          logActivityAt.getTime() - lastLogRuntimeStatusTouchMs >=
            ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS
        ) {
          lastLogRuntimeStatusTouchMs = logActivityAt.getTime();
          const touchedStatus = touchHeartbeatRunRuntimeStatus({
            companyId: run.companyId,
            issueId,
            agentId: run.agentId,
            runId: run.id,
            at: logActivityAt,
          });
          if (touchedStatus) publishHeartbeatRunRuntimeProgress(touchedStatus);
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            issueId,
            ts,
            seq: chunkSeq,
            stream,
            chunk: payloadChunk,
            logRef: handle?.logRef,
            logStore: handle?.store,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      });
      if (waitForCommit) await recorded;
      else void recorded.catch(reportRecordingFailure);
    };
    const onLog = (stream: "stdout" | "stderr", chunk: string) => {
      const external = handle?.store === "s3_segments";
      const recorded = appendIdentityRedactedLog(
        stream,
        identityRedactor.chunk(stream, chunk),
        !external,
      );
      return external ? recorded.catch(reportRecordingFailure) : recorded;
    };
    let nativeExporter: Promise<ReturnType<typeof createNativeRunLogExporter>> | undefined;
    const getNativeExporter = () => nativeExporter ??= (async () => {
      if (input.runtimeLogSecretValues?.length) {
        const registry = createRunSecretRedactionRegistry(db);
        for (const value of new Set(input.runtimeLogSecretValues))
          await registry.register(run.companyId, runId, value);
      }
      const afterCursor = await nativeRunLogPrefixCursor({
        db, companyId: run.companyId, runId, store: runLogStore, handle: handle!,
        // Verify the two supported historical username-masking settings. Keep
        // the full private-data projection here; compaction is proved separately.
        redactChunks: (chunk) => canonicalNativeRunLogRedactionForms(chunk, {
          redactIdentity: identityRedactor.redact, currentUser: currentUserRedactionOptions,
        }),
      });
      return createNativeRunLogExporter({
        db,
        companyId: run.companyId,
        runId,
        afterCursor,
        enqueue: (cursor, chunk) =>
          appendIdentityRedactedLog(
            "stdout",
            chunk,
            false,
            { kind: "canonical_native", sourceCursor: cursor },
          ),
        flush: () => runLogStore.flush!(handle!),
      });
    })();
    if (handle.store === "s3_segments" && run.runtimeMode === "native") {
      const recovering = getNativeExporter().then(exporter => exporter.recover());
      if (input.deferNativeLogRecovery) deferredLogRecovery = recovering.catch(reportRecordingFailure);
      else await recovering;
    }
    // Output begins before runtime selection persists native mode. Keep the
    // source-aware callback available without querying native sources for
    // ordinary legacy output.
    const onPersistedNativeLog = handle.store === "s3_segments"
      ? (cursor: number, chunk: string) =>
          getNativeExporter().then((exporter) => exporter.record(cursor, chunk)).catch(reportRecordingFailure)
      : undefined;
    const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
      meta = identityRedactor.redact(meta);
      if (meta.env && secretKeys.size > 0) {
        for (const key of secretKeys) {
          if (key in meta.env) meta.env[key] = "***REDACTED***";
        }
      }
      await appendRunEvent(currentRun, {
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: meta as unknown as Record<string, unknown>,
      });
    };

    // A secret can be split across two tool-output events, as across two log
    // chunks. Their text fields share onLog's per-stream hold (chunk/finish),
    // keyed by event type, stream and tool call; every other field is redacted
    // whole, as for any event. An event whose text ends in a held suffix is
    // committed when the next event of the run arrives, or at finish with the
    // released tail: one adapter event stays one committed event, and events
    // commit in adapter order. A held tail released by a later event of its own
    // stream lands in that event; if its stream never sends again, finish
    // commits the tail alone in an event of that stream (`committed`).
    const toolOutputStreams = new Map<string, { event: AppendRunEventInput; held: Map<string, string[]>; committed: boolean }>();
    const holds = (id: string) => identityRedactor.holds?.(id) ?? false;
    // Before any later event of the run is committed, commit the older held
    // event as it stands. Its stream keeps the hold, so a secret split across
    // that stream's events is still matched; the event's place is kept.
    const commitHeldEvents = async () => {
      for (const [key, entry] of toolOutputStreams) {
        if (entry.committed) continue;
        await appendRunEvent(currentRun, entry.event);
        const { eventType, stream, level, color, payload } = entry.event;
        const callKeys = Object.fromEntries(TOOL_CALL_KEYS.filter(name => payload?.[name] !== undefined)
          .map(name => [name, payload![name]]));
        toolOutputStreams.set(key, { held: entry.held, committed: true,
          event: { eventType, stream, level, color, ...(Object.keys(callKeys).length ? { payload: callKeys } : {}) } });
      }
    };
    const appendToolOutputEvent = async (raw: AdapterRuntimeEvent, redacted: AdapterRuntimeEvent, eventType: string) => {
      const rawPayload: Record<string, unknown> = raw.payload ?? {};
      const call = TOOL_CALL_KEYS.map(key => rawPayload[key]).find(value => typeof value === "string") ?? null;
      const key = JSON.stringify([eventType, raw.stream ?? null, call]);
      await commitHeldEvents();
      const previous = toolOutputStreams.get(key);
      toolOutputStreams.delete(key);
      const held = new Map([...previous?.held ?? []].filter(([id]) => holds(id)));
      // Walk the raw event beside its whole-redacted copy: streamed text is
      // chunked from the raw value, anything else keeps the redacted value.
      const visit = (rawValue: unknown, redactedValue: unknown, path: string[]): unknown => {
        if (typeof rawValue === "string" && isStreamedEventText(path)) {
          const id = `${key}:${JSON.stringify(path)}`;
          const output = identityRedactor.chunk(id, rawValue);
          if (holds(id)) held.set(id, path);
          else held.delete(id);
          return output;
        }
        if (Array.isArray(rawValue) && Array.isArray(redactedValue))
          return redactedValue.map((child, index) => visit(rawValue[index], child, [...path, String(index)]));
        if (rawValue && redactedValue && typeof rawValue === "object" && typeof redactedValue === "object"
          && !Array.isArray(rawValue) && !(rawValue instanceof Date)) {
          return Object.fromEntries(Object.entries(redactedValue).map(([name, child]) =>
            [name, visit((rawValue as Record<string, unknown>)[name], child, [...path, name])]));
        }
        return redactedValue;
      };
      const event: AppendRunEventInput = {
        eventType: eventType.slice(0, 120),
        stream: redacted.stream,
        level: redacted.level,
        color: redacted.color,
        message: visit(raw.message, redacted.message, ["message"]) as string | undefined,
        payload: visit(raw.payload, redacted.payload, ["payload"]) as Record<string, unknown> | undefined,
      };
      if (held.size) toolOutputStreams.set(key, { event, held, committed: false });
      else await appendRunEvent(currentRun, event);
    };
    const finishAdapterEvents = async () => {
      // The event still held arrived before finish: it commits before the
      // tails of streams whose events were already committed in order.
      const streams = [...toolOutputStreams.values()].sort((left, right) => Number(left.committed) - Number(right.committed));
      toolOutputStreams.clear();
      for (const { event, held, committed } of streams) {
        let released = false;
        for (const [id, path] of held) {
          const tail = identityRedactor.finish?.(id) ?? "";
          if (!tail) continue;
          let target = event as unknown as Record<string, unknown>;
          for (const name of path.slice(0, -1)) {
            if (!target[name] || typeof target[name] !== "object") target[name] = {};
            target = target[name] as Record<string, unknown>;
          }
          const field = path[path.length - 1]!;
          target[field] = `${typeof target[field] === "string" ? target[field] : ""}${tail}`;
          released = true;
        }
        // An event already committed in order gets only its released tail.
        if (!committed || released) await appendRunEvent(currentRun, event);
      }
    };

    const onAdapterEvent = async (event: AdapterRuntimeEvent) => {
      const raw = event;
      event = identityRedactor.redact(event);
      const eventType = event.eventType.trim();
      // This namespace attests host-owned handoff cleanup. Legacy adapters do
      // not carry nativeSource identities, so they must never author it.
      if (!eventType || eventType.startsWith("legacy.case_handoff_")) return;
      if (TOOL_OUTPUT_EVENT.test(eventType)) return appendToolOutputEvent(raw, event, eventType);
      await commitHeldEvents();
      await appendRunEvent(currentRun, {
        eventType: eventType.slice(0, 120),
        stream: event.stream,
        level: event.level,
        color: event.color,
        message: event.message,
        payload: event.payload,
      });
    };

    return {
      currentUserRedactionOptions,
      appendIdentityRedactedLog,
      onLog,
      onPersistedNativeLog,
      onAdapterMeta,
      onAdapterEvent,
      finishAdapterEvents,
    };
  }

  return {
    begin,
    get handle() {
      return handle;
    },
    outputProgressState,
    flushOutputProgress,
    settleDeferredLogRecovery: async () => { await deferredLogRecovery; },
    // Finalization awaits I/O and can receive more output before persisting excerpts.
    get stdoutExcerpt() {
      return stdoutExcerpt;
    },
    get stderrExcerpt() {
      return stderrExcerpt;
    },
  };
}
