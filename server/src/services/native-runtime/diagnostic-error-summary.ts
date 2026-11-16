/** DIAGNOSTIC ONLY: an error's name and code for log lines, through an allow
 * pattern; never free message text or the cause chain (judges, 11-16 02:43Z):
 * a message is logged only when it is itself an identifier-shaped code. */
export type DiagnosticErrorSummary = { name: string; code: string; messageCode: string; errors?: DiagnosticErrorSummary[] };

// A message that is itself an identifier (our thrown codes such as
// runner_remote_checkpoint_manifest_mismatch) is logged; any other text is not.
const IDENTIFIER = /^[a-z]+(?:_[a-z]+){1,12}$/;
const IDENTIFIER_MAX_LENGTH = 128;

const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;
const safe = (value: unknown) => typeof value === "string" && SAFE.test(value) ? value
  : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value === undefined || value === null ? "none" : "other";
// Reading a property of a hostile value can throw; a summary never does.
const read = (value: unknown, key: "name" | "code" | "message" | "errors"): unknown => {
  try { return (value as Record<string, unknown> | null | undefined)?.[key]; } catch { return { unreadable: true }; }
};

export function summarizeDiagnosticError(value: unknown, depth = 0): DiagnosticErrorSummary {
  const isError = value instanceof Error;
  const message = isError ? read(value, "message") : undefined;
  const summary: DiagnosticErrorSummary = {
    name: isError ? safe(read(value, "name")) : typeof value,
    code: safe(read(value, "code")),
    messageCode: typeof message === "string" && message.length <= IDENTIFIER_MAX_LENGTH && IDENTIFIER.test(message) ? message : "none",
  };
  const errors = depth < 1 && value instanceof AggregateError ? read(value, "errors") : undefined;
  if (Array.isArray(errors)) summary.errors = errors.slice(0, 6).map(inner => summarizeDiagnosticError(inner, depth + 1));
  return summary;
}

/** The whole serialized line (pino's level/time/pid/hostname envelope included)
 * stays within this many bytes. */
export const DIAGNOSTIC_LINE_MAX_BYTES = 512;
// pino adds {"level":40,"time":<13 digits>,"pid":<n>,"hostname":"<host>"} to the
// fields we pass; reserve room for it so the written line stays within the cap.
const PINO_ENVELOPE_BYTES = 128;

const lineBytes = (fields: Record<string, unknown>, message: string) => {
  try { return Buffer.byteLength(JSON.stringify({ ...fields, msg: message })); } catch { return Number.POSITIVE_INFINITY; }
};

/** Fit a diagnostic log line's fields within DIAGNOSTIC_LINE_MAX_BYTES. Array
 * fields lose trailing entries first (counted in `<field>Omitted`); if that is
 * not enough, only numbers, booleans and identifier-shaped strings remain
 * (timing numbers are kept). Never throws. */
export function boundDiagnosticFields(fields: Record<string, unknown>, message: string,
  maxBytes = DIAGNOSTIC_LINE_MAX_BYTES - PINO_ENVELOPE_BYTES): Record<string, unknown> {
  try {
    if (lineBytes(fields, message) <= maxBytes) return fields;
    const bounded: Record<string, unknown> = { ...fields };
    const arrays = Object.keys(bounded).filter(key => Array.isArray(bounded[key]));
    for (const key of arrays) bounded[key] = [...(bounded[key] as unknown[])];
    while (lineBytes(bounded, message) > maxBytes) {
      const key = arrays.filter(name => (bounded[name] as unknown[]).length > 0)
        .sort((left, right) => (bounded[right] as unknown[]).length - (bounded[left] as unknown[]).length)[0];
      if (!key) break;
      (bounded[key] as unknown[]).pop();
      bounded[`${key}Omitted`] = (typeof bounded[`${key}Omitted`] === "number" ? bounded[`${key}Omitted`] as number : 0) + 1;
    }
    if (lineBytes(bounded, message) <= maxBytes) return bounded;
    const scalars: Record<string, unknown> = { truncated: true };
    for (const [key, value] of Object.entries(fields)) {
      if (!SAFE.test(key)) continue;
      if (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && SAFE.test(value))) scalars[key] = value;
      if (lineBytes(scalars, message) > maxBytes) { delete scalars[key]; break; }
    }
    return scalars;
  } catch { return { truncated: true }; }
}
