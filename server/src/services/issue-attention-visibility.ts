import { and, eq, inArray, or } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { IssueBlockerAttention, IssueBlockedInboxAttention, IssueBlockedInboxIssueRef } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "./authorization.js";

type AttentionRow = {
  id: string;
  blockerAttention?: IssueBlockerAttention | null;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Viewer projection only: attention is computed without a viewer and may be shared. */
export function issueAttentionVisibilityService(db: Db) {
  const access = authorizationService(db);

  async function redactRows<T extends AttentionRow>(actor: AuthorizationActor, companyId: string, rows: T[]): Promise<T[]> {
    const ids = new Set<string>();
    const samples = new Set<string>();
    const addId = (id: string | null | undefined) => { if (id && uuid.test(id)) ids.add(id); };
    const addSample = (sample: string | null | undefined) => { if (sample) samples.add(sample); };
    for (const row of rows) {
      const blocker = row.blockerAttention;
      if (blocker) {
        addId(blocker.terminalBlocker?.id);
        addId(blocker.directBlockerIssueId);
        addId(blocker.terminalBlockerIssueId);
        blocker.pendingFinalizeBlockerIssueIds?.forEach(addId);
        // These can be samples from DIFFERENT chains, not the terminal summary.
        addSample(blocker.sampleBlockerIdentifier);
        addSample(blocker.sampleStalledBlockerIdentifier);
      }
      const inbox = row.blockedInboxAttention;
      if (inbox) {
        [inbox.sourceIssue, inbox.leafIssue, inbox.recoveryIssue].forEach(ref => addId(ref?.id));
        // A source-only fallback can still name an entirely different hidden leaf.
        addSample(inbox.sampleIssueIdentifier);
      }
    }
    if (!rows.some(row => row.blockerAttention || row.blockedInboxAttention)) return rows;
    for (const sample of samples) if (uuid.test(sample)) ids.add(sample);
    const selection = {
      id: issues.id, identifier: issues.identifier, title: issues.title,
      companyId: issues.companyId, projectId: issues.projectId, parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      status: issues.status, priority: issues.priority,
    };
    type Reference = { [K in keyof typeof selection]: (typeof issues.$inferSelect)[K] };
    const references: Reference[] = [];
    const idList = [...ids], sampleList = [...samples];
    // Bound SQL parameter counts without splitting authorization into per-row calls.
    for (let offset = 0; offset < Math.max(idList.length, sampleList.length); offset += 500) {
      const idChunk = idList.slice(offset, offset + 500), sampleChunk = sampleList.slice(offset, offset + 500);
      references.push(...await db.select(selection).from(issues).where(and(
        eq(issues.companyId, companyId),
        or(idChunk.length ? inArray(issues.id, idChunk) : undefined,
          sampleChunk.length ? inArray(issues.identifier, sampleChunk) : undefined),
      )));
    }
    const unique = [...new Map(references.map(ref => [ref.id, ref])).values()];
    const decisions = unique.length ? await access.decideReads(actor, unique.map(ref => ({
      type: "issue" as const, companyId: ref.companyId, issueId: ref.id,
      projectId: ref.projectId, parentIssueId: ref.parentId,
      assigneeAgentId: ref.assigneeAgentId, assigneeUserId: ref.assigneeUserId, status: ref.status,
    }))) : [];
    const readable = new Map(unique.filter((_, index) => decisions[index]?.allowed).map(ref => [ref.id, ref]));
    // Resolve samples against ALL matches before checking permission: ambiguity fails closed.
    const byToken = new Map<string, Reference | null>();
    for (const ref of unique) for (const token of [ref.id, ref.identifier]) {
      if (token) byToken.set(token, byToken.has(token) && byToken.get(token)?.id !== ref.id ? null : ref);
    }
    const allowedId = (id: string | null | undefined) => id ? readable.get(id) : undefined;
    const allowedSample = (token: string | null | undefined) => {
      const ref = token ? byToken.get(token) : null;
      return ref && readable.has(ref.id) ? token! : null;
    };
    const projectRef = (ref: IssueBlockedInboxIssueRef | null): IssueBlockedInboxIssueRef | null => {
      const known = allowedId(ref?.id);
      return known ? {
        id: known.id, identifier: known.identifier, title: known.title,
        status: known.status as IssueBlockedInboxIssueRef["status"],
        priority: known.priority as IssueBlockedInboxIssueRef["priority"],
        assigneeAgentId: known.assigneeAgentId, assigneeUserId: known.assigneeUserId,
      } : null;
    };
    return rows.map(row => {
      const blocker = row.blockerAttention, inbox = row.blockedInboxAttention;
      const terminal = allowedId(blocker?.terminalBlocker?.id);
      const refs = inbox ? [inbox.sourceIssue, inbox.leafIssue, inbox.recoveryIssue].filter(ref => ref != null) : [];
      const sampleRef = inbox?.sampleIssueIdentifier ? byToken.get(inbox.sampleIssueIdentifier) : null;
      // A source-only fallback to the root does not prove a leaf-derived owner/detail.
      const dependentProven = inbox && (inbox.leafIssue || inbox.recoveryIssue
        || (sampleRef && sampleRef.id !== inbox.sourceIssue?.id));
      const provenanceVisible = inbox && dependentProven && refs.length > 0 && refs.every(ref => allowedId(ref.id))
        && (!inbox.sampleIssueIdentifier || allowedSample(inbox.sampleIssueIdentifier) !== null);
      return {
        ...row,
        ...(blocker ? { blockerAttention: {
          // Explicit allow-lists: new attention fields must not become visible by default.
          state: blocker.state, reason: blocker.reason,
          unresolvedBlockerCount: blocker.unresolvedBlockerCount, coveredBlockerCount: blocker.coveredBlockerCount,
          stalledBlockerCount: blocker.stalledBlockerCount, attentionBlockerCount: blocker.attentionBlockerCount,
          ...(blocker.blockingTreeLive !== undefined ? { blockingTreeLive: blocker.blockingTreeLive } : {}),
          terminalBlocker: terminal ? { id: terminal.id, identifier: terminal.identifier, title: terminal.title } : null,
          directBlockerIssueId: allowedId(blocker.directBlockerIssueId)?.id ?? null,
          terminalBlockerIssueId: allowedId(blocker.terminalBlockerIssueId)?.id ?? null,
          ...(blocker.pendingFinalizeBlockerIssueIds ? {
            pendingFinalizeBlockerIssueIds: blocker.pendingFinalizeBlockerIssueIds.filter(id => allowedId(id)),
          } : {}),
          sampleBlockerIdentifier: allowedSample(blocker.sampleBlockerIdentifier),
          sampleStalledBlockerIdentifier: allowedSample(blocker.sampleStalledBlockerIdentifier),
        } satisfies IssueBlockerAttention } : {}),
        ...(inbox ? { blockedInboxAttention: {
          kind: inbox.kind, state: inbox.state, reason: inbox.reason, severity: inbox.severity,
          sourceIssue: projectRef(inbox.sourceIssue),
          leafIssue: projectRef(inbox.leafIssue),
          recoveryIssue: projectRef(inbox.recoveryIssue),
          sampleIssueIdentifier: allowedSample(inbox.sampleIssueIdentifier),
          owner: {
            type: provenanceVisible ? inbox.owner.type : "unknown",
            agentId: provenanceVisible ? inbox.owner.agentId : null,
            userId: provenanceVisible ? inbox.owner.userId : null,
            label: provenanceVisible ? inbox.owner.label : null,
          },
          // issues.ts builds labels from fixed literals; only detail may contain task text.
          action: { label: inbox.action.label, detail: provenanceVisible ? inbox.action.detail : null },
          stoppedSinceAt: provenanceVisible ? inbox.stoppedSinceAt : null,
          approvalId: provenanceVisible ? inbox.approvalId : null,
          interactionId: provenanceVisible ? inbox.interactionId : null,
          redaction: {
            externalDetailsRedacted: inbox.redaction.externalDetailsRedacted,
            secretFieldsOmitted: inbox.redaction.secretFieldsOmitted,
          },
        } satisfies IssueBlockedInboxAttention } : {}),
      };
    });
  }
  return { redactRows };
}
