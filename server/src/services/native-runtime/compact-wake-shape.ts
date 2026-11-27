// Validate BEFORE the lossy wake normalizer. A compact turn may omit known
// historical context, but never unknown nested meaning or a new value shape.
type Check = (value: unknown) => boolean;
const string: Check = value => typeof value === "string";
const boolean: Check = value => typeof value === "boolean";
const number: Check = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullable = (check: Check): Check => value => value == null || check(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const object = (fields: Record<string, Check>): Check => value => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.entries(value).every(([key, entry]) => Object.hasOwn(fields, key) && fields[key]!(entry));
// These values are emitted verbatim as event data, not normalized projections.
const json: Check = value => value === null || typeof value === "string" || typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) ? value.every(json) :
    !!value && typeof value === "object" && Object.values(value).every(entry => entry === undefined || json(entry)));
// Opaque event data is safe only when rendered in its entirety. Large events
// take the full path instead of being truncated into an apparently complete wake.
const compactJson: Check = value => json(value) && Buffer.byteLength(JSON.stringify(value) ?? "") <= 8192;
const text = nullable(string);
const absent: Check = value => value == null;
const emptyArray: Check = value => Array.isArray(value) && value.length === 0;
const sourceTrustObject = object({
  preset: value => value === "standard" || value === "low_trust_review",
  disposition: value => value === "quarantined" || value === "promoted",
  sourceIssueId: text, sourceRunId: text, sourceAgentId: text,
  promotedFrom: nullable(object({ artifactKind: value => ["issue", "comment", "document", "work_product"].includes(String(value)),
    artifactId: string, issueId: text })),
  promotedByActorType: nullable(value => ["agent", "user", "system"].includes(String(value))),
  promotedByActorId: text, promotedAt: text,
});
const sourceTrust: Check = value => string(value) || (sourceTrustObject(value) && compactJson(value) &&
  typeof (value as Record<string, unknown>).preset === "string" && typeof (value as Record<string, unknown>).disposition === "string");
const message = object({ id: string, body: string, authorType: string, authorId: text, createdByRunId: text,
  // Stock issue_comments.sourceTrust is jsonb. Keep bounded metadata intact in
  // the short renderer too, rather than rejecting every object-shaped receipt.
  createdAt: string, updatedAt: string, deleted: boolean,
  sourceTrust: nullable(sourceTrust),
  freshSessionMarker: value => value === true });
const messages: Check = value => array(entry => message(entry) && typeof (entry as Record<string, unknown>).id === "string" &&
  typeof (entry as Record<string, unknown>).body === "string")(value);
const continuation = object({
  version: value => value === 1, companyId: string, issueId: string,
  trigger: object({ reason: string, interactionId: text, sourceRunId: text, retriedReason: string }),
  originCommentIds: array(string), objective: string,
  objectiveSource: object({ kind: value => ["comment", "description", "title"].includes(String(value)), id: string, revision: text }),
  messages, resumeDelta: object({ baseRunId: string, messages }),
  humanResponses: array(object({ id: string, kind: string, status: string, resolvedByUserId: string, resolvedAt: string, result: json })),
  // These are cumulative historical receipts, not this wake's new events.
  // The stock producer includes them after ordinary mutations/answered questions.
  interactionOutcomes: array(json), recoveryOutcomes: array(json), completedActions: array(json), recoveredFiles: array(json),
  priorWorkspace: absent, interruptedRunId: absent, completedWork: text,
  unresolvedInteractionIds: value => Array.isArray(value) && value.length === 0,
  coverage: object({ kind: value => ["full_task_history", "task_history_delta"].includes(String(value)),
    baseRunId: string, throughCommentId: text, summaryThroughCommentId: value => value === null }),
});
const issue = object({ id: text, identifier: text, title: text, description: text, descriptionTruncated: boolean,
  workMode: text, status: text, priority: text });
const comment = object({ id: text, issueId: text, body: string, fullBody: string, bodyTruncated: boolean, createdAt: text,
  author: object({ type: text, id: text }), readByEarlierTurn: boolean, attachments: emptyArray });
const fields: Record<string, Check> = {
  reason: text, executionContinuation: nullable(continuation), issue: nullable(issue), commentIds: array(string), latestCommentId: text,
  comments: array(comment), commentWindow: object({ requestedCount: number, includedCount: number, missingCount: number }),
  requestedCount: number, includedCount: number, missingCount: number, truncated: boolean, fallbackFetchNeeded: boolean,
  attachmentOmissions: emptyArray,
  githubReviewConfigurations: array(value => object({ key: value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    instructions: value => typeof value === "string" && value.trim().length > 0 })(value) && Object.keys(value as object).length === 2),
  childIssueSummaries: array(object({ id: text, identifier: text, title: text, status: text, priority: text, summary: text })),
  childIssueSummaryTruncated: boolean, checkedOutByHarness: boolean, externalChatExecutionBound: boolean,
  externalChatProvider: nullable(value => value === "slack" || value === "github"),
  simplifiedEnglishInteractions: boolean, externalInteractionContinuation: boolean, dependencyBlockedInteraction: boolean,
  treeHoldInteraction: boolean, interactionId: text, interactionKind: text, interactionStatus: text, sourceRunId: text,
  unresolvedBlockerIssueIds: value => Array.isArray(value) && value.length === 0,
  unresolvedBlockerSummaries: emptyArray,
  reviewDecision: compactJson, notificationReason: compactJson, retryCause: compactJson, retrySummary: compactJson, unblockAction: compactJson, monitor: compactJson,
};
// All of these have dedicated full-prompt renderers; even malformed nonempty
// values must decline compact rather than normalize to null/false/[] and vanish.
for (const key of ["chatCompletionUpdates", "externalChatQuestionResponse", "recovery", "agentMessage", "blockerStall",
  "dispositionRepair", "livenessContinuation", "checkboxSelection", "questionResponse", "activeTreeHold", "executionStage",
  "taskWatchdog", "skillTest", "continuationSummary", "annotationDeltas", "planReviewContext", "documentReviewContext",
  "executionWorkspace", "mcpAppContext", "extraContext"]) fields[key] = absent;
fields.annotationDeltas = emptyArray;
fields.skillTest = value => value == null || value === false;
// The real wake builder uses parseObject for an absent hold, emitting {}.
fields.activeTreeHold = value => absent(value) || (!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

export function hasCompactWakeShape(value: unknown): boolean {
  return object(fields)(value);
}
