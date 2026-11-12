import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredPiManagedModel, resolvePiManagedModel, type PiBuiltinModelCatalog, type PiManagedModel } from "./pi-managed-model.js";

export async function readPiModelsSnapshot(filePath: string): Promise<Record<string, unknown>> {
  let text: string;
  try { text = await readFile(filePath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  if (text.length > 60 * 1024) throw new Error("Pi models.json is too large to merge");
  let snapshot: unknown;
  try { snapshot = JSON.parse(text); }
  catch { throw new Error("Pi models.json is not valid JSON; refusing to overwrite it"); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Pi models.json is not an object; refusing to overwrite it");
  return snapshot as Record<string, unknown>;
}

/** Read the SDK beside the selected Pi executable, not a runner dependency or
 * another installed Pi. The pinned 1.5.2 public providers/all export is ESM-only.
 * Import is cached by Node; catalog reads are local and never refresh/network.
 */
export async function loadPiBuiltinModelCatalog(command: string, environment: NodeJS.ProcessEnv): Promise<PiBuiltinModelCatalog | undefined> {
  try {
    let executable = command;
    if (!isAbsolute(executable)) {
      const candidates = (environment.PATH ?? process.env.PATH ?? "").split(delimiter).map(directory => join(directory, command));
      const found = await Promise.all(candidates.map(async candidate => access(candidate, constants.X_OK).then(() => candidate, () => undefined)));
      executable = found.find(candidate => candidate !== undefined) ?? command;
    }
    const manifest = findPackageJSON("@earendil-works/pi-ai/providers/all", pathToFileURL(await realpath(executable)));
    if (!manifest) return undefined;
    const declaration = JSON.parse(await readFile(manifest, "utf8"));
    if (declaration.name !== "@earendil-works/pi-ai" || declaration.version !== "1.5.2") return undefined;
    const exportPath = declaration.exports?.["./providers/*"]?.import;
    if (typeof exportPath !== "string") return undefined;
    const moduleUrl = pathToFileURL(join(dirname(manifest), exportPath.replace("*", "all"))).href;
    return await import(moduleUrl) as PiBuiltinModelCatalog;
  } catch { return undefined; } // The resolver emits one bounded fallback diagnostic.
}

export async function piManagedModelFromSnapshot(filePath: string, model: string, command: string, environment: NodeJS.ProcessEnv) {
  const id = model.startsWith("paperclip/") ? model.slice("paperclip/".length) : model;
  const configured = configuredPiManagedModel(await readPiModelsSnapshot(filePath), id);
  const catalog = await loadPiBuiltinModelCatalog(command, environment);
  return resolvePiManagedModel(configured, catalog);
}

/** Keep the agent's providers/top-level settings and its exact-id capability
 * overrides, but replace all managed routing/auth with the new broker's values.
 */
export async function mergedPiModelsJson(filePath: string, providerJson: string): Promise<string> {
  const ours = JSON.parse(providerJson) as { providers: Record<string, { models?: PiManagedModel[] }> };
  const snapshot = await readPiModelsSnapshot(filePath);
  if (!Object.keys(snapshot).length) return providerJson;
  const providers = snapshot.providers && typeof snapshot.providers === "object" && !Array.isArray(snapshot.providers)
    ? snapshot.providers as Record<string, unknown> : {};
  const paperclip = ours.providers.paperclip;
  if (Array.isArray(paperclip?.models)) paperclip.models = paperclip.models.map(model => {
    const configured = configuredPiManagedModel(snapshot, model.id);
    return { ...model, ...configured,
      ...(model.thinkingLevelMap || configured.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap, ...configured.thinkingLevelMap } } : {}) };
  });
  return `${JSON.stringify({ ...snapshot, providers: { ...providers, ...ours.providers } })}\n`;
}
