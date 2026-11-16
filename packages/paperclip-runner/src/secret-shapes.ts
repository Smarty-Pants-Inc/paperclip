// Output-only heuristics: never use these to mutate provider input or decide
// whether a value is safe to admit. Exact-value redaction must still run first.
const privateLabel = "[A-Z0-9 ]{0,64}PRIVATE KEY";
const begin = `-----BEGIN ${privateLabel}-----`;
const end = `-----END ${privateLabel}-----`;
// Real, JSON-escaped and doubly escaped line endings, or space-joined PEM.
const separator = String.raw`(?:[ \t\r\n]|\\{1,2}[rn])+`;
const body = "[A-Za-z0-9+/]+={0,2}";
const firstBody = "[A-Za-z0-9+/]{32,}={0,2}";
// Bound both sides of the overlapping keyword: unbounded runs backtrack
// quadratically on a long name containing repeated KEY but no closing syntax.
const secretName = String.raw`[A-Za-z_][A-Za-z0-9_.-]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)[A-Za-z0-9_.-]{0,64}|(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)[A-Za-z0-9_.-]{0,64}`;
const identityMark = String.raw`\*{3}REDACTED\*{3}`;
// Identity material scanning can erase framing and long runs but leave short
// lines or JSON-escaped slashes. Keep those lexical runs in one candidate.
const projectedFirstBody = String.raw`(?:[A-Za-z0-9+/]|\\{1,2}/){32,}={0,2}`;
const projectedBodyCheck = new RegExp(projectedFirstBody);
const mark = /^(?:\[REDACTED(?::[a-z_-]+)?\]|\*{3}REDACTED\*{3})$/i;

const patterns: ReadonlyArray<{ kind: string; pattern: RegExp; assignment?: true; identityPem?: true }> = [
  // Stop at another BEGIN so many incomplete blocks cannot cause a quadratic
  // scan for a missing END. Complete blocks include all wrapping and headers.
  { kind: "pem", pattern: new RegExp(`${begin}(?:(?!-----BEGIN )[\\s\\S])*?${end}`, "g") },
  { kind: "pem", pattern: new RegExp(`${begin}(?:${separator}${firstBody}(?:${separator}${body})*)?`, "g") },
  // Consume a body candidate even without END, leaving it unchanged below.
  // Requiring END in the regex would retry every line of a non-PEM base64 dump.
  { kind: "pem", pattern: new RegExp(`(?<![A-Za-z0-9+/])${firstBody}(?:${separator}${body})*(?:${separator}${end})?|${end}`, "g") },
  // No required suffix: consume a lexical candidate once, then check for the
  // mark in the callback. Requiring a trailing mark would retry every body line
  // of a non-PEM dump. Separators, body runs and marks have disjoint starts.
  // A lone backslash can remain when identity scanning masks the 'n' of \\n
  // together with the next body run. Consume it without decoding caller text.
  { kind: "pem", identityPem: true, pattern: new RegExp(String.raw`(?<![A-Za-z0-9+/])(?:${identityMark}|${projectedFirstBody})(?:[ \t\r\n\\]|${body}|${identityMark})*`, "g") },
  { kind: "assignment", assignment: true, pattern: new RegExp(String.raw`("(?:${secretName})"\s*:\s*)("(?:\\[\s\S]|[^"\\])*")`, "gi") },
  { kind: "assignment", assignment: true, pattern: new RegExp(String.raw`((?<![A-Za-z0-9_.-])(?:${secretName})[ \t]*=[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\s"'\x60,;]+)`, "gi") },
  { kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "langfuse", pattern: /\b[sp]k-lf-[A-Za-z0-9_-]+/g },
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack", pattern: /\bxox[abpr]-[A-Za-z0-9-]+/g },
  { kind: "aws", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: "bearer", pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi },
];

/** Redact recognizable unknown secret shapes before any output truncation.
 * Pure, stateless and idempotent; does not decode arbitrary base64 or infer
 * secrets from entropy. Orphan PEM needs a >=32-character adjacent body token
 * to avoid eating ordinary prose before an END marker. */
export function redactSecretShapes(text: string): string {
  for (const { kind, pattern, assignment, identityPem } of patterns) {
    if (kind === "pem" && !text.includes(identityPem ? "***REDACTED***" : "PRIVATE KEY-----")) continue;
    text = text.replace(pattern, (match: string, prefix: string, value: string) => {
      if (identityPem) {
        if (!match.includes("***REDACTED***") || !projectedBodyCheck.test(match)) return match;
      } else if (kind === "pem" && !match.startsWith("-----") && !match.includes("-----END ")) return match;
      if (!assignment) return `[REDACTED:${kind}]`;
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
      const content = quote ? value.slice(1, -1) : value;
      return mark.test(content) ? match : `${prefix}${quote}[REDACTED:${kind}]${quote}`;
    });
  }
  return text;
}
