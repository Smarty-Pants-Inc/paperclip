import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCachedEnvironmentProviderSecret } from "../services/environment-provider-secret-cache.js";

describe("environment provider credential cache", () => {
  afterEach(() => vi.useRealTimers());
  it("coalesces 100 calls and expires after 60 seconds without a background refresh", async () => {
    vi.useFakeTimers();
    const db = {} as Db;
    const resolve = vi.fn(async () => "synthetic-key");
    const input = { db, key: "company/environment/apiKey", revision: "v1", resolve };
    await Promise.all(Array.from({ length: 100 }, () => resolveCachedEnvironmentProviderSecret(input)));
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    await resolveCachedEnvironmentProviderSecret(input);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    await resolveCachedEnvironmentProviderSecret(input);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("isolates DB/company/environment/path keys and immediately replaces revised credentials", async () => {
    const db = {} as Db;
    const resolve = vi.fn(async () => "key-v1");
    const input = { db, key: "company-a/env-a/apiKey", revision: "v1", resolve };
    await resolveCachedEnvironmentProviderSecret(input);
    await resolveCachedEnvironmentProviderSecret({ ...input, key: "company-b/env-a/apiKey" });
    await resolveCachedEnvironmentProviderSecret({ ...input, key: "company-a/env-b/apiKey" });
    await resolveCachedEnvironmentProviderSecret({ ...input, db: {} as Db });
    expect(resolve).toHaveBeenCalledTimes(4);
    const rotated = vi.fn(async () => "key-v2");
    expect(await resolveCachedEnvironmentProviderSecret({ ...input, revision: "v2", resolve: rotated })).toBe("key-v2");
    expect(await resolveCachedEnvironmentProviderSecret({ ...input, revision: "v2", resolve: rotated })).toBe("key-v2");
    expect(rotated).toHaveBeenCalledTimes(1);
  });
  it("does not cache failures and a stale failed fill cannot remove a newer rotation", async () => {
    const db = {} as Db;
    let reject!: (error: Error) => void;
    const first = resolveCachedEnvironmentProviderSecret({ db, key: "env", revision: "v1", resolve: () => new Promise<string>((_, fail) => { reject = fail; }) });
    await Promise.resolve();
    const next = { db, key: "env", revision: "v2", resolve: vi.fn(async () => "rotated") };
    expect(await resolveCachedEnvironmentProviderSecret(next)).toBe("rotated");
    reject(new Error("old failed"));
    await expect(first).rejects.toThrow("old failed");
    expect(await resolveCachedEnvironmentProviderSecret(next)).toBe("rotated");
    expect(next.resolve).toHaveBeenCalledTimes(1);
    const failure = vi.fn(async (): Promise<string> => { throw new Error("unavailable"); });
    await expect(resolveCachedEnvironmentProviderSecret({ ...next, key: "failure", resolve: failure })).rejects.toThrow();
    await expect(resolveCachedEnvironmentProviderSecret({ ...next, key: "failure", resolve: failure })).rejects.toThrow();
    expect(failure).toHaveBeenCalledTimes(2);
  });
});
