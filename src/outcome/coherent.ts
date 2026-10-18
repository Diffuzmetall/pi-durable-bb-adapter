import type { Context } from '@earendil-works/chord';
import { AssistantEntry, UserEntry, SystemEntry, type ConversationId, type EntryRecord, type Harness } from '@earendil-works/pi-durable';
import { ChildBindingDoc, SubagentsDoc, TeamDoc } from '@bb-durable/native-subagents';
import { resolveRequestOutcome, type OutcomeRecords, type OutcomeTarget } from "./resolver.ts";

export type OutcomeHistory = OutcomeRecords & { entries: readonly EntryRecord[]; truncated: boolean; stable: boolean; active: boolean; unsupported: boolean };
export type CoherentReader = Pick<Harness, 'snapshot'> & {
  readOutcomeHistory(conversationId: ConversationId, requestId: string, context: Context): Promise<OutcomeHistory>;
};
export type CoherentOutcome =
  | { status: 'unknown' | 'working'; reason: string }
  | (OutcomeTarget & { status: 'completed' | 'failed' | 'interrupted'; submissionId: NonNullable<OutcomeRecords['submission']>['id']; entries: readonly EntryRecord[]; answer?: Extract<NonNullable<OutcomeRecords['submission']>, { status: 'done'; type: 'input' }>['answer'] });

/** Trusted in-process capability only. Endpoint MUST authorize the BB binding before calling. */
export async function readCoherentOutcome(read: CoherentReader, child: ConversationId, context: Context): Promise<CoherentOutcome> {
  async function selection() {
    const binding = (await read.snapshot(ChildBindingDoc, child, context))?.binding;
    if (!binding) return undefined;
    const agents = await read.snapshot(SubagentsDoc, binding.parent, context);
    const record = agents?.agents[binding.key];
    const team = await read.snapshot(TeamDoc, binding.parent, context);
    const executions = Object.values(team?.executions ?? {}).filter(e => e.child === child || e.key === binding.key);
    if (!record || record.conversationId !== child || record.ownerTaskId !== binding.anchor
      || executions.length !== 1 || executions[0]!.child !== child || executions[0]!.key !== binding.key
      || executions[0]!.requestId !== record.requestId) return undefined;
    return { conversationId: child, parentConversationId: binding.parent, anchorTaskId: binding.anchor, requestId: record.requestId };
  }
  const selected = await selection();
  if (!selected) return { status: 'unknown', reason: 'unsupported-native-execution' };
  const frame = await read.readOutcomeHistory(child, selected.requestId, context);
  // A native send writes TeamDoc BEFORE submission/admission. Recheck after the
  // serialized frame, rejecting even newer sends held before entering child inbox.
  const current = await selection();
  if (!current || JSON.stringify(current) !== JSON.stringify(selected)) return { status: 'unknown', reason: 'execution-changed' };
  if (!frame.stable) return { status: 'unknown', reason: 'concurrent-change' };
  if (frame.unsupported) return { status: 'unknown', reason: 'compaction-unsupported' };
  if (frame.active) return { status: 'working', reason: 'observed-active' };
  if (frame.conversation?.parent) return { status: 'unknown', reason: 'fork-unsupported' };
  const outcome = resolveRequestOutcome(selected, frame);
  if (outcome.status === 'unknown' || outcome.status === 'working') return { status: outcome.status, reason: outcome.reason };
  const receipt = frame.submission!;
  const entries = frame.entries;
  // Scope deliberately excludes tools, context edits/reset/compaction and extra
  // inputs. Known SDK assistant thinking is retained verbatim for an explicit
  // text-only BB presentation policy; never parse signatures or invent text.
  const plain = (entry: EntryRecord) => entry.conversationId === child && !entry.head && !entry.edits
    && entry.model?.length === 1 && entry.model.every(message =>
      (SystemEntry.is(entry) && message.role === 'system' && typeof message.content === 'string')
      || (UserEntry.is(entry) && message.role === 'user'
        && (typeof message.content === 'string' || message.content.every(block => block.type === 'text' && typeof block.text === 'string')))
      || (AssistantEntry.is(entry) && message.role === 'assistant' && Array.isArray(message.content)
        && message.content.every(block => block.type === 'text' && typeof block.text === 'string'
          || block.type === 'thinking' && typeof block.thinking === 'string'
            && (block.thinkingSignature === undefined || typeof block.thinkingSignature === 'string')
            && (block.redacted === undefined || typeof block.redacted === 'boolean'))));
  const dialogue = entries.filter(entry => !SystemEntry.is(entry));
  if (frame.truncated || entries.length < 1 || entries.length > 3 || !entries.every(plain)
    || entries.filter(entry => SystemEntry.is(entry)).length > 1
    || dialogue.length < 1 || dialogue.length > 2 || !UserEntry.is(dialogue[0]) || dialogue[0].id !== receipt.entry
    || (dialogue[1] !== undefined && !AssistantEntry.is(dialogue[1]))
    || (outcome.status === 'completed' && (dialogue.length !== 2 || dialogue[1]!.id !== outcome.answer
      || !dialogue[1]!.model?.some(message => message.role === 'assistant'
        && message.content.some(block => block.type === 'text' && block.text.trim().length > 0)))))
    return { status: 'unknown', reason: 'history-receipt-mismatch-or-unsupported' };
  return { ...selected, status: outcome.status, submissionId: outcome.submissionId, entries,
    ...(outcome.status === 'completed' ? { answer: outcome.answer } : {}) };
}
