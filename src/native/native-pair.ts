import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import { ChildBindingDoc, SubagentsDoc, TeamDoc } from '@bb-durable/native-subagents';
import { readPrivateOwnerJson, assertPrivateOwnerParent } from "../bootstrap/owner-grant.ts";
import { createDurableBindingStore, type DurableBinding } from "../store/binding-store.ts";
import { registerNativeChildOverSocket } from "../protocol/native-child-rpc.ts";
import { nativeChildRegistrationRequestId } from "../projection/host/native-child-binding.ts";
import type { OwnerScope } from "./child-observation.ts";

export type NativePairOptions = Readonly<{ grantPath: string; ownerScope: OwnerScope }>;
export type NativePairOperation = (conversationId: ConversationId, context: Context) => Promise<DurableBinding>;
type Handoff = { protocol: 'bb-durable-registration-handoff/v1'; ownerScope: OwnerScope; socketPath: string;
  nativeSession: { id: string; directory: string; cwd: string } };
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const path = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && resolve(value) === value;
const sameScope = (a: OwnerScope, b: OwnerScope) => a.providerId === b.providerId && a.sessionId === b.sessionId && a.parentThreadId === b.parentThreadId;

/** Internal lifecycle constructor. Only the returned CID-specific operation reaches the endpoint. */
export async function bindNativePairer(session: Pick<Harness, 'snapshot' | 'commit'>, directory: string,
  options: NativePairOptions, lifecycle: Context): Promise<NativePairOperation> {
  if (!path(directory) || await realpath(directory) !== directory || !path(options.grantPath)) throw Error('PAIR_UNAVAILABLE');
  const owner = Object.freeze({ ...options.ownerScope });
  if (![owner.providerId, owner.sessionId, owner.parentThreadId].every(text)) throw Error('PAIR_UNAVAILABLE');
  const boundDirectory = directory;
  const handoffPath = options.grantPath + '.registration.json';
  const check = (context: Context) => { lifecycle.abortSignal?.throwIfAborted(); context.abortSignal?.throwIfAborted(); };
  async function handoff(): Promise<Handoff> {
    const value = await readPrivateOwnerJson(handoffPath);
    if (!object(value) || !exact(value, ['protocol', 'ownerScope', 'socketPath', 'nativeSession'])
      || value.protocol !== 'bb-durable-registration-handoff/v1' || !object(value.ownerScope)
      || !exact(value.ownerScope, ['providerId', 'sessionId', 'parentThreadId'])
      || ![value.ownerScope.providerId, value.ownerScope.sessionId, value.ownerScope.parentThreadId].every(text)
      || !object(value.nativeSession) || !exact(value.nativeSession, ['id', 'directory', 'cwd'])
      || !text(value.nativeSession.id) || !path(value.nativeSession.directory) || !path(value.nativeSession.cwd)
      || !path(value.socketPath)) throw Error('PAIR_REFUSED');
    const selected = value as unknown as Handoff;
    if (!sameScope(selected.ownerScope, owner) || selected.nativeSession.directory !== boundDirectory
      || await realpath(selected.nativeSession.directory) !== boundDirectory) throw Error('PAIR_REFUSED');
    await assertPrivateOwnerParent(selected.socketPath);
    return { protocol: 'bb-durable-registration-handoff/v1', ownerScope: { providerId: selected.ownerScope.providerId,
      sessionId: selected.ownerScope.sessionId, parentThreadId: selected.ownerScope.parentThreadId }, socketPath: selected.socketPath,
      nativeSession: { id: selected.nativeSession.id, directory: selected.nativeSession.directory, cwd: selected.nativeSession.cwd } };
  }
  async function provenance(id: ConversationId, context: Context) {
    const binding = (await session.snapshot(ChildBindingDoc, id, context))?.binding;
    if (!binding) throw Error('PAIR_REFUSED');
    const record = (await session.snapshot(SubagentsDoc, binding.parent, context))?.agents[binding.key];
    const executions = Object.values((await session.snapshot(TeamDoc, binding.parent, context))?.executions ?? {})
      .filter(execution => execution.child === id || execution.key === binding.key);
    const actual = await session.commit(tx => tx.conversation(id), context);
    if (!record || record.conversationId !== id || record.ownerTaskId !== binding.anchor
      || !actual || actual.parent || actual.owner?.conversationId !== binding.parent || actual.owner.taskId !== binding.anchor
      || executions.length !== 1 || executions[0]!.child !== id || executions[0]!.key !== binding.key
      || executions[0]!.requestId !== record.requestId) throw Error('PAIR_REFUSED');
    return JSON.stringify([binding.parent, binding.key, binding.anchor, record.requestId]);
  }
  return async (id, context) => {
    check(context);
    if (!Number.isSafeInteger(id) || id <= 0) throw Error('PAIR_REFUSED');
    const native = await provenance(id, context);
    const selected = await handoff();
    const before = await lstat(selected.socketPath);
    if (!before.isSocket()) throw Error('PAIR_REFUSED');
    const store = createDurableBindingStore(session, context);
    const existing = await store.get(id);
    if (existing && (existing.providerId !== owner.providerId || existing.sessionId !== owner.sessionId
      || existing.parentThreadId !== owner.parentThreadId)) throw Error('PAIR_REFUSED');
    const scoped = nativeChildRegistrationRequestId({ ...owner, conversationId: String(id), parentProviderThreadId: owner.sessionId });
    const requestId = 'bb-pair:' + createHash('sha256').update(JSON.stringify([scoped, owner.parentThreadId])).digest('hex');
    check(context);
    // The existing client has a bounded timeout but no cancellation argument.
    // Cancellation can leave an inert Core row, never a late native binding put.
    const signals = [lifecycle.abortSignal, context.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const listeners: Array<() => void> = [];
    let receipt;
    try {
      receipt = await Promise.race([
        registerNativeChildOverSocket(selected.socketPath, { conversationId: id, requestId }),
        new Promise<never>((_resolve, reject) => {
          for (const signal of signals) {
            const abort = () => reject(Error('PAIR_CANCELLED'));
            signal.addEventListener('abort', abort, { once: true });
            listeners.push(() => signal.removeEventListener('abort', abort));
            if (signal.aborted) abort();
          }
        }),
      ]);
    } finally { for (const remove of listeners) remove(); }
    check(context);
    const current = await handoff();
    const after = await lstat(current.socketPath);
    if (JSON.stringify(current) !== JSON.stringify(selected) || !after.isSocket() || (after.mode & 0o077) !== 0
      || after.uid !== process.getuid?.() || before.dev !== after.dev || before.ino !== after.ino
      || native !== await provenance(id, context)
      || receipt.requestId !== requestId || receipt.conversationId !== id || !sameScope(receipt, owner)
      || !text(receipt.threadId)) throw Error('PAIR_REFUSED');
    const identity: DurableBinding = { ...owner, conversationId: id, bbThreadId: receipt.threadId };
    check(context);
    await store.put(identity);
    check(context);
    return identity;
  };
}
