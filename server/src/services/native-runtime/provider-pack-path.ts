import { isAbsolute } from "node:path";

/**
 * Smarty seam (11-28): the provider pack an environment's runs use.
 * PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH_BY_ENVIRONMENT maps environment ids to pack paths
 * ({"<environment id>": "/srv/provider-pack/p124"}). An environment not in it keeps the server's
 * PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH, so a new pack can serve new environments while
 * every existing environment (and its conversations) keeps the pack it has.
 */
export function providerPackPathForEnvironment(
  environmentId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH_BY_ENVIRONMENT?.trim();
  if (raw) {
    let map: unknown;
    try { map = JSON.parse(raw); } catch { map = null; }
    if (!map || typeof map !== "object" || Array.isArray(map)
      || Object.values(map).some(path => typeof path !== "string" || !path.trim() || !isAbsolute(path.trim()))) {
      throw new Error("PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH_BY_ENVIRONMENT must map environment ids to absolute pack paths");
    }
    const path = environmentId && Object.hasOwn(map, environmentId) ? (map as Record<string, string>)[environmentId] : undefined;
    if (path) return path.trim();
  }
  return env.PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH?.trim() || undefined;
}
