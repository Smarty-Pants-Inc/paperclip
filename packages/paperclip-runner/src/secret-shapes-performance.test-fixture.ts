const mb = 1024 * 1024;
const fill = (unit: string) => unit.repeat(Math.ceil(mb / unit.length)).slice(0, mb);

// Include failed matches, not just successfully recognized secrets. Each case
// exercises an unbounded run (or a repeated retry point) in the pattern table.
export const secretShapePerformanceInputs = [
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
