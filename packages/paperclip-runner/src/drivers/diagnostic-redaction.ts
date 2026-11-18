import { redactCommandText } from "@paperclipai/adapter-utils/command-redaction";

/** Answer-only prose exception; credential-shaped rules still run first. */
export function redactProviderAnswer(message: string): string {
  return redactProviderDiagnostic(redactCommandText(message, "[REDACTED]"), true);
}

/** Redact diagnostic text without importing the provider process or its credentials. */
export function redactProviderDiagnostic(message: string, allowBearerProse = false): string {
  const sanitized = message
    .replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, (match, offset: number, input: string) => {
      if (!allowBearerProse) return "Bearer [REDACTED]";
      // Keep in sync with server redactStandaloneBearerCredentials: inspect the
      // whole whitespace-delimited word and same-line quotes, not a token prefix.
      const start = offset + /^Bearer\s+/i.exec(match)![0].length;
      const word = /^\S+/.exec(input.slice(start))![0];
      const prose = word.replace(/[.,;:!?)\]]+$/, "");
      let before = offset - 1;
      while (before >= 0 && /[^\S\r\n]/.test(input[before]!)) before--;
      let after = start + word.length;
      while (after < input.length && /[^\S\r\n]|[.,;:!?)\]]/.test(input[after]!)) after++;
      return !/["'`]/.test(input[before] ?? "") && !/["'`]/.test(input[after] ?? "")
        && prose.length < 20 && /^[A-Za-z][a-z]*(?:-[a-z]+)?$/.test(prose)
        ? match : "Bearer [REDACTED]";
    })
    .replace(/Basic\s+([A-Za-z0-9+/=]+)/gi, (match, encoded: string) => {
      try {
        // Only redact an actual RFC 7617 credential. Ordinary prose such as
        // “Basic API” must remain readable.
        const decoded = Buffer.from(encoded, "base64").toString("utf8");
        return decoded.includes(":") ? "Basic [REDACTED]" : match;
      } catch {
        return match;
      }
    });
  // A long ordinary tool-output word otherwise causes a quadratic failed
  // scheme search. The literal is required by the same regex, so this guard
  // changes no redaction result and keeps bounded Pi display previews cheap.
  const urls = sanitized.includes("://")
    ? sanitized.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    : sanitized;
  return urls.replace(
      /([?&](?:api[_-]?key|token|secret|password)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["'](?:api[_-]?key|token|secret|password|authorization)["']\s*:\s*["'])[^"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /((?:[A-Z][A-Z0-9]*_)+API_KEY)=[^\s]+/g,
      "$1=[REDACTED]",
    );
}
