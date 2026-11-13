import { execFileSync } from 'node:child_process';
import { githubBrokerEnvironment } from '@paperclipai/adapter-utils/github-launcher';
import { CONFIGURED_ENVIRONMENT_KEYS, configuredEnvironment, configuredEnvironmentProjection } from './configured-environment.js';
import { describe, expect, it, vi } from 'vitest';
import { createSanitizedCodexEnvironment } from './drivers/codex/app-server-transport.js';
import { createIsolatedCodexAppServerArgs } from './drivers/codex/codex-security-config.js';
import { createCapabilityRunnerdProviderEnvironment } from './live/runnerd-codex-transport.js';
import { spawnRunner } from './control-plane/durable-prp-control-plane.js';
import { PI_LANGFUSE_ENVIRONMENT_KEYS, piProcessEnvironment, piProxyEnvironment } from './drivers/pi/pi-process-environment.js';

const pages = {
  PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID: 'fake-page-access-key',
  PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY: 'fake-page-secret',
  PAPERCLIP_PAGE_BUCKET: 'pages.example.test',
};
const source = { ...configuredEnvironmentProjection(pages), PATH: '/bin', ...pages, DATABASE_URL: 'host-secret-must-not-cross', NODE_OPTIONS: '--require=/untrusted/bootstrap.js', PAPERCLIP_API_KEY: 'controller-api-key-must-not-cross' };
const identity = { runnerInstanceId: 'runner-proof', environmentLeaseId: 'lease-proof', runId: 'run-proof', normalizedSessionId: 'session-proof', turnId: 'turn-proof', itemId: 'item-proof' };
function shellKeys() {
  const args = createIsolatedCodexAppServerArgs(source);
  const setting = args.find(value => value.startsWith('shell_environment_policy.include_only='))!;
  return { keys: JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string[], serialized: args.join('\n') };
}

describe('controller-configured environment across native runner boundaries', () => {
  // Keep reason: merged native Pi Git filtering must not erase managed credential isolation.
  it('keeps managed Git isolation through native Pi launch when the broker clears configured safe pairs', () => {
    const source = githubBrokerEnvironment({ PATH: '/bin', ...configuredEnvironmentProjection({ LANGFUSE_FLUSH_AT: '1' }),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/work/project',
      GH_TOKEN: 'raw-gh-decoy', GITHUB_TOKEN: 'raw-github-decoy',
    }, { url: 'http://127.0.0.1:43210', token: 'run-broker-capability' });
    expect(source).toMatchObject({ GIT_CONFIG_COUNT: '', GIT_CONFIG_KEY_0: '', GIT_CONFIG_VALUE_0: '' });
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: 'connect', connectUrl: 'ws://127.0.0.1:43127' }, stateDirectory: '/tmp/pi-combined-env-proof', identity, ticket: 'fake-ticket', maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: '0.3.0', runnerDigest: `sha256:${'a'.repeat(64)}`, environment: source,
      piLaunchProfile: { command: '/isolated/node', commandSha256: `sha256:${'b'.repeat(64)}`, proxyScript: '/isolated/pi-proxy.cjs', proxyScriptSha256: `sha256:${'c'.repeat(64)}`, executable: '/isolated/pi.js', executableSha256: `sha256:${'d'.repeat(64)}` },
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }) }; },
    });
    const pi = piProcessEnvironment(piProxyEnvironment(launched!), {});
    expect(pi).toMatchObject({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_AUTH_SOCK: '', LANGFUSE_FLUSH_AT: '1',
      PAPERCLIP_GITHUB_BROKER_URL: 'http://127.0.0.1:43210', PAPERCLIP_GITHUB_BROKER_TOKEN: 'run-broker-capability' });
    for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GH_TOKEN', 'GITHUB_TOKEN']) expect(pi).not.toHaveProperty(name);
  });
  // Keep reason: actual native Pi launch trust boundary, not just the final filter.
  it.each([2, 33])('carries %s safe Git pairs from the native provider builder through runner spawn to real Git', (count) => {
    const pairs = [['http.https://github.com/.extraheader', 'Authorization: decoy'], ['safe.directory', '/work/project'],
      ...Array.from({ length: count - 1 }, () => ['user.name', 'Pi Test'])];
    const source = { PATH: '/bin', ...configuredEnvironmentProjection({ LANGFUSE_FLUSH_AT: '1' }), GH_TOKEN: 'decoy',
      GIT_CONFIG_COUNT: String(pairs.length), ...Object.fromEntries(pairs.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
      ])) };
    const environment = createCapabilityRunnerdProviderEnvironment({ provider: 'pi_rpc', options: { environment: source }, identity, codexHome: '/isolated/pi-home', runtimeContextPath: '/isolated/runtime-context.json', hasRuntimeContext: false });
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: 'connect', connectUrl: 'ws://127.0.0.1:43127' }, stateDirectory: '/tmp/pi-git-env-proof', identity, ticket: 'fake-ticket', maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: '0.3.0', runnerDigest: `sha256:${'a'.repeat(64)}`, environment,
      piLaunchProfile: { command: '/isolated/node', commandSha256: `sha256:${'b'.repeat(64)}`, proxyScript: '/isolated/pi-proxy.cjs', proxyScriptSha256: `sha256:${'c'.repeat(64)}`, executable: '/isolated/pi.js', executableSha256: `sha256:${'d'.repeat(64)}` },
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }) }; },
    });
    const pi = piProcessEnvironment(launched, {});
    expect(pi).toMatchObject({ GIT_CONFIG_COUNT: String(count), GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/work/project',
      GIT_CONFIG_KEY_1: 'user.name', GIT_CONFIG_VALUE_1: 'Pi Test', LANGFUSE_FLUSH_AT: '1' });
    expect(pi).not.toHaveProperty(`GIT_CONFIG_KEY_${count}`);
    expect(pi).not.toHaveProperty('GH_TOKEN');
    expect(Object.values(pi)).not.toContain('Authorization: decoy');
    expect(execFileSync('git', ['config', '--get-all', 'safe.directory'], {
      env: { ...pi, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8',
    })).toBe('/work/project\n');
  });
  it('carries exactly configured Pi Langfuse export names through the controller and runner spawn', () => {
    const allowed = Object.fromEntries(PI_LANGFUSE_ENVIRONMENT_KEYS.map(name => [name, `configured-${name}`]));
    const source = { PATH: '/bin', ...configuredEnvironmentProjection({ ...allowed, LANGFUSE_UNLISTED_SECRET: 'must-drop', ASCII_TOKEN: 'must-drop', CUSTOM_FLAG: 'must-drop' }) };
    const environment = createCapabilityRunnerdProviderEnvironment({ provider: 'pi_rpc', options: { environment: source }, identity, codexHome: '/isolated/pi-home', runtimeContextPath: '/isolated/runtime-context.json', hasRuntimeContext: false });
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: 'connect', connectUrl: 'ws://127.0.0.1:43127' }, stateDirectory: '/tmp/pi-langfuse-env-proof', identity, ticket: 'fake-ticket', maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: '0.3.0', runnerDigest: `sha256:${'a'.repeat(64)}`, environment,
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }) }; },
    });
    expect(launched).toMatchObject(allowed);
    for (const name of [CONFIGURED_ENVIRONMENT_KEYS, 'LANGFUSE_UNLISTED_SECRET', 'ASCII_TOKEN', 'CUSTOM_FLAG']) expect(launched).not.toHaveProperty(name);
  });
  it('retains configured Pages values at the native Codex provider sanitizer', () => {
    expect(createSanitizedCodexEnvironment(source)).toMatchObject(pages);
  });
  it('retains configured Pages values when preparing a fresh runnerd process', () => {
    expect(createCapabilityRunnerdProviderEnvironment({ provider: 'codex', options: { environment: source }, identity, codexHome: '/isolated/codex-home', runtimeContextPath: '/isolated/runtime-context.json', hasRuntimeContext: false })).toMatchObject(pages);
  });
  it('passes configured Pages values through the runner spawn boundary', () => {
    let launched: NodeJS.ProcessEnv | undefined;
    spawnRunner({ connection: { mode: 'connect', connectUrl: 'ws://127.0.0.1:43127' }, stateDirectory: '/tmp/runner-env-proof', identity, ticket: 'fake-ticket', maxOutboxBytes: 262144, p0ReserveBytes: 65536, runnerVersion: '0.3.0', runnerDigest: `sha256:${'a'.repeat(64)}`, environment: { ...source, OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'authorization=Bearer%20export-canary', OTEL_LOGS_EXPORTER: 'otlp' },
      processLauncher: spec => { launched = spec.environment; return { child: { pid: 42, exitCode: null, signalCode: null, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' }) }; },
    });
    expect(launched).toMatchObject({ ...pages, OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'authorization=Bearer%20export-canary', OTEL_LOGS_EXPORTER: 'otlp' });
    expect(launched!.PAPERCLIP_CONFIGURED_ENV_KEYS).not.toContain('OTEL_');
    expect(launched!.DATABASE_URL).toBeUndefined();
    expect(launched!.NODE_OPTIONS).toBeUndefined();
    expect(launched!.PAPERCLIP_API_KEY).toBeUndefined();
  });
  it('allows configured Pages values into model-issued shell commands without serializing secrets into argv', () => {
    const { keys, serialized } = shellKeys();
    expect(keys).toEqual(expect.arrayContaining(Object.keys(pages)));
    expect(keys).not.toContain('DATABASE_URL');
    expect(keys).not.toContain('NODE_OPTIONS');
    expect(keys).not.toContain('PAPERCLIP_API_KEY');
    for (const value of Object.values(pages)) expect(serialized).not.toContain(value);
  });
  it('continues to exclude unbound ambient Pages credentials and host secrets', () => {
    vi.stubEnv('PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY', 'ambient-page-secret');
    try {
      expect(createSanitizedCodexEnvironment().PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY).toBeUndefined();
      const sanitized = createSanitizedCodexEnvironment(source);
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.NODE_OPTIONS).toBeUndefined();
      expect(sanitized.PAPERCLIP_API_KEY).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});


describe("configured environment authority", () => {
  it("keeps selected bootstrap values in the environment rather than argv", () => {
    const environment = { PATH: "/bin", ...configuredEnvironmentProjection({ LANG: "configured-language-value" }) };
    const args = createIsolatedCodexAppServerArgs(environment);
    expect(args.join("\n")).not.toContain("configured-language-value");
    expect(args.find(arg => arg.startsWith("shell_environment_policy.include_only="))).toContain("LANG");
  });

  it("projects ordinary task credentials only when explicitly selected", () => {
    const projected = configuredEnvironmentProjection({ DATABASE_URL: "task-db", CUSTOM_FLAG: "on", NODE_OPTIONS: "unsafe", PAPERCLIP_API_KEY: "controller" });
    expect(createSanitizedCodexEnvironment(projected)).toMatchObject({ DATABASE_URL: "task-db", CUSTOM_FLAG: "on" });
    expect(projected.NODE_OPTIONS).toBeUndefined();
    expect(projected.PAPERCLIP_API_KEY).toBeUndefined();
  });

  it.each([
    "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL",
    "PAPERCLIP_AI_PROVIDER_PROTOCOL", "PAPERCLIP_AI_PROVIDER_AUTH",
    "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE",
  ])("reserves launch policy value %s for the runner instead of task children", name => {
    for (const key of [name, name.toLowerCase()]) {
      const projected = configuredEnvironmentProjection({ [key]: "route-fixture", CUSTOM_FLAG: "allowed" });
      expect(projected).not.toHaveProperty(key);
      expect(JSON.parse(projected[CONFIGURED_ENVIRONMENT_KEYS]!)).toEqual(["CUSTOM_FLAG"]);
      expect(() => configuredEnvironment({ [key]: "route-fixture", [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify([key]) }))
        .toThrow("Invalid configured environment projection");
    }
  });

  it("reserves Kimi credentials for the selected provider instead of the generic task projection", async () => {
    const { createSanitizedAcpxSpawnInput } = await import("./drivers/acpx/environment.js");
    const projected = configuredEnvironmentProjection({ KIMI_API_KEY: "selected-kimi-secret", CUSTOM_FLAG: "allowed" });
    expect(projected.KIMI_API_KEY).toBeUndefined();
    expect(JSON.parse(projected[CONFIGURED_ENVIRONMENT_KEYS]!)).toEqual(["CUSTOM_FLAG"]);
    expect(() => configuredEnvironment({ [CONFIGURED_ENVIRONMENT_KEYS]: '["KIMI_API_KEY"]', KIMI_API_KEY: "selected-kimi-secret" }))
      .toThrow("Invalid configured environment projection");
    const selected = { ...projected, KIMI_API_KEY: "selected-kimi-secret" };
    expect(createSanitizedCodexEnvironment(selected).KIMI_API_KEY).toBeUndefined();
    for (const agent of ["claude", "codex", "grok", "cursor", "copilot"] as const) {
      expect(createSanitizedAcpxSpawnInput(selected, agent).env.KIMI_API_KEY).toBeUndefined();
    }
    expect(createSanitizedAcpxSpawnInput(selected, "kimi").env).toMatchObject({ KIMI_API_KEY: "selected-kimi-secret", CUSTOM_FLAG: "allowed" });
    // Pi already supports this credential through its explicit SDK allowlist.
    expect(createSanitizedAcpxSpawnInput(selected, "pi").env.KIMI_API_KEY).toBe("selected-kimi-secret");
  });

  it("does not accept an ambient projection in the provider or shell policy", () => {
    vi.stubEnv(CONFIGURED_ENVIRONMENT_KEYS, JSON.stringify(["PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY"]));
    vi.stubEnv("PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY", "ambient-secret");
    try {
      expect(createSanitizedCodexEnvironment().PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(createIsolatedCodexAppServerArgs().join("\n")).not.toContain("PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["not-json", "[1]", '["NODE_OPTIONS"]', '["PAPERCLIP_API_KEY"]', '["PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"]', '["OPENAI_API_KEY"]', '["KIMI_API_KEY"]', '["LD_PRELOAD"]', '["bad=name"]', '["CUSTOM","CUSTOM"]', '["MISSING"]'])
    ("rejects malformed or reserved projection %s", raw => {
      expect(() => configuredEnvironment({ [CONFIGURED_ENVIRONMENT_KEYS]: raw })).toThrow("Invalid configured environment");
    });

  it("rejects oversized and null-containing values without reporting their contents", () => {
    for (const value of ["x".repeat(65_536), "secret\0suffix"]) {
      expect(() => configuredEnvironmentProjection({ CUSTOM: value })).toThrow(/configured environment|Configured environment/);
    }
  });

  it("preserves configured values through ACPX and OpenCode preparation", async () => {
    const { createSanitizedAcpxSpawnInput } = await import("./drivers/acpx/environment.js");
    expect(createSanitizedAcpxSpawnInput(source, "codex").env).toMatchObject(pages);
    expect(createCapabilityRunnerdProviderEnvironment({ provider: "opencode", options: { environment: source }, identity, codexHome: "/isolated/home", runtimeContextPath: "/isolated/context", hasRuntimeContext: false })).toMatchObject(pages);
  });

  it("does not inherit an ambient GitHub broker into OpenCode", () => {
    vi.stubEnv("PAPERCLIP_GITHUB_BROKER_TOKEN", "ambient-capability");
    vi.stubEnv("PAPERCLIP_GITHUB_BROKER_URL", "http://ambient.invalid");
    vi.stubEnv("GH_TOKEN", "ambient-github-token");
    try {
      for (const environment of [undefined, {}]) {
        const prepared = createCapabilityRunnerdProviderEnvironment({
          provider: "opencode", options: { environment }, identity,
          codexHome: "/isolated/home", runtimeContextPath: "/isolated/context", hasRuntimeContext: false,
        });
        expect(prepared.PAPERCLIP_GITHUB_BROKER_TOKEN).toBeUndefined();
        expect(prepared.PAPERCLIP_GITHUB_BROKER_URL).toBeUndefined();
        expect(prepared.GH_TOKEN).toBeUndefined();
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

// Trust boundary: controller-assigned native Pi launch policy cannot be replaced by task config.
it.each(["PAPERCLIP_PI_THINKING_LEVEL", "PAPERCLIP_PI_RUNTIME_DIR", "PI_CODING_AGENT_DIR"])("protects generated native Pi setting %s", name => {
  expect(configuredEnvironmentProjection({ [name]: "untrusted" })).not.toHaveProperty(name);
  expect(() => configuredEnvironment({ [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify([name]), [name]: "untrusted" })).toThrow();
});
