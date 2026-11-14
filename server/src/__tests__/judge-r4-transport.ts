// Judge-owned transport harness. Real publication attempt lease, source authorization,
// cancellation, receipt transaction and message links; only provider/credential I/O
// and unrelated provider-specific policy are controlled. Never contacts a provider.
import { and, eq, inArray } from "drizzle-orm";
import { chatEndpoints, chatPublications, type Db } from "@paperclipai/db";
import { createChatPublicationWorker } from "../services/chat-channels/publications/worker.js";
import { createChatPublicationAuthorization } from "../services/chat-channels/publications/authorization.js";

export async function publishPending(db: Db, publicationId: string, concurrent = false) {
  const [publication] = await db.select().from(chatPublications).where(and(
    eq(chatPublications.id, publicationId), inArray(chatPublications.state, ["pending", "retry"])));
  const sends: string[] = [];
  const errors: string[] = [];
  if (!publication) return { sends, errors };
  const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, publication.endpointId));
  const runtimeContext = { generation: 0, credentialFingerprint: "judge-no-credentials" };
  const yes = async () => true;
  const no = async () => false;
  const nil = async () => null;
  const noop = async () => {};
  const authorization = createChatPublicationAuthorization(db, {
    authorizeInboundWakePublication: yes, authorizeRetainedChatSourcePublication: yes,
    fetchImpl: async () => { throw new Error("judge forbids network"); },
    githubCurrentOmissionPreparedText: nil, hasCommittedTaskControlCompletion: no,
    lockCurrentPrincipalAuthorization: async () => ({ allowed: true }),
    nonDirectDestinationAllowed: () => true,
    resolveCredentials: async () => { throw new Error("judge forbids credentials"); },
    runtimeCallbackEndpoint: async (tx, id) => (await tx.select().from(chatEndpoints).where(eq(chatEndpoints.id,id)))[0] ?? null,
    FailedChatRetryPublicationReadError: Error,
  });
  const options = {
    CAPABILITIES: { telegram: { messageEdits: false } },
    authorizeRetainedChatSourcePublication: yes,
    claimPublicationTransportAuthorization: authorization.claimPublicationTransportAuthorization,
    commitTaskControlCompletion: noop, currentTaskControlPayload: async (p: typeof publication) => p.payload,
    endpointRecord: async () => ({ endpoint }), ensureDurablePublicationTransport: async (p: typeof publication) => p,
    finalizePublicationFailure: async (_p: unknown, e: unknown) => { errors.push(String(e)); },
    hasCommittedTaskControlCompletion: no, hasTelegramStopSubscription: no,
    nonDirectDestinationAllowed: () => true,
    postSafePublication: async ({ payload }: {payload: {text?: string}}) => {
      sends.push(payload.text ?? ""); return { id: `judge-message-${publication.id}` };
    },
    processReceiptReaction: noop, recordSlackFileUploadReceipt: nil,
    redactError: String, reserveTelegramPublicationDraft: nil,
    runtimeContextForRecord: () => runtimeContext,
    scheduleMessageProcessing: () => { throw new Error("unexpected asynchronous work"); },
    settleGitHubAutomaticPublication: no, stageSlackFilePublicationSuccess: noop,
    tryProcessTeamsFilePublication: no,
    withCredentialMutationLease: async (_endpoint: unknown, fn: (guard: {assertOwned: () => Promise<void>}) => Promise<void>) => fn({assertOwned: noop}),
    runOwnershipMilestoneSupersessionReason: nil, runPublicationToReplace: nil,
    receiptReactionCompletionRunId: nil, inboundWakePublicationToReplace: nil,
    interactionResolutionPublicationToReplace: nil, interactionPromptPublicationToReplace: nil,
    progressSupersededByFastResponse: no, runProgressSupersededByPublishedInteraction: no,
    taskStatusPublicationToReplace: nil, closeProgressToReplace: nil,
  } as unknown as Parameters<typeof createChatPublicationWorker>[1];
  const worker = createChatPublicationWorker(db, options);
  if (concurrent) await Promise.all([worker.processSelectedPublication(publication), worker.processSelectedPublication(publication)]);
  else await worker.processSelectedPublication(publication);
  return { sends, errors };
}
