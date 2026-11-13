/** Pi and its shell tools are not the Runner's credential authority. Keep this
 * ceiling explicit: neither configured-env markers nor a new runner variable
 * may silently expand it. NODE_OPTIONS/NODE_PATH are deliberately excluded.
 */
const BASE_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "TZ",
  "TERM", "COLORTERM", "SystemRoot", "WINDIR", "PATHEXT",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Kept from the previous Pi env ceiling: outbound proxy routing for Pi's
  // own model/tool traffic where a host requires it.
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE",
]);
/** Exact names only. Never replace this with LANGFUSE_* / PAPERCLIP_* prefix
 * inheritance.
 */
export const PI_PROCESS_ENVIRONMENT_KEYS = [
  ...BASE_KEYS,
  "PI_CODING_AGENT_DIR", "PI_OFFLINE", "AGENT_HOME", "PAPERCLIP_PI_AGENT_HOME",
  // Persistent Ed25519 identity is intentionally agent-readable; not API auth.
  "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY",
  "PAPERCLIP_PI_BIND_SOCKET", "PAPERCLIP_PI_BIND_INITIAL", "PAPERCLIP_PI_BIND_INITIAL_FILE",
  "PAPERCLIP_PI_INSTRUCTIONS_FILE", "PAPERCLIP_PI_INSTRUCTIONS_BOUNDARY",
  // Langfuse export for Pi's observability plugin, as Paperclip documents it:
  // doc/architecture/runner-pi-capabilities.md:72-76 and :108-111 ("Supply any
  // Langfuse export credentials through the existing configured secret
  // environment"). Org ruling 11-13 00:45Z: these stay in Pi's environment.
  "LANGFUSE_BASE_URL", "LANGFUSE_HOST", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
  "LANGFUSE_USER_ID", "LANGFUSE_TRACING_ENABLED", "LANGFUSE_TRACING_ENVIRONMENT", "LANGFUSE_RELEASE", "PI_LANGFUSE_DEBUG",
  // Assigned-MCP's existing run-scoped capability, NOT an agent API bearer.
  "PAPERCLIP_NATIVE_MCP_NAME", "PAPERCLIP_NATIVE_MCP_URL", "PAPERCLIP_NATIVE_MCP_TOKEN",
] as const;
const PI_KEYS = new Set<string>(PI_PROCESS_ENVIRONMENT_KEYS);
const PROXY_KEYS = new Set([
  ...PI_KEYS, "PAPERCLIP_PI_RUNTIME_DIR", "PAPERCLIP_PI_THINKING_LEVEL", "PAPERCLIP_PI_RPC_CREDENTIAL_MODE",
  "PAPERCLIP_RUNNER_INSTANCE_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_NORMALIZED_SESSION_ID",
  "PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH",
  // Only the host broker receives upstream routing/authentication. Never Pi.
  "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_AI_PROVIDER_PROTOCOL", "PAPERCLIP_AI_PROVIDER_AUTH", "PAPERCLIP_AI_PROVIDER_KEY",
]);
const baseKey = (key: string) => BASE_KEYS.has(key) || /^LC_[A-Z0-9_]{1,32}$/.test(key);

function select(source: NodeJS.ProcessEnv, keys: ReadonlySet<string>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && (baseKey(key) || keys.has(key))));
}

/** The last operation before PiRpcTransport.spawn. No arbitrary overrides. */
export function piProcessEnvironment(overrides: NodeJS.ProcessEnv = {}, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...select(ambient, new Set()), ...select(overrides, PI_KEYS) };
}

/** Controller -> native Pi proxy boundary. */
export function piProxyEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return select(source, PROXY_KEYS);
}
