import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { Socket } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AgentEvent, SnapshotEvent } from '@earendil-works/pi-durable';
import type { DurableBinding } from "../store/binding-store.ts";
import type { CoherentOutcome } from "../outcome/coherent.ts";
import type { ChildCommand, ChildControlReceipt } from '../native/child-control.ts';

const PROTOCOL = 'bb-durable-observation/v1';
const MAX_FRAME_BYTES = 8 * 1024 * 1024; // Includes newline; matches the observation service.
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const refused = () => Error('OBSERVATION_REFUSED');

export type ObserveChildOptions = {
  readonly socketPath: string;
  /** Full expected identity supplied by an already authorized caller, not wire discovery. */
  readonly binding: DurableBinding;
  readonly signal?: AbortSignal;
  readonly onSnapshot: (snapshot: SnapshotEvent, identity: DurableBinding) => Promise<void>;
  readonly onEvents: (events: readonly AgentEvent[]) => Promise<void>;
  /** Explicit opt-in to observeOutcome. Project terminal frame.entries ONLY;
   * unknown/working grant no historical projection, and SDK snapshots stay separate.
   * The promise still resolves after onSnapshot, not after the first outcome.
   */
  readonly onOutcome?: (frame: CoherentOutcome, identity: DurableBinding) => Promise<void>;
  readonly onEnd?: (reason: string) => void;
};

async function privateSocketPath(socketPath: string, signal?: AbortSignal): Promise<void> {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || socketPath.includes('\0')) throw refused();
  const path = resolve(socketPath), parent = dirname(path), uid = process.getuid?.();
  if (path !== socketPath || Buffer.byteLength(path) > 107 || uid === undefined) throw refused();
  const directory = await lstat(parent), endpoint = await lstat(path);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700
    || await realpath(parent) !== parent || !endpoint.isSocket() || endpoint.uid !== uid
    || (endpoint.mode & 0o7777) !== 0o600) throw refused();
  signal?.throwIfAborted();
}

// One bounded partial frame plus native transport buffering; no application queue.
async function* readFrames(socket: Socket): AsyncGenerator<Record<string, unknown>> {
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) throw refused();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline + 1;
      if (pending.length + end - offset > MAX_FRAME_BYTES) throw refused();
      pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
      offset = end;
      if (newline < 0) continue;
      const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, -1)));
      pending = Buffer.alloc(0);
      if (!object(frame) || frame.protocol !== PROTOCOL) throw refused();
      yield frame;
    }
  }
  if (pending.length) throw refused();
}

function validBinding(v: unknown): v is DurableBinding {
  return object(v) && text(v.providerId) && text(v.sessionId) && text(v.parentThreadId)
    && text(v.bbThreadId) && Number.isSafeInteger(v.conversationId) && (v.conversationId as number) > 0
    && Object.keys(v).length === 5;
}
function snapshot(v: unknown): v is SnapshotEvent {
  return object(v) && v.type === 'snapshot' && Array.isArray(v.entries) && object(v.agent)
    && Array.isArray(v.tools) && Array.isArray(v.nestedTools) && Array.isArray(v.compactions)
    && Array.isArray(v.inbox) && object(v.usage);
}

const positiveId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
function sameIdentity(v: unknown, expected: DurableBinding): v is DurableBinding {
  return validBinding(v) && Object.keys(expected).every(key => v[key as keyof DurableBinding] === expected[key as keyof DurableBinding]);
}
function outcome(v: unknown, conversationId: number): v is CoherentOutcome {
  if (!object(v)) return false;
  if (Object.hasOwn(v, 'agent') && (!object(v.agent) || Object.keys(v.agent).length !== 2
    || typeof v.agent.model !== 'string' || !v.agent.model.trim() || v.agent.model.length > 1024 || !text(v.agent.thinkingLevel))) return false;
  if (v.status === 'unknown' || v.status === 'working') {
    const keys = ['status', 'reason'];
    if (v.status === 'working' && Object.hasOwn(v, 'entries')) {
      keys.push('entries');
      if (Object.hasOwn(v, 'agent')) keys.push('agent');
      if (!Array.isArray(v.entries) || !v.entries.every(entry => object(entry) && positiveId(entry.id)
        && entry.conversationId === conversationId && text(entry.kind) && Array.isArray(entry.model))) return false;
      if (Object.hasOwn(v, 'inputs')) {
        keys.push('inputs');
        if (!Array.isArray(v.inputs) || v.inputs.length > 1000 || !v.inputs.every(input => object(input)
          && Object.keys(input).length === 2 && typeof input.entryId === 'string' && typeof input.requestId === 'string')) return false;
      }
    }
    return Object.keys(v).length === keys.length && typeof v.reason === 'string' && v.reason.trim().length > 0;
  }
  if (v.status !== 'completed' && v.status !== 'failed' && v.status !== 'interrupted') return false;
  const keys = ['status', 'conversationId', 'parentConversationId', 'anchorTaskId', 'requestId', 'submissionId', 'entries'];
  if (Object.hasOwn(v, 'answer')) keys.push('answer');
  if (Object.hasOwn(v, 'agent')) keys.push('agent');
  if (Object.hasOwn(v, 'inputs')) {
    keys.push('inputs');
    if (!Array.isArray(v.inputs) || v.inputs.length > 1000 || !v.inputs.every(input => object(input)
      && Object.keys(input).length === 2 && typeof input.entryId === 'string' && typeof input.requestId === 'string')) return false;
  }
  return Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key))
    && v.conversationId === conversationId && positiveId(v.parentConversationId) && positiveId(v.anchorTaskId)
    && typeof v.requestId === 'string' && v.requestId.trim().length > 0 && positiveId(v.submissionId)
    && Array.isArray(v.entries) && v.entries.length > 0 && v.entries.every(entry => object(entry)
      && positiveId(entry.id) && entry.conversationId === conversationId && text(entry.kind) && Array.isArray(entry.model))
    && (!Object.hasOwn(v, 'answer') || (positiveId(v.answer) && v.entries.some(entry => entry.id === v.answer)));
}

/** Read-only attach. Resolves after the first validated snapshot callback completes.
 * No reconnect/replay, store, model input, or host lifecycle ownership is acquired.
 * close() joins transport closure, not user callbacks (safe to await inside one).
 */
export async function observeChild(options: ObserveChildOptions): Promise<{ close(): Promise<void> }> {
  // Capture the caller's options before asynchronous filesystem checks.
  options = { ...options };
  let expected: DurableBinding;
  try {
    if (!options || !validBinding(options.binding) || typeof options.onSnapshot !== 'function'
      || typeof options.onEvents !== 'function' || (options.onEnd !== undefined && typeof options.onEnd !== 'function')
      || (options.onOutcome !== undefined && typeof options.onOutcome !== 'function')) throw refused();
    expected = Object.freeze({ ...options.binding });
    await privateSocketPath(options.socketPath, options.signal);
  } catch { throw refused(); }

  const socket = new Socket();
  let stopped = false, attached = false, reason = 'closed';
  let resolveReady!: (handle: { close(): Promise<void> }) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<{ close(): Promise<void> }>((yes, no) => { resolveReady = yes; rejectReady = no; });
  const closed = new Promise<void>(yes => socket.once('close', () => yes()));
  const stop = (why: string) => {
    if (stopped) return;
    stopped = true; reason = why;
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
    if (!attached) rejectReady(refused());
    socket.destroy();
  };
  const abort = () => stop('closed');
  const handle = { close: () => { stop('closed'); return closed; } };
  const deadline = setTimeout(() => stop('refused'), 5000);
  socket.on('error', () => stop(attached ? 'closed' : 'refused'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) stop('closed');
  const id = randomUUID();
  socket.once('connect', () => socket.write(JSON.stringify({
    protocol: PROTOCOL, type: options.onOutcome ? 'observeOutcome' : 'observe', id, conversationId: expected.conversationId, bbThreadId: expected.bbThreadId,
  }) + '\n'));

  // Async iteration bounds Node's read buffer and awaits each callback before reading
  // more. One frame plus one transport chunk is retained; no unbounded promise queue.
  void (async () => {
    try {
      if (stopped) return;
      socket.connect(options.socketPath);
      for await (const frame of readFrames(socket)) {
        if (stopped) break;
        if (frame.type === 'end') {
          if (Object.keys(frame).length !== 4 || (frame.id !== id && !(frame.id === null && !attached && frame.reason === 'refused'))
            || (frame.reason !== 'closed' && frame.reason !== 'refused')) throw refused();
          stop(frame.reason); break;
        }
        if (frame.id !== id) throw refused();
        if (!attached) {
          const identity = frame.identity;
          if (frame.type !== 'snapshot' || Object.keys(frame).length !== 5 || !sameIdentity(identity, expected)
            || !snapshot(frame.snapshot)) throw refused();
          clearTimeout(deadline);
          await options.onSnapshot(frame.snapshot, expected);
          if (stopped) break;
          attached = true; resolveReady(handle);
        } else if (frame.type === 'outcome') {
          if (!options.onOutcome || Object.keys(frame).length !== 5 || !sameIdentity(frame.identity, expected)
            || !outcome(frame.frame, expected.conversationId)) throw refused();
          await options.onOutcome(frame.frame, expected);
        } else {
          if (frame.type !== 'events' || Object.keys(frame).length !== 4 || !Array.isArray(frame.events)
            || !frame.events.every(event => object(event) && text(event.type))) throw refused();
          await options.onEvents(frame.events as AgentEvent[]);
        }
      }
      if (!stopped) stop('closed');
    } catch { stop('refused'); }
    finally {
      stop('closed');
      try { options.onEnd?.(reason); } catch { /* User notification cannot escape the detached reader. */ }
    }
  })();
  return ready;
}

/** One authorized command, no retries. Lost ACK means unconfirmed, never resubmit. */
export async function controlChild(options: { socketPath: string; binding: DurableBinding; command: ChildCommand; signal?: AbortSignal }): Promise<ChildControlReceipt> {
  const expected = Object.freeze({ ...options.binding });
  const command = Object.freeze({ ...options.command });
  if (!validBinding(expected) || (command.type !== 'abort' && (!text(command.requestId)
    || typeof command.message !== 'string' || !command.message.trim() || Buffer.byteLength(command.message) > 512 * 1024)))
    throw Error('CHILD_CONTROL_REFUSED_OR_UNCONFIRMED');
  await privateSocketPath(options.socketPath, options.signal);
  const socket = new Socket(), id = randomUUID();
  const closed = new Promise<void>(yes => socket.once('close', () => yes()));
  const abort = () => socket.destroy(Error('CHILD_CONTROL_REFUSED_OR_UNCONFIRMED'));
  const deadline = setTimeout(abort, 25000);
  socket.on('error', () => {});
  options.signal?.addEventListener('abort', abort, { once: true });
  socket.once('connect', () => socket.write(JSON.stringify({ protocol: PROTOCOL, type: 'control', id,
    conversationId: expected.conversationId, bbThreadId: expected.bbThreadId, command }) + '\n'));
  try {
    options.signal?.throwIfAborted();
    socket.connect(options.socketPath);
    let receipt: ChildControlReceipt | undefined;
    for await (const frame of readFrames(socket)) {
      const result = frame.receipt;
      if (receipt || frame.type !== 'controlled' || Object.keys(frame).length !== 5 || frame.id !== id
        || !sameIdentity(frame.identity, expected) || !object(result) || result.conversationId !== expected.conversationId
        || result.command !== command.type || (command.type === 'abort' ? Object.keys(result).length !== 2
          : Object.keys(result).length !== 4 || result.requestId !== command.requestId || !positiveId(result.submissionId)))
        throw Error('CHILD_CONTROL_REFUSED_OR_UNCONFIRMED');
      receipt = result as ChildControlReceipt;
    }
    options.signal?.throwIfAborted();
    if (!receipt) throw Error('CHILD_CONTROL_REFUSED_OR_UNCONFIRMED');
    return receipt;
  } catch { throw Error('CHILD_CONTROL_REFUSED_OR_UNCONFIRMED'); }
  finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
    socket.destroy();
    await closed;
  }
}

export type PairExistingChildOptions = {
  readonly socketPath: string;
  readonly conversationId: DurableBinding['conversationId'];
  /** Trusted actual Core-derived parent context; captured locally, NEVER sent on wire. */
  readonly ownerScope: Readonly<{ providerId: string; sessionId: string; parentThreadId: string }>;
  readonly signal?: AbortSignal;
};

/** Pair an existing native child, never submit it. Resolves only after a validated
 * paired ACK and clean EOF. This is a durable binding, NOT a terminal outcome.
 * Caller order: pair ACK -> authorized history-sink digest -> observeOutcome ->
 * project the coherent frame.entries (omissions stay outside the transcript).
 * Abort only detaches: a committed registration cannot be undone here. No retries.
 */
export async function pairExistingChild(options: PairExistingChildOptions): Promise<DurableBinding> {
  try {
    if (!options || !positiveId(options.conversationId) || !object(options.ownerScope)
      || Object.keys(options.ownerScope).length !== 3 || !text(options.ownerScope.providerId)
      || !text(options.ownerScope.sessionId) || !text(options.ownerScope.parentThreadId)) throw refused();
    const { socketPath, conversationId, signal } = options;
    const owner = Object.freeze({ ...options.ownerScope });
    await privateSocketPath(socketPath, signal);
    const socket = new Socket(), id = randomUUID();
    const closed = new Promise<void>(yes => socket.once('close', () => yes()));
    const abort = () => socket.destroy(refused());
    // NCR permits 20s; bound the whole exchange to 25s including local commit/flush.
    const deadline = setTimeout(abort, 25000);
    socket.on('error', () => {}); // The async reader translates transport errors generically.
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(JSON.stringify({ protocol: PROTOCOL, type: 'pairExisting', id, conversationId }) + '\n'));
    try {
      signal?.throwIfAborted();
      socket.connect(socketPath);
      let identity: DurableBinding | undefined;
      for await (const frame of readFrames(socket)) {
        if (identity || frame.type !== 'paired' || Object.keys(frame).length !== 4 || frame.id !== id
          || !validBinding(frame.identity) || frame.identity.conversationId !== conversationId
          || frame.identity.providerId !== owner.providerId || frame.identity.sessionId !== owner.sessionId
          || frame.identity.parentThreadId !== owner.parentThreadId) throw refused();
        identity = Object.freeze({ ...frame.identity });
      }
      signal?.throwIfAborted();
      if (!identity) throw refused();
      return identity;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      await closed;
    }
  } catch { throw refused(); }
}
