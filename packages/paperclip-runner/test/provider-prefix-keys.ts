// Synthetic format-only canaries. Never use live credentials here.
// Keep reason: never-OK exposing a credential; catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21032
export const providerPrefixKeys = [
  ["openai-api-key", `sk-${"A".repeat(20)}T3BlbkFJ${"B".repeat(20)}`],
  ["openai-project", `sk-proj-${"A".repeat(74)}T3BlbkFJ${"B".repeat(74)}`],
  ["openai-service-account", `sk-svcacct-${"A".repeat(58)}T3BlbkFJ${"B".repeat(58)}`],
  ["anthropic-api-key", `sk-ant-api03-${"A".repeat(93)}AA`],
  ["anthropic-admin-api-key", `sk-ant-admin01-${"A".repeat(93)}AA`],
  ["github-pat", `ghp_${"A".repeat(36)}`],
  ["github-oauth", `gho_${"B".repeat(36)}`],
  ["github-app-token-user", `ghu_${"C".repeat(36)}`],
  ["github-app-token-server", `ghs_${"D".repeat(36)}`],
  ["github-fine-grained-pat", `github_pat_${"E".repeat(82)}`],
  ["github-refresh-token", `ghr_${"F".repeat(36)}`],
  ["aws-access-token", `AKIA${"A".repeat(16)}`],
  ["slack-bot-token", `xoxb-123456789012-123456789012-${"A".repeat(24)}`],
  ["slack-user-token", `xoxp-123456789012-123456789012-123456789012-${"A".repeat(32)}`],
  ["slack-app-token", `xapp-1-A1B2C3-123456789012-${"a".repeat(32)}`],
  ["slack-config-access-token", `xoxe.xoxb-1-${"A".repeat(163)}`],
  ["slack-config-refresh-token", `xoxe-1-${"A".repeat(146)}`],
  ["slack-legacy-bot-token", `xoxb-12345678-${"A".repeat(18)}`],
  ["slack-legacy-token", `xoxs-123-456-789-${"a".repeat(32)}`],
  ["slack-legacy-workspace-token", `xoxa-1-${"A".repeat(24)}`],
  ["gcp-api-key", `AIza${"A".repeat(35)}`],
  ["gitlab-pat", `glpat-${"A".repeat(20)}`],
  ["gitlab-pat-routable", `glpat-${"B".repeat(27)}.ab1234567`],
  ["stripe-access-token", `sk_test_${"A".repeat(24)}`],
  ["huggingface-access-token", `hf_${"A".repeat(34)}`],
  ["huggingface-organization-api-token", `api_org_${"B".repeat(34)}`],
  ["npm-access-token", `npm_${"A".repeat(36)}`],
  ["sendgrid-api-token", `SG.${"A".repeat(22)}.${"B".repeat(43)}`],
  ["twilio-api-key", `SK${"a".repeat(32)}`],
] as const;

// RFL's accepted residual: nine prose candidates after bare bearer are not credentials.
export const bearerProse = ["token", "tokens", "authentication", "authorization", "credential", "credentials", "scheme", "schemes", "flows"] as const;
export const bearerCredentials = ["abcdefgh", "live-provider-token", '"two word secret"', "'two word secret'", String.raw`\"two word secret\"`, 'abc"embedded-tail', '"abc"defg retry', String.raw`\"abc\"defg retry`] as const;
