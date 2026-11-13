export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
}
export interface MailConfig {
  enabled: boolean;
  mailbox: string;
  gmailGrantRef: SecretRef;
  routineFireSecretRef: SecretRef;
  routineOrigin: string;
  routinePublicId: string;
}
export const SAFE_ERROR = "could not read mail";
export function fail(): never { throw new Error(SAFE_ERROR); }
export function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
export function only(v: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(v).some(k => !keys.includes(k))) fail();
}
const uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const refSchema = {
  type: "object", format: "secret-ref", additionalProperties: false, required: ["type", "secretId"],
  properties: {
    type: { type: "string", const: "secret_ref" }, secretId: { type: "string", pattern: uuid },
    version: { anyOf: [{ type: "string", const: "latest" }, { type: "integer", minimum: 1 }] },
  },
};
export const configSchema = {
  type: "object", additionalProperties: false,
  required: ["mailbox", "gmailGrantRef", "routineFireSecretRef", "routineOrigin", "routinePublicId"],
  properties: {
    enabled: { type: "boolean", default: false },
    mailbox: { type: "string", format: "email", default: "smarty@smartypants.ai" },
    gmailGrantRef: refSchema, routineFireSecretRef: refSchema,
    routineOrigin: { type: "string", format: "uri" },
    routinePublicId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" },
  },
};
function secretRef(v: unknown): SecretRef {
  if (!record(v)) fail();
  only(v, ["type", "secretId", "version"]);
  if (v.type !== "secret_ref" || typeof v.secretId !== "string" || !new RegExp(uuid).test(v.secretId) ||
      (v.version !== undefined && v.version !== "latest" &&
        !(typeof v.version === "number" && Number.isSafeInteger(v.version) && v.version > 0))) fail();
  return v as unknown as SecretRef;
}
export function parseConfig(v: unknown): MailConfig {
  if (!record(v)) fail();
  only(v, Object.keys(configSchema.properties));
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") fail();
  if (typeof v.mailbox !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.mailbox) ||
      typeof v.routinePublicId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(v.routinePublicId) ||
      typeof v.routineOrigin !== "string") fail();
  let origin: URL;
  try { origin = new URL(v.routineOrigin); } catch { fail(); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port ||
      origin.search || origin.hash || origin.pathname !== "/" || !origin.hostname ||
      ["gmail.googleapis.com", "oauth2.googleapis.com"].includes(origin.hostname)) fail();
  return {
    enabled: v.enabled === true, mailbox: v.mailbox.toLowerCase(),
    gmailGrantRef: secretRef(v.gmailGrantRef), routineFireSecretRef: secretRef(v.routineFireSecretRef),
    routineOrigin: origin.origin, routinePublicId: v.routinePublicId,
  };
}
