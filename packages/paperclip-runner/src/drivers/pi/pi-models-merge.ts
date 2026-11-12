import { readFile } from "node:fs/promises";

/**
 * Merge Paperclip's provider entry into an existing Pi models.json instead of
 * replacing it, so the agent's own providers and model settings in a sandbox
 * home (for example a model clamp) survive. Only `providers.paperclip` is ours.
 */
export async function mergedPiModelsJson(filePath: string, providerJson: string): Promise<string> {
  const ours = JSON.parse(providerJson) as { providers: Record<string, unknown> };
  let existingText: string;
  try {
    existingText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return providerJson;
    throw error;
  }
  if (existingText.length > 60 * 1024) throw new Error("Pi models.json is too large to merge");
  let existing: unknown;
  try {
    existing = JSON.parse(existingText);
  } catch {
    throw new Error("Pi models.json is not valid JSON; refusing to overwrite it");
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("Pi models.json is not an object; refusing to overwrite it");
  }
  const record = existing as Record<string, unknown>;
  const providers = record.providers && typeof record.providers === "object" && !Array.isArray(record.providers)
    ? record.providers as Record<string, unknown>
    : {};
  return `${JSON.stringify({ ...record, providers: { ...providers, ...ours.providers } })}\n`;
}
