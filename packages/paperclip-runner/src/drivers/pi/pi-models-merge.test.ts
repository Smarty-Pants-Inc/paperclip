import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergedPiModelsJson } from "./pi-models-merge.js";

const ours = `${JSON.stringify({ providers: { paperclip: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "t", models: [{ id: "m" }] } } })}\n`;
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

describe("mergedPiModelsJson", () => {
  it("returns ours when no models.json exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-merge-"));
    expect(await mergedPiModelsJson(join(dir, "models.json"), ours)).toBe(ours);
  });
  it("keeps the agent's own providers and top-level settings", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-merge-"));
    const file = join(dir, "models.json");
    await writeFile(file, JSON.stringify({ providers: { anthropic: { models: [{ id: "claude", maxThinking: "xhigh" }] }, paperclip: { old: true } }, extra: 1 }));
    const merged = JSON.parse(await mergedPiModelsJson(file, ours));
    expect(merged.extra).toBe(1);
    expect(merged.providers.anthropic.models[0].maxThinking).toBe("xhigh");
    expect(merged.providers.paperclip.apiKey).toBe("t");
    expect(merged.providers.paperclip.old).toBeUndefined();
  });
  it("refuses to overwrite an unparsable models.json", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-merge-"));
    const file = join(dir, "models.json");
    await writeFile(file, "{not json");
    await expect(mergedPiModelsJson(file, ours)).rejects.toThrow(/refusing/);
  });
});
