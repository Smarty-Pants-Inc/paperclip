/** Closed vocabulary at every log/job boundary. Never forward provider text. */
export enum G12ErrorCode {
  AppSignFailed = "G12_APP_SIGN_FAILED",
  CompanyBindingMismatch = "G12_COMPANY_BINDING_MISMATCH",
  ConfigInvalid = "G12_CONFIG_INVALID",
  ConfigUnknownField = "G12_CONFIG_UNKNOWN_FIELD",
  ConfigIdentity = "G12_CONFIG_IDENTITY",
  ConfigSecretRef = "G12_CONFIG_SECRET_REF",
  ConfigRepos = "G12_CONFIG_REPOS",
  ConfigDuplicateRepo = "G12_CONFIG_DUPLICATE_REPO",
  ConfigMinutes = "G12_CONFIG_MINUTES",
  ConfigGetLimit = "G12_CONFIG_GET_LIMIT",
  ConfigOwners = "G12_CONFIG_OWNERS",
  ConfigOwner = "G12_CONFIG_OWNER",
  ConfigDuplicateOwner = "G12_CONFIG_DUPLICATE_OWNER",
  ConfigConflictingIssueOwner = "G12_CONFIG_CONFLICTING_ISSUE_OWNER",
  FirstSeenInvalid = "G12_FIRST_SEEN_INVALID",
  GitHubResponseInvalid = "G12_GITHUB_RESPONSE_INVALID",
  GitHubTransportFailed = "G12_GITHUB_TRANSPORT_FAILED",
  GitHubHttp401 = "G12_GITHUB_HTTP_401",
  GitHubHttp403 = "G12_GITHUB_HTTP_403",
  GitHubHttp404 = "G12_GITHUB_HTTP_404",
  GitHubHttp422 = "G12_GITHUB_HTTP_422",
  GitHubHttp500 = "G12_GITHUB_HTTP_500",
  GitHubHttpFailed = "G12_GITHUB_HTTP_FAILED",
  HttpOriginDenied = "G12_HTTP_ORIGIN_DENIED",
  IssueAssigneeMismatch = "G12_ISSUE_ASSIGNEE_MISMATCH",
  IssueReadFailed = "G12_ISSUE_READ_FAILED",
  JobAlreadyRunning = "G12_JOB_ALREADY_RUNNING",
  JobFailed = "G12_JOB_FAILED",
  ScanPaused = "G12_SCAN_PAUSED",
  ScanStateInvalid = "G12_SCAN_STATE_INVALID",
  TickFailed = "G12_TICK_FAILED",
  WakeFailed = "G12_WAKE_FAILED",
  WakeRefused = "G12_WAKE_REFUSED",
  WakeReceiptInvalid = "G12_WAKE_RECEIPT_INVALID",
}

const codes = new Set<string>(Object.values(G12ErrorCode));
export function errorCode(error: unknown, fallback: G12ErrorCode): G12ErrorCode {
  return error instanceof Error && codes.has(error.message) ? error.message as G12ErrorCode : fallback;
}
