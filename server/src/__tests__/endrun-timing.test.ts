import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFileSystemSandboxCallbackBridgeQueueClient, startSandboxCallbackBridgeWorker } from "../../../packages/adapter-utils/src/sandbox-callback-bridge.js";
import { createNativeGitHubAccess } from "../services/native-runtime/native-github-access.js";
import { beginEndrunTiming, finishEndrunTiming, markEndrunFinishedAt, measureRunPhase, measureWorkspaceSyncPhase, withRunExecutionTiming } from "../services/execution-preparation-timing.js";

let exporter: InMemorySpanExporter;
let provider: TracerProvider;
beforeEach(() => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
  expect(context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())).toBe(true);
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
});
afterEach(async () => {
  trace.disable(); context.disable(); await provider.shutdown(); vi.unstubAllEnvs();
});

it("shares a terminal scope across existing async children, but not concurrent runs or post-finish work", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const secondFinished = Promise.withResolvers<void>();
  await Promise.all([
    withRunExecutionTiming("first", async () => {
      await measureRunPhase("execution.runtime", async () => {
        beginEndrunTiming(); beginEndrunTiming();
        firstStarted.resolve();
        await secondFinished.promise;
      });
      await measureRunPhase("adapter_events.drain", async () => {});
      finishEndrunTiming(true, "another-run"); // cannot close the current run
      markEndrunFinishedAt(new Date());
      finishEndrunTiming(true, "first");
      beginEndrunTiming(); // late terminal notifications cannot reopen the tail
      await measureRunPhase("completion.cost", async () => {});
    }),
    withRunExecutionTiming("second", async () => {
      await firstStarted.promise;
      await measureRunPhase("execution.usage", async () => {});
      secondFinished.resolve();
    }),
  ]);
  const spans = exporter.getFinishedSpans();
  const tail = spans.filter(span => span.name === "endrun");
  expect(tail).toHaveLength(1);
  expect(spans.find(span => span.name === "adapter_events.drain")?.parentSpanContext?.spanId).toBe(tail[0]!.spanContext().spanId);
  for (const name of ["completion.cost", "execution.usage"]) expect(spans.find(span => span.name === name)?.parentSpanContext?.spanId).not.toBe(tail[0]!.spanContext().spanId);
  expect(tail[0]!.events.map(event => event.name)).toEqual(["turn.terminal", "finished_at.sampled", "terminal.db_commit"]);
});

it("closes abandoned attempts without asserting a database commit and is inert without tracing", async () => {
  await expect(withRunExecutionTiming("failed", async () => { beginEndrunTiming(); throw new Error("fixture"); })).rejects.toThrow("fixture");
  const tail = exporter.getFinishedSpans().find(span => span.name === "endrun");
  expect(tail?.events.map(event => event.name)).toEqual(["turn.terminal", "endrun.abandoned"]);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  let calls = 0;
  await withRunExecutionTiming("disabled", async () => {
    beginEndrunTiming();
    await measureRunPhase("adapter_events.drain", async () => { calls++; });
    finishEndrunTiming(true);
  });
  expect(calls).toBe(1);
  expect(exporter.getFinishedSpans().filter(span => span.name === "endrun")).toHaveLength(1);
});

it("times the real managed GitHub authority release and queue pause waits without changing their fence or drain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endrun-queue-"));
  const pollStarted = Promise.withResolvers<void>();
  const pollJoin = Promise.withResolvers<void>();
  const poll = Promise.withResolvers<string[]>();
  let firstPoll = true;
  let access: Awaited<ReturnType<typeof createNativeGitHubAccess>> | undefined;
  let worker: Awaited<ReturnType<typeof startSandboxCallbackBridgeWorker>> | undefined;
  try {
    await withRunExecutionTiming("github-fixture", async () => {
      const client = createFileSystemSandboxCallbackBridgeQueueClient();
      worker = await startSandboxCallbackBridgeWorker({
        queueDir: path.join(root, "queue"), iterationTimeoutMs: 5_000,
        client: { ...client, listJsonFiles: async directory => {
          if (firstPoll) { firstPoll = false; pollStarted.resolve(); return poll.promise; }
          return client.listJsonFiles(directory);
        } },
        runtimeSpan: (name, work) => {
          if (name === "github.run_release.poll_join") pollJoin.resolve();
          return measureWorkspaceSyncPhase(name, work);
        },
        authorizeRequest: async () => null,
        handleRequest: async () => { throw new Error("Empty queue must not dispatch"); },
      });
      const scope = { companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID() };
      access = await createNativeGitHubAccess({ scope, target: null, cwd: root, env: {},
        resolveCredentials: async () => { throw new Error("Release must not acquire credentials"); } }, async () => ({
          env: {}, pause: () => measureWorkspaceSyncPhase("github.run_release.queue_v1", () => worker!.pause()),
          resume: async () => {}, stop: () => worker!.stop(),
        }));
      const release = await access.activate({ ...scope, runId: "github-fixture" });
      await pollStarted.promise;
      beginEndrunTiming();
      const released = measureRunPhase("github.run_release", release);
      await pollJoin.promise;
      poll.resolve([]);
      await released;
      await measureRunPhase("github.stop", access.stop);
      finishEndrunTiming(true);
    });
    const spans = exporter.getFinishedSpans();
    const tail = spans.find(span => span.name === "endrun")!;
    const byId = new Map(spans.map(span => [span.spanContext().spanId, span]));
    for (const name of ["github.run_release", "github.run_release.authority_fence", "github.run_release.queue_v1",
      "github.run_release.state_write", "github.run_release.poll_join", "github.run_release.pending_receipts",
      "github.stop", "github.stop.bridge", "github.stop.launchers"]) {
      const child = spans.find(span => span.name === name);
      expect(child, name).toBeDefined();
      let parent = child?.parentSpanContext?.spanId;
      while (parent && parent !== tail.spanContext().spanId) parent = byId.get(parent)?.parentSpanContext?.spanId;
      expect(parent, name).toBe(tail.spanContext().spanId);
    }
    expect(spans.some(span => span.name === "github.run_release.inflight_join")).toBe(false);
  } finally {
    poll.resolve([]);
    await access?.stop();
    await worker?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
