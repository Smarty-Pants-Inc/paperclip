import type { Db } from "@paperclipai/db";

const TTL_MS = 60_000;
const MAX_ENTRIES = 1024;
type Entry = { revision: string; expiresAt: number; value: Promise<string> };
const caches = new WeakMap<Db, Map<string, Entry>>();

/** Cache only the resolved provider credential, never a prepared run/custom image. */
export function resolveCachedEnvironmentProviderSecret(input: {
  db: Db;
  key: string;
  revision: string;
  resolve: () => Promise<string>;
}): Promise<string> {
  let cache = caches.get(input.db);
  if (!cache) { cache = new Map(); caches.set(input.db, cache); }
  const now = Date.now();
  const found = cache.get(input.key);
  if (found && found.revision === input.revision && found.expiresAt > now) return found.value;
  if (cache.size >= MAX_ENTRIES) {
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  const entry: Entry = { revision: input.revision, expiresAt: now + TTL_MS, value: Promise.resolve().then(input.resolve) };
  cache.set(input.key, entry);
  // A stale failed fill must never evict a newer rotation/config revision.
  void entry.value.catch(() => { if (cache.get(input.key) === entry) cache.delete(input.key); });
  return entry.value;
}
