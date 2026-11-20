/*! @license Gitleaks provider-prefix rules — MIT License
 * Copyright (c) 2019 Zachary Rice
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Provider-prefix subset of Gitleaks' DEFAULT rules, MIT licensed.
 * https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml
 * Checked 2026-11-19; source SHA-256:
 * e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf
 *
 * Refresh from that file at the current release tag, retaining rule IDs and
 * regex line numbers. These are the upstream patterns, not entropy heuristics.
 * Go inline case flags are translated to JS flags or explicit ASCII ranges.
 * Keep more specific overlapping formats (notably routable GitLab) first.
 * Keep the upstream delimiter outside the mask: replacing the whole match can
 * consume a newline or quote and skip the next credential in the same string.
 *
 * This leaf has no imports. Server and Runner use the same built subpath to
 * avoid Runner rootDir leakage; the command helper imports this source locally.
 * Verified provider entrypoints bundle it without SDK/credential imports.
 * Only the format rules/keywords are adopted: scanner entropy thresholds and
 * repository allowlists do not authorize revealing a format-recognizable key.
 */
export const PROVIDER_PREFIX_RULE_SOURCE = {
  tag: "v8.30.1",
  sha256: "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf",
  url: "https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml",
} as const;

interface ProviderPrefixRule {
  id: string;
  sourceLine: number;
  pattern: RegExp;
  secretGroup: 0 | 1;
  keywords: readonly string[];
}

export const PROVIDER_PREFIX_RULES: readonly ProviderPrefixRule[] = [
  { id: "openai-api-key", sourceLine: 2706,
    pattern: new RegExp("\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["t3blbkfj"] },
  { id: "anthropic-api-key", sourceLine: 152,
    pattern: new RegExp("\\b(sk-ant-api03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["sk-ant-api03"] },
  { id: "anthropic-admin-api-key", sourceLine: 146,
    pattern: new RegExp("\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["sk-ant-admin01"] },
  { id: "github-pat", sourceLine: 2161,
    pattern: new RegExp("ghp_[0-9a-zA-Z]{36}", "g"), secretGroup: 0, keywords: ["ghp_"] },
  { id: "github-oauth", sourceLine: 2154,
    pattern: new RegExp("gho_[0-9a-zA-Z]{36}", "g"), secretGroup: 0, keywords: ["gho_"] },
  { id: "github-app-token", sourceLine: 2133,
    pattern: new RegExp("(?:ghu|ghs)_[0-9a-zA-Z]{36}", "g"), secretGroup: 0, keywords: ["ghu_", "ghs_"] },
  { id: "github-fine-grained-pat", sourceLine: 2147,
    pattern: new RegExp("github_pat_\\w{82}", "g"), secretGroup: 0, keywords: ["github_pat_"] },
  { id: "github-refresh-token", sourceLine: 2172,
    pattern: new RegExp("ghr_[0-9a-zA-Z]{36}", "g"), secretGroup: 0, keywords: ["ghr_"] },
  { id: "aws-access-token", sourceLine: 208,
    pattern: new RegExp("\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b", "g"), secretGroup: 1, keywords: ["a3t", "akia", "asia", "abia", "acca"] },
  { id: "slack-config-access-token", sourceLine: 2980,
    pattern: new RegExp("xoxe.xox[bp]-\\d-[A-Z0-9]{163,166}", "gi"), secretGroup: 0, keywords: ["xoxe.xoxb-", "xoxe.xoxp-"] },
  { id: "slack-config-refresh-token", sourceLine: 2990,
    pattern: new RegExp("xoxe-\\d-[A-Z0-9]{146}", "gi"), secretGroup: 0, keywords: ["xoxe-"] },
  { id: "slack-app-token", sourceLine: 2966,
    pattern: new RegExp("xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+", "gi"), secretGroup: 0, keywords: ["xapp"] },
  { id: "slack-bot-token", sourceLine: 2973,
    pattern: new RegExp("xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*", "g"), secretGroup: 0, keywords: ["xoxb"] },
  { id: "slack-user-token", sourceLine: 3024,
    pattern: new RegExp("xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}", "g"), secretGroup: 0, keywords: ["xoxp-", "xoxe-"] },
  { id: "slack-legacy-bot-token", sourceLine: 2997,
    pattern: new RegExp("xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}", "g"), secretGroup: 0, keywords: ["xoxb"] },
  { id: "slack-legacy-token", sourceLine: 3004,
    pattern: new RegExp("xox[os]-\\d+-\\d+-\\d+-[a-fA-F\\d]+", "g"), secretGroup: 0, keywords: ["xoxo", "xoxs"] },
  { id: "slack-legacy-workspace-token", sourceLine: 3014,
    pattern: new RegExp("xox[ar]-(?:\\d-)?[0-9a-zA-Z]{8,48}", "g"), secretGroup: 0, keywords: ["xoxa", "xoxr"] },
  { id: "gcp-api-key", sourceLine: 614,
    pattern: new RegExp("\\b(AIza[\\w-]{35})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["aiza"] },
  { id: "gitlab-pat-routable", sourceLine: 2235,
    pattern: new RegExp("\\bglpat-[0-9a-zA-Z_-]{27,300}\\.[0-9a-z]{2}[0-9a-z]{7}\\b", "g"), secretGroup: 0, keywords: ["glpat-"] },
  { id: "gitlab-pat", sourceLine: 2228,
    pattern: new RegExp("glpat-[\\w-]{20}", "g"), secretGroup: 0, keywords: ["glpat-"] },
  { id: "stripe-access-token", sourceLine: 3079,
    pattern: new RegExp("\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["sk_test", "sk_live", "sk_prod", "rk_test", "rk_live", "rk_prod"] },
  { id: "huggingface-access-token", sourceLine: 2366,
    pattern: new RegExp("\\b(hf_[a-zA-Z]{34})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["hf_"] },
  { id: "huggingface-organization-api-token", sourceLine: 2373,
    pattern: new RegExp("\\b(api_org_[a-zA-Z]{34})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["api_org_"] },
  { id: "npm-access-token", sourceLine: 2661,
    pattern: new RegExp("\\b(npm_[a-z0-9]{36})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "gi"), secretGroup: 1, keywords: ["npm_"] },
  { id: "sendgrid-api-token", sourceLine: 2857,
    pattern: new RegExp("\\b(SG\\.[a-zA-Z0-9=_\\-\\.]{66})(?:[\\x60'\"\\s;]|\\\\[nr]|$)", "g"), secretGroup: 1, keywords: ["sg."] },
  { id: "twilio-api-key", sourceLine: 3119,
    pattern: new RegExp("SK[0-9a-fA-F]{32}", "g"), secretGroup: 0, keywords: ["sk"] },
];

/** Mask format-recognizable provider keys, regardless of field name or run registration. */
export function redactProviderKeys(input: string, replacement: string): string {
  const lower = input.toLowerCase();
  let result = input;
  for (const rule of PROVIDER_PREFIX_RULES) {
    if (!rule.keywords.some(keyword => lower.includes(keyword))) continue;
    result = result.replace(rule.pattern, (match: string, firstCapture: string | number) => {
      const secret = rule.secretGroup === 1 ? String(firstCapture) : match;
      return replacement + match.slice(secret.length);
    });
  }
  return result;
}
