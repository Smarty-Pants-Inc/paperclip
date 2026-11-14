import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";

const binary = process.env.PI_TEST_BINARY;
it.skipIf(!binary).each(["os", "runtime"] as const)("measures five cold/seeded and warm Pi admissions from a fully warmed legacy %s image cache", async location => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-cache-startup-")));
  const hostTmp = join(root, "tmp"), home = join(root, "agent"), runtime = join(root, "runtime");
  const legacy = join(location === "runtime" ? runtime : hostTmp, "node-compile-cache"), image = join(root, "image-seed");
  const cache = join(hostTmp, `paperclip-pi-cache-${process.getuid!()}`, "node-compile-cache");
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[2]!;
  const inventory = (directory: string) => {
    const files: Record<string, string> = {};
    try { for (const name of readdirSync(directory, { recursive: true })) {
      const path = join(directory, name); if (lstatSync(path).isFile()) files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
    } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return files;
  };
  try {
    for (const path of [hostTmp, runtime, join(home, "extensions")]) await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(home, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused", models: [{ id: "faux" }] } } }));
    await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [], cacheWarming: "off", defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } }));
    const probe = join(root, "native.json");
    await writeFile(join(home, "extensions", "cache-probe.ts"), `import {getCompileCacheDir,flushCompileCache} from 'node:module'; import {writeFileSync} from 'node:fs'; export default function(pi){pi.on('session_start',()=>{flushCompileCache();writeFileSync(${JSON.stringify(probe)},JSON.stringify({cache:process.env.NODE_COMPILE_CACHE,directory:getCompileCacheDir()}));});}\n`);
    vi.stubEnv("TMPDIR", hostTmp); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "not-operator-home"));
    const startup = async (index: string) => {
      let before: Record<string, string> = {};
      const started = performance.now();
      const session = await new PiRpcDriver({ command: binary!, model: "local/faux", piRpcThinkingLevel: "off", runtimeDirectory: runtime, shutdownTimeoutMs: 1000,
        environment: { HOME: root, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", OTEL_SDK_DISABLED: "true" },
        transportFactory: options => { before = inventory(cache); return new PiRpcTransport(options); },
      }).openSession({ runId: index, normalizedSessionId: index, workingDirectory: root });
      const elapsedMs = performance.now() - started;
      try { return { elapsedMs, before, observed: JSON.parse(await readFile(probe, "utf8")) }; } finally { await session.close(); }
    };
    await startup("image-warmup"); await cp(cache, image, { recursive: true });
    const source = inventory(image); expect(Object.keys(source).length).toBeGreaterThan(24);
    const first: number[] = [], warm: number[] = [], samples: unknown[] = [];
    let allSeeded = true;
    for (let i = 0; i < 5; i++) {
      await rm(cache, { recursive: true, force: true });
      await rm(legacy, { recursive: true, force: true }); await cp(image, legacy, { recursive: true });
      const a = await startup(`first-${i}`), b = await startup(`warm-${i}`);
      expect(a.observed.cache).toBe(cache); expect(a.observed.directory.startsWith(cache + "/")).toBe(true);
      const copied = Object.keys(source).filter(name => a.before[name] === source[name]).length;
      first.push(a.elapsedMs); warm.push(b.elapsedMs);
      samples.push({ index: i, firstMs: a.elapsedMs, warmMs: b.elapsedMs, sourceFiles: Object.keys(source).length, copiedBeforeSpawn: copied, cacheFilesBeforeSpawn: Object.keys(a.before).length });
      allSeeded &&= copied === Object.keys(source).length;
    }
    expect(inventory(image)).toEqual(source);
    expect(inventory(legacy)).toEqual(source);
    if (process.env.JUDGE_PROOF_DIRECTORY) {
      await mkdir(process.env.JUDGE_PROOF_DIRECTORY, { recursive: true });
      await writeFile(join(process.env.JUDGE_PROOF_DIRECTORY, `full-image-startup-${location}.json`), JSON.stringify({ node: process.version, pi: "1.5.2", host: "ryzen3", location, samples, medianFirstMs: median(first), medianWarmMs: median(warm), seeded: allSeeded, sourceFiles: Object.keys(source).length, sourceUnchanged: true,
        limitations: "Local installed Pi; warm OS pages; emulated full image cache using the same executable. Not a Boat VM or immutable-image qualification. First includes copy-once cost." }, null, 2) + "\n");
    }
    expect((await readdir(join(hostTmp, `paperclip-pi-cache-${process.getuid!()}`))).filter(name => name.startsWith(".image-seed-"))).toEqual([]);
    expect(allSeeded).toBe(true);
    // Runtime seeds, like OS seeds, remain read-only even after warm launches.
    expect(inventory(legacy)).toEqual(source);
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
