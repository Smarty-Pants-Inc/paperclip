import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { childAdmissionError } from "./selection.js";

const forbidden = new Set([
  "model", "provider", "thinking", "effort", "thinkinglevel", "pirpcthinkinglevel", "defaultmodel", "defaultthinking",
  "runtime", "runtimeidentity", "grant", "grantversion", "epoch", "runid", "sessionid", "turnid", "credentials",
]);
function inspect(value: unknown, path = "frontmatter"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase().replace(/[-_]/g, ""))) childAdmissionError("role_runtime_identity", `Reusable role ${path}.${key} is runtime identity; select model/effort separately for each spawn.`);
    inspect(child, `${path}.${key}`);
  }
}
export interface RoleTemplate {
  readonly text: string;
  readonly digest: string;
}
/** Validates without projection, mutation, or rewriting the upstream role. Digest covers exact bytes. */
export function validateRoleTemplate(text: string): RoleTemplate {
  if (typeof text !== "string" || text.length > 200_000) childAdmissionError("role_invalid", "Role text must be a bounded string.");
  const normalized = text.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n");
  if (normalized.startsWith("---\n")) {
    const lines = normalized.split("\n");
    const end = lines.indexOf("---", 1);
    if (end < 0) childAdmissionError("role_invalid", "Role frontmatter is not terminated.");
    const document = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) childAdmissionError("role_invalid", "Role frontmatter must be unambiguous YAML.");
    let metadata: unknown;
    try { metadata = document.toJS({ maxAliasCount: 0 }); }
    catch { childAdmissionError("role_invalid", "Role frontmatter aliases are not admitted."); }
    if (metadata !== null && (typeof metadata !== "object" || Array.isArray(metadata))) childAdmissionError("role_invalid", "Role frontmatter must be a mapping.");
    inspect(metadata);
  }
  return Object.freeze({ text, digest: createHash("sha256").update(text, "utf8").digest("hex") });
}
