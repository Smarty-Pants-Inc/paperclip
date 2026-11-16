/** DIAGNOSTIC ONLY: an error's name and code for log lines, through an allow
 * pattern; never free message text or the cause chain (judges, 11-16 02:43Z):
 * a message is logged only when it is itself an identifier-shaped code. */
export type DiagnosticErrorSummary = { name: string; code: string; messageCode: string; errors?: DiagnosticErrorSummary[] };

// A message that is itself an identifier (our thrown codes such as
// runner_remote_checkpoint_manifest_mismatch) is logged; any other text is not.
const IDENTIFIER = /^[a-z]+(?:_[a-z]+){1,12}$/;

const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;
const safe = (value: unknown) => typeof value === "string" && SAFE.test(value) ? value
  : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value === undefined || value === null ? "none" : "other";

export function summarizeDiagnosticError(value: unknown, depth = 0): DiagnosticErrorSummary {
  const summary: DiagnosticErrorSummary = {
    name: value instanceof Error ? safe(value.name) : typeof value,
    code: safe((value as { code?: unknown } | null | undefined)?.code),
    messageCode: value instanceof Error && IDENTIFIER.test(value.message) ? value.message : "none",
  };
  if (depth < 1 && value instanceof AggregateError) summary.errors = value.errors.slice(0, 6).map(inner => summarizeDiagnosticError(inner, depth + 1));
  return summary;
}
