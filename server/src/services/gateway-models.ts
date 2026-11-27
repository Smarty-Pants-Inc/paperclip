import { logger } from "../middleware/logger.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 3_000;
const MAX_CACHED_GATEWAYS = 128;
const catalogs = new Map<string, { until: number; models: Promise<ReadonlySet<string> | null> }>();

/** A connection's configured gateway is authoritative, not its saved model hints.
 * Null means unavailable: callers must preserve fail-open PATCH behavior.
 * Cache failures too, so an outage neither delays every save nor floods logs.
 */
export async function listGatewayModels(
  baseUrl: string,
  headers: () => Promise<Record<string, string>>,
): Promise<ReadonlySet<string> | null> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/models`;
  const cached = catalogs.get(url);
  if (cached && cached.until > Date.now()) return cached.models;
  for (const [key, entry] of catalogs) if (entry.until <= Date.now()) catalogs.delete(key);
  if (catalogs.size >= MAX_CACHED_GATEWAYS) catalogs.delete(catalogs.keys().next().value!);
  const entry = { until: Date.now() + CATALOG_TTL_MS, models: (async () => {
    try {
      const requestHeaders = await headers();
      const response = await guardedRemoteHttpFetch(url, {
        method: "GET", headers: requestHeaders, redirect: "error", signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      }, {
        // This URL comes only from the operator-managed connection, never an
        // issue/agent model or env override. Internal gateways are supported;
        // the existing transport still denies link-local and pins DNS peers.
        allowPrivateNetwork: true, dnsTimeoutMs: CATALOG_TIMEOUT_MS,
        connectTimeoutMs: CATALOG_TIMEOUT_MS, responseTimeoutMs: CATALOG_TIMEOUT_MS,
        error: () => new Error("Gateway model catalog unavailable"),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Gateway model catalog unavailable");
      }
      const body: unknown = await response.json();
      const data = body && typeof body === "object" && "data" in body ? body.data : undefined;
      if (!Array.isArray(data) || data.some(model => !model || typeof model.id !== "string" || !model.id.trim())) {
        throw new Error("Invalid gateway model catalog");
      }
      return new Set<string>(data.map(model => model.id));
    } catch {
      // Do not log URLs, headers, raw provider responses or credential errors.
      logger.warn({ code: "pi_gateway_models_unavailable" }, "Pi gateway model list unavailable; accepting model selection without catalog validation");
      return null;
    }
  })() };
  catalogs.set(url, entry);
  return entry.models;
}
