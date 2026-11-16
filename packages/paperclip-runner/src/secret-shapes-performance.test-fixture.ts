const mb = 1024 * 1024;

// Include failed matches and repeated restart points, not just recognized values.
// Parameterize the same corpus at 1 and 4 MiB (prefix/suffix bytes are additional).
export function secretShapePerformanceInputsAt(bytes: number) {
  const fill = (unit: string) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  const original = [
    { name: "quoted key name without closing quote", text: `"${fill("key")}` },
    { name: "shell key name without equals", text: fill("key") },
    { name: "dotted secret name without equals", text: fill("a.key.") },
    { name: "oversized BEGIN label", text: `-----BEGIN ${fill("PRIVATE ")}KEY-----` },
    { name: "oversized END label", text: `-----END ${fill("PRIVATE ")}KEY-----` },
    { name: "many incomplete BEGIN markers", text: fill("-----BEGIN PRIVATE KEY-----\n") },
    { name: "PEM body with no END", text: `-----BEGIN PRIVATE KEY-----\n${fill("A")}` },
    { name: "base64 lines before unmatched END", text: `${fill(`${"A".repeat(76)}\n`)}-----END PRIVATE KEY-----` },
    { name: "separator run before END", text: `${"A".repeat(32)}${fill(" \n\\n")}-----END PRIVATE KEY-----` },
    { name: "JSON whitespace without colon", text: `"KEY"${fill(" \n")}` },
    { name: "shell whitespace without equals", text: `KEY${fill(" \t")}` },
    { name: "unterminated escaped JSON value", text: `"KEY": "${fill("\\x")}` },
    { name: "unterminated single quoted value", text: `KEY='${fill("x")}` },
    { name: "unquoted assignment value", text: `KEY=${fill("x")}` },
    { name: "GitHub token", text: `ghp_${fill("a")}` },
    { name: "Langfuse token", text: `sk-lf-${fill("a_")}` },
    { name: "Anthropic token", text: `sk-ant-${fill("a_")}` },
    { name: "OpenAI token", text: `sk-${fill("a_")}` },
    { name: "Slack token", text: `xoxb-${fill("a-")}` },
    { name: "JWT without second dot", text: `eyJ${fill("a")}.b` },
    { name: "JWT long middle without final segment", text: `eyJa.${fill("a")}.` },
    { name: "Bearer whitespace without token", text: `Bearer${fill(" \t")}` },
    { name: "Bearer token and padding", text: `Bearer ${fill("a=")}` },
    { name: "identity marks and short PEM lines", text: fill(`***REDACTED***\n${"A".repeat(36)}\n`) },
  ];
  const restart = [
    { name: "JWT repeated eyJ- without dot", text: fill("eyJ-") },
    { name: "JWT repeated eyJ- in unfinished middle", text: `eyJa.${fill("eyJ-")}` },
    { name: "GitHub repeated ghp_ below minimum", text: fill("ghp_-") },
    { name: "GitHub PAT repeated prefix", text: fill("github_pat_-") },
    { name: "Langfuse repeated sk-lf-", text: fill("sk-lf-") },
    { name: "Anthropic repeated sk-ant-", text: fill("sk-ant-") },
    { name: "OpenAI repeated sk-", text: fill("sk-") },
    { name: "Slack repeated xoxb-", text: fill("xoxb-") },
    { name: "AWS repeated incomplete AKIA", text: fill("AKIA-") },
    { name: "Bearer repeated prefix", text: fill("Bearer ") },
    { name: "long KEY names separated by punctuation", text: fill(`${"KEY".repeat(22)}!`) },
    { name: "unterminated quoted value with many KEY=", text: `KEY='${fill("KEY=")}` },
    { name: "identity mark and 31-character runs", text: `***REDACTED*** ${fill(`${"A".repeat(31)} `)}` },
    { name: "identity mark and escaped slash runs", text: `***REDACTED*** ${fill(String.raw`\/`.repeat(31) + " ")}` },
    { name: "identity mark and doubly escaped slash runs", text: `***REDACTED*** ${fill(String.raw`\\/`.repeat(31) + " ")}` },
    { name: "identity mark and lone backslashes", text: `***REDACTED***${fill("\\")}` },
  ];
  return [...original, ...restart, ...[...original, ...restart.slice(0, 12)].map(({ name, text }) => ({
    name: `identity prefix: ${name}`, text: `***REDACTED***\n${text}`,
  }))];
}

// N-1/N-3 shapes called out by the judge, in addition to the original corpus.
// Assignment-heavy scans have a separate, explicit linear-cost budget.
export function judgeSecretShapePerformanceInputsAt(bytes: number) {
  const fill = (unit: string) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  return [
    { name: "judge: identity mark with continuous escaped slashes", text: `***REDACTED***${fill(String.raw`\/`)}`, budgetMs: 100 },
    { name: "judge: identity mark with continuous base64", text: `***REDACTED***${fill("Ab9/")}`, budgetMs: 100 },
    { name: "judge: repeated identity marks and escaped body lines", text: fill(`***REDACTED***\\n${String.raw`Ab9\/`.repeat(9)}\\n`), budgetMs: 100 },
    { name: "judge: shell assignments with bounded overlapping KEY names", text: fill(`${"a".repeat(64)}KEY${"KEY".repeat(21)}='value'\n`), budgetMs: bytes / mb * 250 },
    { name: "judge: JSON assignments with bounded overlapping KEY names", text: fill(`"${"a".repeat(64)}KEY${"KEY".repeat(21)}": "value",\n`), budgetMs: bytes / mb * 250 },
    { name: "judge: repeated assignment-name near misses", text: fill(`${"KEY".repeat(43)}!\n`), budgetMs: bytes / mb * 250 },
    { name: "judge: dense shell assignments", text: fill("KEY=x;"), budgetMs: bytes / mb * 250 },
    { name: "judge: dense JSON assignments", text: fill('"KEY":"x",'), budgetMs: bytes / mb * 250 },
  ];
}

export const secretShapePerformanceInputs = secretShapePerformanceInputsAt(mb);
