import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGuardRawArtifacts } from "./raw-artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-raw-test-")); roots.push(root);
  const sessionRoot = join(root, "sessions"), spillRoot = join(sessionRoot, "pi-tool-context-guard-native-session-fixed");
  await mkdir(spillRoot, { recursive: true, mode: 0o700 }); await chmod(spillRoot, 0o700);
  const path = join(spillRoot, "tool-call.json");
  const text = "HEAD_NONCE" + "x".repeat(60 * 1024 - 10) + "MIDDLE_NONCE" + "y".repeat(60 * 1024 - 23) + "TAIL_NONCE_";
  expect(Buffer.byteLength(text)).toBe(120 * 1024);
  const stored = { toolCallId: "call-1", toolName: "fixture", content: [{ type: "text", text }], details: { redactionPolicy: "native-guard" } };
  await writeFile(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  const input = { sessionRoot, toolCallId: "call-1", origin: { epoch: 1, runId: "run-1", turnId: "turn-1" }, details: { toolContextGuard: { spillPath: path, saveError: null, serializationFailed: false } }, entries: [{ type: "custom", id: "native-entry-1", customType: "tool-context-guard-full", data: stored }], sourceCursor: "session.jsonl:3" };
  return { root, path, input, text };
}

describe("tool-context-guard raw artifacts (data safety boundary)", () => {
  it("records exact 120 KiB stored readback, hash, length, native entry, call and origin", async () => {
    const f = await fixture(); const result = await collectGuardRawArtifacts(f.input), bytes = await readFile(f.path);
    expect(result.completeness).toBe(true); expect(result.failures).toEqual([]);
    expect(result.artifacts[0]).toMatchObject({ path: f.path, sha256: createHash("sha256").update(bytes).digest("hex"), length: bytes.length, toolCallId: "call-1", origin: f.input.origin, nativeEntryIds: ["native-entry-1"], sourceCursor: "session.jsonl:3" });
    expect(JSON.parse(bytes.toString()).content[0].text).toBe(f.text);
    for (const nonce of ["HEAD_NONCE", "MIDDLE_NONCE", "TAIL_NONCE_"]) expect(bytes.toString()).toContain(nonce);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600); expect((await stat(join(f.path, ".."))).mode & 0o777).toBe(0o700);
    f.input.origin.runId = "later-run"; expect(result.artifacts[0].origin.runId).toBe("run-1");
  });
  it("never declares completeness from a notice/preview, or an entry with no spill", async () => {
    const f = await fixture(); await rm(f.path);
    expect((await collectGuardRawArtifacts(f.input)).completeness).toBe(false);
    expect((await collectGuardRawArtifacts({ ...f.input, details: { text: `Full output saved to: ${f.path}` } })).completeness).toBe(false);
  });
  it.each(["outside", "traversal", "file-symlink", "directory-symlink"])("rejects %s even if bytes equal a native entry", async defect => {
    const f = await fixture(); let path: string;
    if (defect === "outside") { path = join(f.root, "outside.json"); await writeFile(path, await readFile(f.path)); }
    else if (defect === "traversal") path = join(f.input.sessionRoot, "a") + "/../pi-tool-context-guard-native-session-fixed/tool-call.json";
    else if (defect === "file-symlink") { path = join(f.input.sessionRoot, "link.json"); await symlink(f.path, path); }
    else { path = join(f.input.sessionRoot, "linked-dir", "tool-call.json"); await symlink(join(f.path, ".."), join(f.input.sessionRoot, "linked-dir")); }
    const result = await collectGuardRawArtifacts({ ...f.input, details: { toolContextGuard: { spillPath: path } } });
    expect(result.completeness).toBe(false); expect(result.artifacts).toEqual([]); expect(result.failures.length).toBeGreaterThan(0);
  });
  it("marks missing/mismatched entry, wrong tool call, serialization and export failures incomplete", async () => {
    const f = await fixture();
    expect((await collectGuardRawArtifacts({ ...f.input, entries: [] })).completeness).toBe(false);
    const wrong = { ...f.input.entries[0], data: { ...f.input.entries[0].data, content: [] } };
    expect((await collectGuardRawArtifacts({ ...f.input, entries: [wrong] })).completeness).toBe(false);
    expect((await collectGuardRawArtifacts({ ...f.input, toolCallId: "other-call" })).completeness).toBe(false);
    expect((await collectGuardRawArtifacts({ ...f.input, details: { toolContextGuard: { spillPath: f.path, serializationFailed: true } } })).completeness).toBe(false);
    expect((await collectGuardRawArtifacts({ ...f.input, retain: async () => { throw new Error("PRIVATE_SENTINEL"); } })).completeness).toBe(false);
    expect(JSON.stringify(await collectGuardRawArtifacts({ ...f.input, retain: async () => { throw new Error("PRIVATE_SENTINEL"); } }))).not.toContain("PRIVATE_SENTINEL");
  });
  it("checks evidence-store readback before claiming retained export", async () => {
    const f = await fixture();
    const good = await collectGuardRawArtifacts({ ...f.input, retain: async (artifact, bytes) => ({ sha256: createHash("sha256").update(bytes).digest("hex"), length: artifact.length }) });
    expect(good.completeness).toBe(true); expect(good.artifacts[0].exported).toBe(true);
    const bad = await collectGuardRawArtifacts({ ...f.input, retain: async () => ({ sha256: "bad", length: 0 }) });
    expect(bad.completeness).toBe(false); expect(bad.artifacts[0].exported).toBe(false);
  });
});
