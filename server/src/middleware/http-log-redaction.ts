// Key names whose value is a credential whatever its shape. ONE list for both
// layers: the logger's walker masks the value under any of these names, at any
// depth and of any type (logger.ts, sensitiveLogKey), and the request-header
// redact paths below are built from it. Matched case-insensitively against the
// WHOLE key, with "-" and "_" treated alike: "X_API_KEY" and "Client-Secret"
// match; "token_count", "secretary", "passwordPolicy" and "authorizationUrl" do
// not. The same idea as Pino's own redact paths, applied by name.
export const SENSITIVE_LOG_KEY_NAMES = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "password",
  "passwd",
  "secret",
  "client-secret",
  "client_secret",
  "private-key",
  "private_key",
  "access-token",
  "access_token",
  "refresh-token",
  "refresh_token",
] as const;

// `req.headers.cookie` for a plain identifier, `req.headers["set-cookie"]` else.
// Incoming header names are lower-case, and every name above is.
function requestHeaderPath(name: string): string {
  return /^[a-z_$][a-z0-9_$]*$/.test(name) ? `req.headers.${name}` : `req.headers[${JSON.stringify(name)}]`;
}

export const HTTP_LOG_REDACT_PATHS = [
  // authorization, proxy-authorization, x-api-key, cookie, set-cookie, ...
  ...SENSITIVE_LOG_KEY_NAMES.map(requestHeaderPath),
  'req.headers["x-paperclip-source-run-token"]',
  "res.headers.location",
  // "set-cookie" is normally a response header (the request-side path, from
  // the list above, is defensive coverage in case a proxy forwards it inbound).
  'res.headers["set-cookie"]',
  // Credential- and session-paired headers with no debugging value.
  'req.headers["x-csrf-token"]',
  'req.headers["x-xsrf-token"]',
  // Cloud proxy credentials and signed assertions authorize tenant access.
  'req.headers["x-paperclip-cloud-tenant-token"]',
  'req.headers["x-paperclip-cloud-session-id"]',
  'req.headers["x-paperclip-cloud-runtime-identity"]',
  'req.headers["x-paperclip-cloud-control"]',
  'req.headers["x-paperclip-cloud-inspection"]',
  // Runtime GitHub capabilities authorize credential acquisition for a live run.
  'req.headers["x-paperclip-github-capability"]',
  'req.headers["x-paperclip-runner-scope-token"]',
  // Telegram's optional webhook verification header is a reusable bearer
  // secret sent on every provider callback.
  'req.headers["x-telegram-bot-api-secret-token"]',
  // The structured failure logger adds a sanitized request-body copy under
  // `reqBody`. Keep the standard connector credential envelope covered again
  // at the final serialization boundary in case a future custom serializer
  // bypasses the recursive redactor.
  "reqBody.credentials",
  // The app-connect/reconnect body groups every provider credential under
  // `credentialValues`: a map of provider config paths
  // (`credentials.authorization`, `headers.X-Api-Key`) to the secret string for
  // each. The key names are chosen by the caller, so no fixed list of leaf
  // names can cover them. Redact the whole envelope instead.
  "reqBody.credentialValues",
  "errorContext.details.credentialValues",
  "errorContext.details.credentials",
] as const;
