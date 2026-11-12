import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "../private-file.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > 60 * 1024) throw new Error();
    const settings: unknown = JSON.parse(text);
    if (!record(settings) || (settings.compaction !== undefined && !record(settings.compaction))) throw new Error();
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Pi settings.json could not be read as bounded JSON; refusing to overwrite it (content redacted)");
  }
}

function explicitReserve(settings: Record<string, unknown>, model: string): unknown {
  const compaction = record(settings.compaction) ? settings.compaction : {};
  const overrides = record(compaction.modelOverrides) ? compaction.modelOverrides : {};
  const override = record(overrides[model]) ? overrides[model] : {};
  return override.reserveTokens ?? compaction.reserveTokens;
}

/** V2-R2 row 1: match v1's 100k headroom on large windows, without
 * exceeding a quarter of a small model's context. Leave Pi's other defaults alone.
 * Managed-home settings win; otherwise honor the original user's explicit reserve.
 */
export async function configurePiManagedCompaction(input: {
  agentHome: string; originalAgentHome: string; model: string; contextWindow: number;
}): Promise<void> {
  const path = join(input.agentHome, "settings.json");
  const settings = await readSettings(path);
  if (explicitReserve(settings, input.model) !== undefined) return;
  const original = input.originalAgentHome === input.agentHome ? settings
    : await readSettings(join(input.originalAgentHome, "settings.json"));
  const reserveTokens = explicitReserve(original, input.model)
    ?? Math.min(100000, Math.floor(input.contextWindow * 0.25));
  const compaction = record(settings.compaction) ? settings.compaction : {};
  await mkdir(input.agentHome, { recursive: true, mode: 0o700 });
  await writePrivateFile(path, `${JSON.stringify({ ...settings, compaction: { ...compaction, reserveTokens } })}\n`);
}
