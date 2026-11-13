// Keep reason: C44 credential trust boundary; configured keys must not expand
// a subprocess allowlist. The real runnerd/Pi flow covers shell/proc behavior.
import { describe, expect, it } from "vitest";
import { piProcessEnvironment, piProxyEnvironment } from "./pi-process-environment.js";

const secrets = Object.fromEntries([
  "PAPERCLIP_AGENT_API_KEY", "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_JWT_SECRET",
  "ASCII_TOKEN",
  "PAPERCLIP_PROVIDER_TRACE_PATH", "PAPERCLIP_RUNTIME_NOTIFICATION_CONTEXT", "GH_TOKEN",
  "PAPERCLIP_GITHUB_BROKER_TOKEN", "NODE_OPTIONS", "NODE_PATH", "UNRECOGNIZED_FUTURE_SECRET",
  "PAPERCLIP_PI_FUTURE_SECRET", "OTEL_EXPORTER_OTLP_HEADERS",
].map(name => [name, `decoy-${name}`]));
const safe = { PATH: "/usr/bin:/bin", HOME: "/tmp/pi-home", TMPDIR: "/tmp", LANG: "C.UTF-8", LC_CTYPE: "C.UTF-8",
  TERM: "xterm", PI_CODING_AGENT_DIR: "/tmp/pi-agent", NODE_COMPILE_CACHE: "/tmp/pi-cache",
  PAPERCLIP_PI_BIND_SOCKET: "/tmp/bind.sock", PAPERCLIP_PI_BIND_INITIAL_FILE: "/tmp/initial.json",
  PAPERCLIP_PI_INSTRUCTIONS_FILE: "/tmp/instructions.md", PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY: "host-boundary",
  PAPERCLIP_AGENT_KEY_ID: "agent-identity-id", PAPERCLIP_AGENT_PUBLIC_KEY: "agent-public-decoy",
  PAPERCLIP_AGENT_PRIVATE_KEY: "agent-private-decoy",
  // Documented Langfuse export for Pi's observability plugin (org 11-13 00:45Z).
  LANGFUSE_BASE_URL: "https://langfuse.example", LANGFUSE_PUBLIC_KEY: "pk-decoy", LANGFUSE_SECRET_KEY: "sk-decoy",
  LANGFUSE_TRACING_ENABLED: "true" };

describe("native Pi environment ceilings", () => {
  it("filters explicit overrides AND ambient values; configured marker cannot expand either", () => {
    const source = { ...safe, ...secrets, PAPERCLIP_CONFIGURED_ENV_KEYS: JSON.stringify(Object.keys(secrets)) };
    expect(piProcessEnvironment(source, source)).toEqual(safe);
    expect(piProcessEnvironment({}, source)).toEqual(Object.fromEntries(Object.entries(safe).filter(([name]) => !name.startsWith("PAPERCLIP_") && !name.startsWith("LANGFUSE_") && name !== "PI_CODING_AGENT_DIR")));
  });
  it("retains assigned Ed25519 identity but keeps API/model authentication out of Pi", () => {
    const source = { ...safe, ...secrets, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:9/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat",
      PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "model-broker-decoy", PAPERCLIP_RUN_ID: "run-current",
      PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", PAPERCLIP_CONFIGURED_ENV_KEYS: '["ASCII_TOKEN"]' };
    const proxy = piProxyEnvironment(source);
    expect(proxy).toEqual({ ...safe, PAPERCLIP_AI_PROVIDER_URL: source.PAPERCLIP_AI_PROVIDER_URL,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "model-broker-decoy",
      PAPERCLIP_RUN_ID: "run-current", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker" });
    expect(piProcessEnvironment(proxy, {})).toEqual(safe);
  });
});
