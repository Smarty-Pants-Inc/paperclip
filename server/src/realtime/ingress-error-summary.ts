export const RUNNER_INGRESS_REASON_CODES = [
  "runner_ingress_unavailable",
  "runner_ingress_auth_failed",
  "runner_ingress_upgrade_rejected",
] as const;

const runnerIngressReasonCodeSet = new Set<string>(RUNNER_INGRESS_REASON_CODES);

const NODE_ERRNO_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED", "EPROTO", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
]);
const SYSCALLS = new Set(["connect", "getaddrinfo", "read", "write"]);

export function allowlistedIngressReason(message: string): string | null {
  return runnerIngressReasonCodeSet.has(message) ? message : null;
}

export function allowlistedErrnoCode(value: unknown): string {
  return typeof value === "string" && NODE_ERRNO_CODES.has(value) ? value : "other";
}

export function allowlistedSyscall(value: unknown): string {
  return typeof value === "string" && SYSCALLS.has(value) ? value : "other";
}

export function finiteSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
