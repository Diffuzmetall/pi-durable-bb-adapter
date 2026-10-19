import type { Context } from '@earendil-works/chord';
import { AssistantEntry, UserEntry, type ConversationId, type EntryRecord, type Harness } from '@earendil-works/pi-durable';
import { readNativeChildScope } from '../native/child-scope.ts';
import { resolveRequestOutcome, type OutcomeRecords, type OutcomeTarget } from './resolver.ts';

export type OutcomeHistory = OutcomeRecords & {
  entries: readonly EntryRecord[]; truncated: boolean; stable: boolean; active: boolean; unsupported: boolean;
  pendingAdmission?: boolean;
  inputs?: readonly { entryId: string; requestId: string }[];
  agent?: { model: string; thinkingLevel: string };
};
export type CoherentReader = Pick<Harness, 'snapshot'> & {
  readOutcomeHistory(conversationId: ConversationId, requestIds: string | readonly string[], context: Context): Promise<OutcomeHistory>;
};
export type CoherentOutcome =
  | { status: 'unknown'; reason: string }
  | { status: 'working'; reason: string; entries?: readonly EntryRecord[]; inputs?: readonly { entryId: string; requestId: string }[]; agent?: { model: string; thinkingLevel: string } }
  | (OutcomeTarget & { status: 'completed' | 'failed' | 'interrupted'; submissionId: NonNullable<OutcomeRecords['submission']>['id']; entries: readonly EntryRecord[]; inputs?: readonly { entryId: string; requestId: string }[]; agent?: { model: string; thinkingLevel: string }; answer?: Extract<NonNullable<OutcomeRecords['submission']>, { status: 'done'; type: 'input' }>['answer'] });

/** Trusted in-process capability only. Endpoint MUST authorize the BB binding before calling. */
export async function readCoherentOutcome(read: CoherentReader, child: ConversationId, context: Context): Promise<CoherentOutcome> {
  async function selection() {
    const scope = await readNativeChildScope(read, child, context);
    if (!scope) return undefined;
    const { binding, record, executions } = scope;
    const target = { conversationId: child, parentConversationId: binding.parent, anchorTaskId: binding.anchor, requestId: record.requestId };
    return { target,
      // A native send records its execution BEFORE admitting the child input.
      pending: [record.requestId, ...executions.filter(e => !e.done).map(e => e.requestId)],
      revision: JSON.stringify([target, executions.map(e => e.requestId).sort()]) };
  }
  const selected = await selection();
  if (!selected) return { status: 'unknown', reason: 'unsupported-native-execution' };
  const frame = await read.readOutcomeHistory(child, [...new Set(selected.pending)], context);
  const current = await selection();
  if (!current || current.revision !== selected.revision) return { status: 'unknown', reason: 'execution-changed' };
  if (!frame.stable) return { status: 'unknown', reason: 'concurrent-change' };
  if (frame.unsupported) return { status: 'unknown', reason: 'compaction-unsupported' };
  if (frame.conversation?.parent) return { status: 'unknown', reason: 'fork-unsupported' };
  // Status belongs to the latest native input receipt, not the original spawn,
  // a report's JSON shape, task completion, answer wording or stopReason.
  const target = { ...selected.target, requestId: frame.submission?.requestId ?? selected.target.requestId };
  const outcome = resolveRequestOutcome(target, frame);
  if (outcome.status === 'unknown' && ['owner-mismatch', 'missing-conversation'].includes(outcome.reason)) return { status: 'unknown', reason: outcome.reason };
  if (frame.active || frame.pendingAdmission || outcome.status === 'working') {
    if (frame.truncated || frame.entries.some(entry => entry.conversationId !== child || entry.head || entry.edits))
      return { status: 'unknown', reason: 'history-receipt-mismatch-or-unsupported' };
    return { status: 'working', reason: 'observed-active', entries: frame.entries, ...(frame.inputs ? { inputs: frame.inputs } : {}), ...(frame.agent ? { agent: frame.agent } : {}) };
  }
  if (outcome.status === 'unknown') return { status: 'unknown', reason: outcome.reason };
  const receipt = frame.submission!;
  const entries = frame.entries;
  const latestUser = entries.findLast(entry => UserEntry.is(entry));
  const answer = outcome.status === 'completed' ? entries.find(entry => entry.id === outcome.answer) : undefined;
  if (frame.truncated || !entries.length || entries.some(entry => entry.conversationId !== child || entry.head || entry.edits)
    || latestUser?.id !== receipt.entry
    || (outcome.status === 'completed' && (!answer || !AssistantEntry.is(answer) || Number(answer.id) <= Number(receipt.entry))))
    return { status: 'unknown', reason: 'history-receipt-mismatch-or-unsupported' };
  return { ...target, status: outcome.status, submissionId: outcome.submissionId, entries,
    ...(frame.inputs ? { inputs: frame.inputs } : {}), ...(frame.agent ? { agent: frame.agent } : {}),
    ...(outcome.status === 'completed' ? { answer: outcome.answer } : {}) };
}
