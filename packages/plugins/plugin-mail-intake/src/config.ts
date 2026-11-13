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
  scanWindowDays: number;
}
// PluginContext has no instance URL (SDK types.ts:2210–2318), and the host's
// worker env has none (plugin-loader.ts:155–179). Build-time fallback only:
// HQ is the sole supplied real origin; no undocumented TEST hostname is guessed.
export const ROUTINE_ORIGINS: readonly string[] = Object.freeze(["https://hq.smartypants.ai"]);
export function assertRoutineOrigin(origin: string): void {
  // Exact spelling also rejects explicit :443, userinfo and URL normalization.
  if (!ROUTINE_ORIGINS.includes(origin)) fail();
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
// Host validation projects a valid binding to its ID before Ajv validation
// (server/src/services/plugin-config-validator.ts:32–34). The stored/runtime
// value remains an object: PLUGIN_SPEC.md:1293,1501 and SDK types.ts resolve().
const refSchema = { type: "string", format: "secret-ref" };
export const configSchema = {
  type: "object", additionalProperties: false,
  required: ["mailbox", "gmailGrantRef", "routineFireSecretRef", "routineOrigin", "routinePublicId"],
  properties: {
    enabled: { type: "boolean", default: false },
    mailbox: { type: "string", format: "email", default: "smarty@smartypants.ai" },
    gmailGrantRef: refSchema, routineFireSecretRef: refSchema,
    routineOrigin: { type: "string", format: "uri", enum: ROUTINE_ORIGINS },
    scanWindowDays: { type: "integer", minimum: 1, maximum: 30, default: 7 },
    routinePublicId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" },
  },
};
// The schema's string type is only the host's validation projection. Never
// accept a raw UUID at runtime; ctx.secrets.resolve needs the stored binding.
export function parseSecretRef(v: unknown): SecretRef {
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
  assertRoutineOrigin(v.routineOrigin);
  const scanWindowDays = v.scanWindowDays === undefined ? 7 : v.scanWindowDays;
  if (typeof scanWindowDays !== "number" || !Number.isInteger(scanWindowDays) || scanWindowDays < 1 || scanWindowDays > 30) fail();
  return {
    enabled: v.enabled === true, mailbox: v.mailbox.toLowerCase(),
    gmailGrantRef: parseSecretRef(v.gmailGrantRef), routineFireSecretRef: parseSecretRef(v.routineFireSecretRef),
    routineOrigin: v.routineOrigin, routinePublicId: v.routinePublicId, scanWindowDays,
  };
}
