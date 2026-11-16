// Output-only heuristics: never use these to mutate provider input or decide
// whether a value is safe to admit. Exact-value redaction must still run first.
const privateLabel = "[A-Z0-9 ]{0,64}PRIVATE KEY";
const begin = `-----BEGIN ${privateLabel}-----`;
const end = `-----END ${privateLabel}-----`;
const endCheck = new RegExp(end);
// Real, JSON-escaped and doubly escaped line endings, or space-joined PEM.
const separator = String.raw`(?:[ \t\r\n]|\\{1,2}[rn])+`;
const body = "[A-Za-z0-9+/]+={0,2}";
const firstBody = "[A-Za-z0-9+/]{32}[A-Za-z0-9+/]*={0,2}";
// Bound both sides of the overlapping keyword: unbounded runs backtrack
// quadratically on a long name containing repeated KEY but no closing syntax.
const secretName = String.raw`[A-Za-z_][A-Za-z0-9_.-]{0,64}(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)[A-Za-z0-9_.-]{0,64}|(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)[A-Za-z0-9_.-]{0,64}`;
const identityMark = String.raw`\*{3}REDACTED\*{3}`;
// Identity material scanning can erase framing and long runs but leave short
// lines or JSON-escaped slashes. Keep those lexical runs in one candidate.
const projectedFirstBody = String.raw`(?:[A-Za-z0-9+/]|\\{1,2}/){32}={0,2}`;
// Candidates are validated before replacement. A flat character class avoids
// one regexp stack frame per escaped slash (or body byte) on multi-MiB lines.
const projectedToken = new RegExp(String.raw`${identityMark}|[A-Za-z0-9+/\\]+={0,2}`, "g");
const identityLineBreak = /(\\{1,2}[rn]|\r\n?|\n)/;
const identityValue = "***REDACTED***";
// Reject ordinary PEM bytes before allocating a copy with every mark removed.
const onlyHashLines = (text: string) => !/[^a-f0-9\r\n*rt]/i.test(text)
  && !/[^a-f0-9\r\n]/i.test(text.replaceAll(identityValue, ""));

// A projected PEM is a group of base64-only logical lines, not an arbitrary
// span of words next to an identity mark. Bound line checks before normalizing;
// a contiguous body attached to a mark may still be arbitrarily long.
function redactIdentityPem(candidate: string): string {
  if (!candidate.includes(identityValue)) return candidate;
  // Hash-only lines are not PEM evidence. Check them with simple native scans
  // before allocating a split entry per line, including directly attached SHAs.
  if (onlyHashLines(candidate)) return candidate;
  const parts = candidate.split(identityLineBreak);
  let start = 0;
  let hasMark = false;
  let hasBody = false;
  // Repeated log lines need not be normalized/validated again. One entry is
  // enough; do not grow a cache with caller-controlled output.
  let previousLine: string | undefined;
  let previousValid = false;
  let previousLong = false;
  const flush = (end: number) => {
    if (hasMark && hasBody) {
      let previous: string | undefined;
      let replacement = "";
      for (let i = start; i < end; i += 2) {
        const line = parts[i]!;
        if (line === identityValue) continue;
        if (line !== previous) {
          previous = line;
          replacement = line.replace(projectedToken, token => token === identityValue ? token : "[REDACTED:pem]");
        }
        parts[i] = replacement;
      }
    }
    start = end + 2;
    hasMark = hasBody = false;
  };
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    if (line === identityValue) { hasMark = true; continue; }
    const marked = line.includes(identityValue);
    if (!marked && line === previousLine) {
      if (!previousValid) flush(i);
      else hasBody ||= previousLong;
      continue;
    }
    if (!marked && line.length > 230) { flush(i); continue; }
    const runs = marked ? line.split(identityValue) : [line];
    let valid = true;
    let long = false;
    for (let j = 0; j < runs.length; j++) {
      // A slash escape can remain before a mark when identity scanning masks
      // the n in \\n with the following body run. Strip only that suffix.
      const run = marked && j < runs.length - 1 ? runs[j]!.replace(/\\{1,2}$/, "") : runs[j]!;
      if (marked && !run) continue;
      let size = run.endsWith("==") ? run.length - 2 : run.endsWith("=") ? run.length - 1 : run.length;
      if (!/^[A-Za-z0-9+/\\]+={0,2}$/.test(run)) { valid = false; break; }
      // Count escaped slashes without allocating a replacement per slash or
      // using an alternation repeated millions of times in a regexp.
      const escaped = run.includes("\\");
      if (escaped) {
        for (let at = 0; at < run.length; at++) {
          if (run.charCodeAt(at) !== 92) continue;
          if (run.charCodeAt(at + 1) === 92) { at++; size--; }
          if (run.charCodeAt(at + 1) !== 47) { valid = false; break; }
          at++;
          size--;
        }
      }
      // Unmarked lines are already length-bounded. Normalize only those small
      // path checks; attached pure hex is not additional PEM evidence either.
      const path = !marked && /^\/[a-z0-9/]+$/.test(escaped ? run.replace(/\\{1,2}\//g, "/") : run);
      if (!valid || (!marked && size > 76) || (!escaped && /^[a-f0-9]{32,}$/i.test(run)) || path) {
        valid = false;
        break;
      }
      if (size >= 32) long = true;
    }
    if (!marked) { previousLine = line; previousValid = valid; previousLong = long; }
    if (!valid) { flush(i); continue; }
    hasMark ||= marked;
    hasBody ||= long;
  }
  flush(parts.length);
  return parts.join("");
}
const mark = /^(?:\[REDACTED(?::[a-z_-]+)?\]|\*{3}REDACTED\*{3})$/i;

const patterns: ReadonlyArray<{ kind: string; pattern: RegExp; assignment?: "json" | "shell"; needsEnd?: true; bodyCandidate?: true; identityPem?: true; hint?: string | RegExp }> = [
  // Stop at another BEGIN so many incomplete blocks cannot cause a quadratic
  // scan for a missing END. Complete blocks include all wrapping and headers.
  { kind: "pem", needsEnd: true, pattern: new RegExp(`${begin}(?:(?!-----BEGIN )[\\s\\S])*?${end}`, "g") },
  { kind: "pem", pattern: new RegExp(`${begin}(?:${separator}${firstBody}(?:${separator}${body})*)?`, "g") },
  // Consume a body candidate even without END, leaving it unchanged below.
  // Requiring END in the regex would retry every line of a non-PEM base64 dump.
  { kind: "pem", needsEnd: true, bodyCandidate: true, pattern: new RegExp(`(?<![A-Za-z0-9+/])${firstBody}(?:${separator}${body})*(?:${separator}${end})?|${end}`, "g") },
  // No required suffix, and no spaces: consume each lexical candidate once.
  // Consume (and preserve) the line boundary instead of testing lookbehinds at
  // every byte. Body starts are only at logical lines or attached to a mark.
  // The callback checks bounded lines, never an unanchored body search.
  { kind: "pem", identityPem: true, pattern: new RegExp(String.raw`(?:${identityMark}|(?:^|[\r\n]|\\{1,2}[rn])${projectedFirstBody})(?:[A-Za-z0-9+/=\r\n\\]+|${identityMark})*`, "g") },
  { kind: "assignment", assignment: "json", pattern: new RegExp(String.raw`("(?:${secretName})"\s*:\s*)("(?:\\[\s\S]|[^"\\])*")`, "gi") },
  { kind: "assignment", assignment: "shell", pattern: new RegExp(String.raw`((?<![A-Za-z0-9_.-])(?:${secretName})[ \t]*=[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\s"'\x60,;]+)`, "gi") },
  // Fixed minimum + a simple greedy tail avoids V8's per-character counter
  // overhead for {min,} on multi-MiB values, without bounding secret length.
  { kind: "github", hint: "_", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}[A-Za-z0-9]*|github_pat_[A-Za-z0-9_]{40}[A-Za-z0-9_]*)/g },
  { kind: "langfuse", hint: "k-lf-", pattern: /\b[sp]k-lf-[A-Za-z0-9_-]+/g },
  { kind: "anthropic", hint: "sk-ant-", pattern: /\bsk-ant-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g },
  { kind: "openai", hint: "sk-", pattern: /\bsk-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*/g },
  { kind: "slack", hint: "xox", pattern: /\bxox[abpr]-[A-Za-z0-9-]+/g },
  { kind: "aws", hint: "AKIA", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "jwt", hint: "eyJ", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: "bearer", hint: /bearer/i, pattern: /\bBearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi },
];

/** Redact recognizable unknown secret shapes before any output truncation.
 * Pure, stateless and idempotent; does not decode arbitrary base64 or infer
 * secrets from entropy. Orphan PEM needs a >=32-character adjacent body token
 * to avoid eating ordinary prose before an END marker. */
export function redactSecretShapes(text: string): string {
  try { return redactScannableText(text); }
  catch { return "[REDACTED:unscannable]"; }
}

function redactScannableText(text: string): string {
  for (const { kind, pattern, assignment, needsEnd, bodyCandidate, identityPem, hint } of patterns) {
    if (hint && !(typeof hint === "string" ? text.includes(hint) : hint.test(text))) continue;
    if (kind === "pem" && !text.includes(identityPem ? identityValue : "PRIVATE KEY-----")) continue;
    if (identityPem && onlyHashLines(text)) continue;
    if (needsEnd && !endCheck.test(text)) continue;
    if (assignment && !text.includes(assignment === "json" ? ":" : "=")) continue;
    if (!assignment && !identityPem && !bodyCandidate) {
      text = text.replace(pattern, `[REDACTED:${kind}]`);
      continue;
    }
    text = text.replace(pattern, (match: string, prefix: string, value: string) => {
      if (identityPem) return redactIdentityPem(match);
      if (kind === "pem" && !match.startsWith("-----") && !match.includes("-----END ")) return match;
      if (!assignment) return `[REDACTED:${kind}]`;
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : "";
      const content = quote ? value.slice(1, -1) : value;
      return mark.test(content) ? match : `${prefix}${quote}[REDACTED:${kind}]${quote}`;
    });
  }
  return text;
}
