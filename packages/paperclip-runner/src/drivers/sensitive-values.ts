import { CONFIGURED_ENVIRONMENT_KEYS, SECRET_ENVIRONMENT_KEYS } from "../configured-environment.js";

/** Keep the same array live for exporters while a resident driver rotates its
 * capabilities. Retired values still need protection if the conversation echoes
 * them later. Never retain empty values or PEM framing as redaction needles. */
export function appendSensitiveValues(target: string[], values: readonly (string | undefined)[]): void {
  const known = new Set(target);
  for (const value of values) {
    if (!value) continue;
    const forms = [value, JSON.stringify(value).slice(1, -1),
      ...value.split(/\r?\n/).filter(line => line && !line.startsWith("-----"))];
    for (const form of forms) if (!known.has(form)) { known.add(form); target.push(form); }
  }
}

/** Shared OpenCode/Pi output-custody list construction. Drivers supply their
 * own admitted task environment and runtime capabilities, never ambient env. */
export function driverSensitiveValues(input: {
  identityKey?: string;
  taskEnvironment: NodeJS.ProcessEnv;
  values: readonly (string | undefined)[];
}): string[] {
  const values: string[] = [];
  appendSensitiveValues(values, [input.identityKey,
    ...Object.entries(input.taskEnvironment).flatMap(([key, value]) =>
      key !== CONFIGURED_ENVIRONMENT_KEYS && key !== SECRET_ENVIRONMENT_KEYS ? [value] : []),
    ...input.values]);
  return values;
}
