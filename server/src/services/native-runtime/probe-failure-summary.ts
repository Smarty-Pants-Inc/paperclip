import { redactSensitiveText } from "../../redaction.js";

/** A bounded, redacted one-line cause for operator logs; never shown to users. */
export function probeFailureSummary(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return redactSensitiveText(text).replace(/\s+/g, " ").slice(0, 2_000);
}
