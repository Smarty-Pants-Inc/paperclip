/** Shared result rules for saved-result projection and turn budgeting. Keep
 * this dependency free: the budget loads before the execution service graph. */
export const continuationResultIdentityKeys = ["id", "companyId", "issueId", "key", "latestRevisionId", "latestRevisionNumber",
  "identifier", "status", "statusVersion", "createdAt", "updatedAt", "number", "name", "title", "url"] as const;

/** Error fields at any depth make a write unsafe to shorten, even when empty.
 * Walk arrays too: an envelope's success does not prove every bulk item saved.
 * Use an iterative walk so deeply nested JSON cannot exhaust the call stack. */
export function continuationResultHasError(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (next === null || typeof next !== "object") continue;
    if (Object.hasOwn(next, "error") || Object.hasOwn(next, "errors")) return true;
    for (const child of Object.values(next)) if (child !== null && typeof child === "object") pending.push(child);
  }
  return false;
}
