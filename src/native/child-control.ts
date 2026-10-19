import type { Context } from '@earendil-works/chord';
import type { Conversation, Harness, RegistryReader, Submission } from '@earendil-works/pi-durable';
import type { DurableBinding } from '../store/binding-store.ts';
import type { OwnerScope } from './child-observation.ts';
import { readNativeChildScope } from './child-scope.ts';

export type ChildCommand = { type: 'prompt' | 'steer'; message: string; requestId: string } | { type: 'abort' };
export type ChildControlReceipt = { conversationId: number; command: ChildCommand['type']; submissionId?: number; requestId?: string };
export type ChildControl = (binding: DurableBinding, command: ChildCommand, context: Context) => Promise<ChildControlReceipt>;
export type NativeSubmitter = {
  submit(conversation: Conversation, content: string, whenBusy: 'steer' | 'followUp', requestId?: string): Promise<Submission>;
};

/** Bound to the existing native owner; never another Harness, model or tool registry. */
export function createChildControl(session: Harness, registry: RegistryReader, owner: OwnerScope,
  admission: NativeSubmitter, lifecycle: Context): ChildControl {
  return async (binding, command, context) => {
    lifecycle.abortSignal?.throwIfAborted();
    context.abortSignal?.throwIfAborted();
    if (binding.providerId !== owner.providerId || binding.sessionId !== owner.sessionId || binding.parentThreadId !== owner.parentThreadId)
      throw Error('CHILD_CONTROL_REFUSED');
    const scope = await readNativeChildScope(session, binding.conversationId, context);
    const actual = await session.commit(tx => tx.conversation(binding.conversationId), context);
    if (!scope || !actual || actual.parent || actual.owner?.conversationId !== scope.binding.parent || actual.owner.taskId !== scope.binding.anchor)
      throw Error('CHILD_CONTROL_REFUSED');
    const conversation = await session.conversation(binding.conversationId, context);
    if (!conversation) throw Error('CHILD_CONTROL_REFUSED');
    const extension = registry.snapshot().extension('native-goals');
    const goals = extension && Reflect.get(extension, Symbol.for('pi.durable.native-goals')) as {
      humanSubmit(child: number, send: () => Promise<Submission>, context: Context, requestId?: string): Promise<Submission>;
      protectsExecution(child: number, context: Context): Promise<boolean>;
    } | undefined;
    if (extension && (!goals || typeof goals.humanSubmit !== 'function' || typeof goals.protectsExecution !== 'function'))
      throw Error('CHILD_CONTROL_ADMISSION_UNAVAILABLE');
    lifecycle.abortSignal?.throwIfAborted();
    context.abortSignal?.throwIfAborted();
    if (command.type === 'abort') {
      if (await goals?.protectsExecution(conversation.id, context)) throw Error('CHILD_CONTROL_GOAL_PROTECTED');
      await conversation.abort(context);
      return { conversationId: conversation.id, command: 'abort' };
    }
    if (typeof command.message !== 'string' || !command.message.trim() || Buffer.byteLength(command.message) > 512 * 1024
      || typeof command.requestId !== 'string' || !command.requestId.trim() || command.requestId.length > 256)
      throw Error('CHILD_CONTROL_INVALID_INPUT');
    // Same Hindsight + Goal admission used by the native human submit path.
    // A lost ACK never triggers an automatic retry; SDK request IDs deduplicate input.
    const send = () => admission.submit(conversation, command.message, command.type === 'steer' ? 'steer' : 'followUp', command.requestId);
    const submission = goals ? await goals.humanSubmit(conversation.id, send, context, command.requestId) : await send();
    return { conversationId: conversation.id, command: command.type, requestId: command.requestId, submissionId: submission.id };
  };
}
