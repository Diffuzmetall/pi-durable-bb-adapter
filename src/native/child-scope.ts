import type { Context } from '@earendil-works/chord';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import { ChildBindingDoc, SubagentsDoc, TeamDoc } from '@bb-durable/native-subagents';

/** Native ownership, independent of BB locators and of the number of sends. */
export async function readNativeChildScope(read: Pick<Harness, 'snapshot'>, child: ConversationId, context: Context) {
  const binding = (await read.snapshot(ChildBindingDoc, child, context))?.binding;
  if (!binding) return undefined;
  const record = (await read.snapshot(SubagentsDoc, binding.parent, context))?.agents[binding.key];
  const team = await read.snapshot(TeamDoc, binding.parent, context);
  const executions = Object.values(team?.executions ?? {}).filter(execution => execution.child === child || execution.key === binding.key);
  if (!record || record.conversationId !== child || record.ownerTaskId !== binding.anchor || !executions.length
    || executions.some(execution => execution.child !== child || execution.key !== binding.key)
    || executions.filter(execution => execution.requestId === record.requestId).length !== 1
    || new Set(executions.map(execution => execution.requestId)).size !== executions.length) return undefined;
  return { binding, record, executions };
}
