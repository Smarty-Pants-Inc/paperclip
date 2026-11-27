/** Shared by saved-result projection and turn budgeting. Keep this dependency
 * free: the budget is also loaded before the execution service graph. */
export const continuationResultIdentityKeys = ["id", "companyId", "issueId", "key", "latestRevisionId", "latestRevisionNumber",
  "identifier", "status", "statusVersion", "createdAt", "updatedAt", "number", "name", "title", "url"] as const;
