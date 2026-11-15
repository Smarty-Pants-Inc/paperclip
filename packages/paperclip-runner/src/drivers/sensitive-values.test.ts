import { describe, expect, it } from "vitest";
import { configuredEnvironmentProjection, CONFIGURED_ENVIRONMENT_KEYS, SECRET_ENVIRONMENT_KEYS } from "../configured-environment.js";
import { appendSensitiveValues, driverSensitiveValues } from "./sensitive-values.js";

describe("driver sensitive values", () => {
  it("preserves every OpenCode source and raw/escaped/identity-line representation", () => {
    const identityKey = "-----BEGIN PRIVATE KEY-----\r\nprivate-line-one\r\nprivate-line-two\r\n-----END PRIVATE KEY-----";
    const task = 'configured-"value"\\with\nnewlines';
    const taskEnvironment = configuredEnvironmentProjection({ ORDINARY_NAME: task, NON_SECRET: "configured-non-secret" }, ["ORDINARY_NAME"]);
    const runtime = ["session-password", "Basic session-auth", "bridge-secret", "mcp-token", "openrouter-key", "managed-provider-key"];
    const result = driverSensitiveValues({ identityKey, taskEnvironment, values: runtime });
    expect(result).toEqual(expect.arrayContaining([identityKey, JSON.stringify(identityKey).slice(1, -1),
      "private-line-one", "private-line-two", task, JSON.stringify(task).slice(1, -1), "configured-non-secret", ...runtime]));
    expect(result).not.toContain(taskEnvironment[CONFIGURED_ENVIRONMENT_KEYS]);
    expect(result).not.toContain(taskEnvironment[SECRET_ENVIRONMENT_KEYS]);
    expect(result).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(result).not.toContain("-----END PRIVATE KEY-----");
  });
  it("retains the same array across rotations, deduplicates and ignores empty values", () => {
    const values = driverSensitiveValues({ taskEnvironment: {}, values: [undefined, "", "old-capability"] });
    const exporterReference = values;
    appendSensitiveValues(values, ["new-capability", "old-capability", undefined, ""]);
    expect(exporterReference).toBe(values);
    expect(values).toEqual(["old-capability", "new-capability"]);
  });
});
