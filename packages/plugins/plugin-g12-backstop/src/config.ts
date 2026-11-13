export interface G12Config {
  enabled: boolean;
  companyId: string;
  appId: number;
  installationId: number;
  privateKeyRef: { type: "secret_ref"; secretId: string; version?: "latest" | number };
  repos: string[] | "all";
  missingReviewMinutes: number;
  owners: Record<string, { agentId: string; issueId: string }>;
}

const uuid = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const repo = "^(?!\\.{1,2}/)[A-Za-z0-9_.-]+/(?!\\.{1,2}$)[A-Za-z0-9_.-]+$";
const login = "^[A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?$";

// One ref, at one fixed path. No inline keys, trigger credentials or arbitrary URLs.
export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "companyId", "appId", "installationId", "privateKeyRef", "repos", "owners"],
  properties: {
    enabled: { type: "boolean", default: false },
    companyId: { type: "string", pattern: uuid },
    appId: { type: "integer", minimum: 1 },
    installationId: { type: "integer", minimum: 1 },
    privateKeyRef: {
      type: "object", additionalProperties: false, required: ["type", "secretId"],
      properties: {
        type: { type: "string", const: "secret_ref" },
        secretId: { type: "string", pattern: uuid },
        version: { anyOf: [{ type: "string", const: "latest" }, { type: "integer", minimum: 1 }] },
      },
    },
    repos: { anyOf: [
      { type: "string", const: "all" },
      { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: { type: "string", pattern: repo } },
    ] },
    missingReviewMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 15 },
    owners: {
      type: "object", minProperties: 1, propertyNames: { pattern: login },
      additionalProperties: {
        type: "object", additionalProperties: false, required: ["agentId", "issueId"],
        properties: { agentId: { type: "string", pattern: uuid }, issueId: { type: "string", pattern: uuid } },
      },
    },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("G12_CONFIG_UNKNOWN_FIELD");
}
function matches(value: unknown, pattern: string): value is string {
  return typeof value === "string" && new RegExp(pattern).test(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate again in the worker: config may arrive by startup replay, not the form. */
export function parseConfig(value: unknown): G12Config {
  if (!record(value)) throw new Error("G12_CONFIG_INVALID");
  keys(value, Object.keys(configSchema.properties));
  if (typeof value.enabled !== "boolean" || !matches(value.companyId, uuid) ||
      !positive(value.appId) || !positive(value.installationId)) throw new Error("G12_CONFIG_IDENTITY");
  const ref = value.privateKeyRef;
  if (!record(ref)) throw new Error("G12_CONFIG_SECRET_REF");
  keys(ref, ["type", "secretId", "version"]);
  if (ref.type !== "secret_ref" || !matches(ref.secretId, uuid) ||
      (ref.version !== undefined && ref.version !== "latest" && !positive(ref.version))) {
    throw new Error("G12_CONFIG_SECRET_REF");
  }
  let repos: string[] | "all" = "all";
  if (value.repos !== "all") {
    if (!Array.isArray(value.repos) || value.repos.length < 1 || value.repos.length > 500 ||
        !value.repos.every((name) => matches(name, repo))) throw new Error("G12_CONFIG_REPOS");
    repos = value.repos.map((name: string) => name.toLowerCase());
    if (new Set(repos).size !== repos.length) throw new Error("G12_CONFIG_DUPLICATE_REPO");
  }
  const minutes = value.missingReviewMinutes ?? 15;
  if (!positive(minutes) || minutes > 1440) throw new Error("G12_CONFIG_MINUTES");
  if (!record(value.owners) || Object.keys(value.owners).length === 0) throw new Error("G12_CONFIG_OWNERS");
  const owners: G12Config["owners"] = Object.create(null);
  const issueAgents = new Map<string, string>();
  for (const [author, owner] of Object.entries(value.owners)) {
    if (!matches(author, login) || !record(owner)) throw new Error("G12_CONFIG_OWNER");
    keys(owner, ["agentId", "issueId"]);
    if (!matches(owner.agentId, uuid) || !matches(owner.issueId, uuid)) throw new Error("G12_CONFIG_OWNER");
    const normalized = author.toLowerCase();
    if (Object.hasOwn(owners, normalized)) throw new Error("G12_CONFIG_DUPLICATE_OWNER");
    if (issueAgents.has(owner.issueId) && issueAgents.get(owner.issueId) !== owner.agentId) {
      throw new Error("G12_CONFIG_CONFLICTING_ISSUE_OWNER");
    }
    issueAgents.set(owner.issueId, owner.agentId);
    owners[normalized] = { agentId: owner.agentId, issueId: owner.issueId };
  }
  return {
    enabled: value.enabled, companyId: value.companyId, appId: value.appId, installationId: value.installationId,
    privateKeyRef: { type: "secret_ref", secretId: ref.secretId, ...(ref.version === undefined ? {} : { version: ref.version as "latest" | number }) },
    repos, missingReviewMinutes: minutes, owners,
  };
}
