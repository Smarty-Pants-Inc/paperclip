import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpxRuntimeHost, type AcpxRuntimeHostDependencies, type AcpxRuntimePort } from "./runtime-host.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const model = "paperclip/vendor/model";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-loopback-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "workspace"), runtimeDirectory = join(root, "runtime");
  await mkdir(workingDirectory); await mkdir(runtimeDirectory);
  const options = { agent: "pi" as const, model, piThinkingLevel: "low" as const, permissionMode: "approve-reads" as const,
    providerPolicy: { readOnly: false }, normalizedSessionId: "managed-pi", runtimeDirectory, workingDirectory,
    environment: { PATH: process.env.PATH, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "api_key", PAPERCLIP_AI_PROVIDER_KEY: "provider-key-canary" } };
  const runtime: AcpxRuntimePort = {
    identity: async () => ({ acpxRecordId: "record", backendSessionId: "backend", agentSessionId: "session", piThinkingLevel: "low" }),
    getStatus: async () => ({ models: { currentModelId: model } }),
    startTurn: () => { throw new Error("No turn needed for provider lifetime test"); },
    close: vi.fn(async () => {}),
  };
  const dependencies: AcpxRuntimeHostDependencies = {
    verifyInstallation: async profile => ({ commandDigest: profile.commandDigest, agentServerPackageJsonPath: join(root, "package.json"), agentRuntimePackageJsonPath: null,
      openCommand: async () => ({ spawn: () => { throw new Error("No native process in lifetime test"); }, close: async () => {} }) }),
    openRuntime: async () => runtime,
    reportRetainedCleanupFailure: failure => { throw new Error(`Unexpected cleanup failure: ${failure.resource}`); },
  };
  return { options, dependencies, runtime };
}

describe("Pi loopback provider lifetime", () => {
  it.each(["messages", "responses"])("reuses one Pi session and broker across two turns, replacing only the capability after credential retirement (%s)", async protocol => {
    // Trust-boundary regression: exercise the real host, private configuration,
    // and HTTP broker; only the native harness port is substituted.
    const test = await fixture();
    const upstreamKeys: Array<string | undefined> = [];
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain the real broker request */ }
      upstreamKeys.push((protocol === "messages" ? request.headers["x-api-key"] : request.headers.authorization) as string | undefined);
      response.end("{}");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    cleanups.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream listener");
    const routeEnvironment = {
      ...test.options.environment,
      PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}${protocol === "responses" ? "/v1" : ""}`,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol,
    };
    type Provider = { baseUrl: string; apiKey: string; api: string };
    const turns: Array<{ sessionId: string; home: string; provider: Provider }> = [];
    const openRuntime = vi.fn<AcpxRuntimeHostDependencies["openRuntime"]>(async launch => {
      const sessionId = randomUUID();
      const home = launch.launchEnvironment.PI_CODING_AGENT_DIR!;
      const readProvider = async (): Promise<Provider> => JSON.parse(await readFile(join(home, "models.json"), "utf8")).providers.paperclip;
      await readProvider();
      return {
        identity: async () => ({ acpxRecordId: `record-${sessionId}`, backendSessionId: sessionId, agentSessionId: sessionId, piThinkingLevel: "low" }),
        getStatus: async () => ({ models: { currentModelId: model } }),
        startTurn: input => ({
          requestId: input.requestId, promptStarted: Promise.resolve(),
          events: (async function* () {})(),
          result: (async () => {
            const provider = await readProvider();
            expect(provider, "managed Pi must have a session-scoped paperclip provider").toBeDefined();
            expect(provider.api).toBe(protocol === "messages" ? "anthropic-messages" : "openai-responses");
            turns.push({ sessionId, home, provider });
            const response = await fetch(`${provider.baseUrl}${protocol === "messages" ? "/v1/messages" : "/responses"}`, {
              method: "POST", headers: protocol === "messages" ? { "x-api-key": provider.apiKey } : { Authorization: `Bearer ${provider.apiKey}` },
              body: JSON.stringify({ model: "vendor/model", messages: [], input: input.text }),
            });
            expect(response.status).toBe(200);
            await response.text();
            return { status: "completed" as const, stopReason: "end_turn" };
          })(),
          cancel: async () => {}, closeStream: async () => {},
        }),
        close: async () => {},
      };
    });
    test.dependencies.openRuntime = openRuntime;
    const host = await AcpxRuntimeHost.open({ ...test.options, environment: routeEnvironment }, test.dependencies);
    cleanups.push(() => host.close({ reason: "test cleanup" }));
    for (const requestId of ["first-turn", "second-turn"]) {
      await expect(host.startTurn({ requestId, text: requestId }).result).resolves.toMatchObject({ status: "completed" });
      expect(host.identity().agentSessionId).toBe(turns.at(-1)!.sessionId);
    }
    expect(openRuntime).toHaveBeenCalledOnce();
    expect(turns[1]).toEqual(turns[0]);
    // The owning Runner retires the session on a credential change. Closing
    // that host must revoke the old broker before the replacement is admitted.
    await host.close({ reason: "managed credential changed" });
    await expect(fetch(`${turns[0]!.provider.baseUrl}/v1/messages`)).rejects.toThrow();
    const replacementKey = "replacement-provider-key-canary";
    const replacement = await AcpxRuntimeHost.open({ ...test.options, environment: { ...routeEnvironment, PAPERCLIP_AI_PROVIDER_KEY: replacementKey } }, test.dependencies);
    cleanups.push(() => replacement.close({ reason: "test cleanup" }));
    await replacement.startTurn({ requestId: "replacement-turn", text: "after rotation" }).result;
    expect(turns[2]!.home).toBe(turns[0]!.home);
    expect(turns[2]!.provider.apiKey).not.toBe(turns[0]!.provider.apiKey);
    expect(openRuntime).toHaveBeenCalledTimes(2);
    const authorization = (key: string) => protocol === "messages" ? key : `Bearer ${key}`;
    expect(upstreamKeys).toEqual([authorization(routeEnvironment.PAPERCLIP_AI_PROVIDER_KEY), authorization(routeEnvironment.PAPERCLIP_AI_PROVIDER_KEY), authorization(replacementKey)]);
  });

  it.each([false, true])("revokes the broker when admission ends (startup failure: %s)", async startupFailure => {
    const test = await fixture();
    let provider: { baseUrl: string; apiKey: string } | undefined;
    const sensitive: string[] = [];
    test.dependencies.openRuntime = async launch => {
      expect(Object.keys(launch.launchEnvironment).filter(name => name.startsWith("PAPERCLIP_AI_PROVIDER_"))).toEqual([]);
      const config = JSON.parse(await readFile(join(launch.launchEnvironment.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
      provider = config.providers.paperclip;
      expect((await fetch(`${provider!.baseUrl}/v1/messages`)).status).toBe(401);
      if (startupFailure) throw new Error("native startup failed");
      return test.runtime;
    };
    const opening = AcpxRuntimeHost.open({ ...test.options, onSensitiveValues: values => sensitive.push(...values) }, test.dependencies);
    if (startupFailure) await expect(opening).rejects.toThrow("native startup failed");
    else {
      const host = await opening;
      cleanups.push(() => host.close({ reason: "test cleanup" }));
      await host.close({ reason: "session finished" });
      expect(test.runtime.close).toHaveBeenCalledOnce();
    }
    expect(provider).toBeDefined();
    expect(sensitive).toContain(provider!.apiKey);
    await expect(fetch(`${provider!.baseUrl}/v1/messages`)).rejects.toThrow();
  });

  it("retains a cancelled configuration write until it settles, then revokes its broker", async () => {
    const test = await fixture();
    const controller = new AbortController();
    let started!: () => void, finish!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const pendingWrite = new Promise<void>(resolve => { finish = resolve; });
    const retained: Promise<void>[] = [];
    let baseUrl = "";
    test.dependencies.retainAdmissionCleanup = cleanup => { retained.push(cleanup); };
    test.dependencies.prepareSandbox = async input => {
      const sandbox = await prepareAcpxRuntimeSandbox(input);
      return { ...sandbox, initializeOwnedConfiguration: async () => {
        await sandbox.initializeOwnedConfiguration?.();
        baseUrl = JSON.parse(await readFile(join(sandbox.agentHomeDirectory, "models.json"), "utf8")).providers.paperclip.baseUrl;
        started();
        await pendingWrite;
      } };
    };
    const openRuntime = vi.fn(test.dependencies.openRuntime);
    test.dependencies.openRuntime = openRuntime;
    const opening = AcpxRuntimeHost.open({ ...test.options, signal: controller.signal }, test.dependencies);
    const rejected = expect(opening).rejects.toThrow("cancel managed startup");
    try {
      await writing;
      controller.abort(new Error("cancel managed startup"));
      await rejected;
      expect(openRuntime).not.toHaveBeenCalled();
      expect((await fetch(`${baseUrl}/v1/messages`)).status).toBe(401);
    } finally {
      finish();
      await rejected;
      await Promise.all(retained);
    }
    await expect(fetch(`${baseUrl}/v1/messages`)).rejects.toThrow();
  });
});
