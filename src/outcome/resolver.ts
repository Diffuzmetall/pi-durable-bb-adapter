import type { Context } from '@earendil-works/chord';
import type { ConversationId, SnapshotEvent, SubmissionRecord, TaskId, Tx } from '@earendil-works/pi-durable';

/** Trusted native execution identity, NOT a client-supplied authorization grant. */
export type OutcomeTarget = Readonly<{
  conversationId: ConversationId;
  parentConversationId: ConversationId;
  anchorTaskId: TaskId;
  requestId: string;
}>;
export type OutcomeRecords = Readonly<{
  conversation: Awaited<ReturnType<Tx['conversation']>>;
  submission: Awaited<ReturnType<Tx['submissionByRequest']>>;
}>;
/** PROPOSED external local-host capability; not present in today's ReadFacade or SDK. */
export type OutcomeRecordsReader = {
  readOutcomeRecords(conversationId: ConversationId, requestId: string, context: Context): Promise<OutcomeRecords>;
};
export type RequestOutcome =
  | { status: 'unknown'; reason: 'missing-conversation' | 'owner-mismatch' | 'receipt-unavailable' | 'receipt-mismatch' | 'unsupported-reason'; nativeReason?: string }
  | { status: 'working'; reason: 'observed-active' | 'queued' | 'placed' }
  | { status: 'completed'; submissionId: SubmissionRecord['id']; answer: NonNullable<Extract<SubmissionRecord, { type: 'input'; status: 'done' }>['answer']> }
  | { status: 'failed' | 'interrupted'; submissionId: SubmissionRecord['id']; nativeReason: string };

/**
 * Pure, request-scoped outcome only. A terminal result is NOT a coherent/latest
 * conversation-history status: the integration must establish that separately.
 * `observed` must come from the authenticated watch for this target conversation.
 * No text/stopReason, Anchor completion, or Reporter completion is inspected.
 */
export function resolveRequestOutcome(target: OutcomeTarget, records: OutcomeRecords, observed?: SnapshotEvent): RequestOutcome {
  const { conversation, submission } = records;
  if (!conversation) return { status: 'unknown', reason: 'missing-conversation' };
  if (conversation.id !== target.conversationId || conversation.owner?.conversationId !== target.parentConversationId
    || conversation.owner.taskId !== target.anchorTaskId) return { status: 'unknown', reason: 'owner-mismatch' };
  if (observed?.run || observed?.inbox.length) return { status: 'working', reason: 'observed-active' };
  if (!submission) return { status: 'unknown', reason: 'receipt-unavailable' };
  if (submission.type !== 'input' || submission.conversationId !== target.conversationId || submission.requestId !== target.requestId)
    return { status: 'unknown', reason: 'receipt-mismatch' };
  if (submission.status === 'queued' || submission.status === 'placed') return { status: 'working', reason: submission.status };
  if (submission.status === 'done') return { status: 'completed', submissionId: submission.id, answer: submission.answer };
  if (submission.reason === 'aborted' || submission.reason === 'reset')
    return { status: 'interrupted', submissionId: submission.id, nativeReason: submission.reason };
  if (submission.reason === 'model_error' || submission.reason === 'no_model' || submission.reason === 'faulted')
    return { status: 'failed', submissionId: submission.id, nativeReason: submission.reason };
  // SDK permits arbitrary reasons (including orphaning diagnostics). No guessed mapping.
  return { status: 'unknown', reason: 'unsupported-reason', nativeReason: submission.reason };
}
