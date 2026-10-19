import { createServer, type Socket } from 'node:net';
import { chmod, link, lstat, mkdtemp, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { withCancel } from '@earendil-works/chord/context';
import type { AgentEventStream, ConversationId } from '@earendil-works/pi-durable';
import { createDurableBindingReader } from "../store/binding-store.ts";
import type { ReadFacade, ReadServiceDefinition } from "../local-host/read-service.ts";
import { readCoherentOutcome, type CoherentOutcome } from "../outcome/coherent.ts";
import type { NativePairOperation } from "./native-pair.ts";
import type { ChildCommand, ChildControl } from './child-control.ts';

export type OwnerScope = Readonly<{ providerId: string; sessionId: string; parentThreadId: string }>;
export type ChildObservationOptions = {
  readonly ownerScope: OwnerScope;
  readonly socketPath: string;
  readonly revision: string;
};
export const OBSERVATION_PROTOCOL = 'bb-durable-observation/v1';
// One request/watch per connection. No custom history queue: SDK callbacks await writes.
const MAX_CONNECTIONS = 8;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const PAIR_TIMEOUT_MS = 25000;
type Request = { protocol: typeof OBSERVATION_PROTOCOL; id: string; conversationId: ConversationId } &
  ({ type: 'observe' | 'observeOutcome'; bbThreadId: string } | { type: 'pairExisting' }
    | { type: 'control'; bbThreadId: string; command: ChildCommand });
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
function requestFrom(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('REFUSED');
  const request = value as Record<string, unknown>;
  const pair = request.type === 'pairExisting', control = request.type === 'control';
  if (control) {
    const command = request.command;
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw Error('REFUSED');
    const c = command as Record<string, unknown>;
    if (c.type === 'abort' ? Object.keys(c).length !== 1
      : !['prompt', 'steer'].includes(String(c.type)) || Object.keys(c).length !== 3
        || typeof c.message !== 'string' || !c.message.trim() || Buffer.byteLength(c.message) > 512 * 1024 || !text(c.requestId)) throw Error('REFUSED');
  } else if (Buffer.byteLength(JSON.stringify(request)) > 8192) throw Error('REFUSED');
  if (Object.keys(request).length !== (pair ? 4 : control ? 6 : 5) || request.protocol !== OBSERVATION_PROTOCOL
    || (!pair && !control && request.type !== 'observe' && request.type !== 'observeOutcome')
    || !text(request.id) || (!pair && !text(request.bbThreadId)) || !Number.isSafeInteger(request.conversationId)
    || (request.conversationId as number) <= 0) throw Error('REFUSED');
  return request as Request;
}
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error ? error.code : undefined;

function writeFrame(socket: Socket, frame: object, timeoutMs = TIMEOUT_MS): Promise<void> {
  const data = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(data) > MAX_OUTPUT_BYTES) return Promise.reject(Error('OUTPUT_LIMIT'));
  return new Promise((resolveWrite, reject) => {
    const finish = (error?: Error | null) => {
      clearTimeout(timer);
      socket.off('close', closed);
      if (error) reject(error); else resolveWrite();
    };
    const closed = () => finish(Error('CONNECTION_CLOSED'));
    const timer = setTimeout(() => { socket.destroy(); finish(Error('WRITE_TIMEOUT')); }, timeoutMs);
    socket.once('close', closed);
    // Completion waits for transport backpressure; only one SDK batch is in flight.
    socket.write(data, finish);
  });
}

function observeConnection(socket: Socket, read: ReadFacade, owner: OwnerScope, context: Context, pairExisting?: NativePairOperation, controlExisting?: ChildControl) {
  const { context: connectionContext, cancel } = withCancel(context);
  let request: Request | undefined;
  let stream: AgentEventStream | undefined;
  let unsubscribeOutcome: (() => void) | undefined;
  let attaching: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let ended = false;
  let received = false;
  let buffer: Buffer = Buffer.alloc(0);
  let pairMode = false;
  const openedAt = Date.now();
  let deadline = setTimeout(() => { void finish('refused'); }, TIMEOUT_MS);

  function finish(reason: 'closed' | 'refused', reply = true): Promise<void> {
    return finishing ??= (async () => {
      ended = true;
      clearTimeout(deadline);
      cancel();
      unsubscribeOutcome?.();
      socket.pause();
      if (reply && !pairMode && !socket.destroyed && socket.writable) {
        try { await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'end', id: request?.id ?? null, reason }); } catch { /* Peer may already be gone. */ }
      }
      socket.destroy();
      try { await attaching; } catch { /* Generic refusal already sent. */ }
      await stream?.stop();
    })();
  }
  socket.on('error', () => { void finish('closed', false).catch(() => {}); });
  socket.on('close', () => { void finish('closed', false).catch(() => {}); });
  socket.on('end', () => { void finish('closed', false).catch(() => {}); });
  socket.on('data', chunk => {
    if (ended) return;
    if (!Buffer.isBuffer(chunk)) { void finish('refused').catch(() => {}); return; }
    if (received || buffer.length + chunk.length > MAX_FRAME_BYTES) { void finish('refused').catch(() => {}); return; }
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    received = true;
    clearTimeout(deadline);
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline)));
      pairMode = value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'pairExisting';
      if (newline !== buffer.length - 1) throw Error('REFUSED');
      request = requestFrom(value);
      if (pairMode || request.type === 'control') deadline = setTimeout(() => { void finish('closed', false); }, Math.max(1, PAIR_TIMEOUT_MS - (Date.now() - openedAt)));
    } catch { void finish('refused').catch(() => {}); return; }
    buffer = Buffer.alloc(0);
    const selected = request;
    attaching = (async () => {
      if (selected.type === 'pairExisting') {
        if (!pairExisting) throw Error('REFUSED');
        const identity = await pairExisting(selected.conversationId, connectionContext);
        if (identity.conversationId !== selected.conversationId || identity.providerId !== owner.providerId
          || identity.sessionId !== owner.sessionId || identity.parentThreadId !== owner.parentThreadId) throw Error('REFUSED');
        if (!ended) {
          const remaining = PAIR_TIMEOUT_MS - (Date.now() - openedAt);
          if (remaining <= 0) throw Error('PAIR_TIMEOUT');
          await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'paired', id: selected.id, identity }, remaining);
          socket.end();
        }
        return;
      }
      const binding = await createDurableBindingReader(read, connectionContext).get(selected.conversationId);
      // Wire identifiers are locators, never authority. Refuse BEFORE watch/history.
      if (!binding || binding.providerId !== owner.providerId || binding.sessionId !== owner.sessionId
        || binding.parentThreadId !== owner.parentThreadId || binding.conversationId !== selected.conversationId
        || binding.bbThreadId !== selected.bbThreadId) throw Error('REFUSED');
      if (ended) return;
      if (selected.type === 'control') {
        if (!controlExisting) throw Error('REFUSED');
        const receipt = await controlExisting(binding, selected.command, connectionContext);
        if (!ended) {
          await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'controlled', id: selected.id, identity: binding, receipt });
          socket.end();
        }
        return;
      }
      const publishOutcome = async () => {
        if (selected.type !== 'observeOutcome' || ended) return;
        let frame: CoherentOutcome;
        try { frame = await readCoherentOutcome(read, binding.conversationId, connectionContext); }
        catch { frame = { status: 'unknown', reason: 'unavailable' }; }
        if (!ended) await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'outcome', id: selected.id, identity: binding, frame });
      };
      let outcomeReady = false, outcomeDirty = false;
      let refreshing: Promise<void> | undefined;
      const refreshOutcome = (): Promise<void> => {
        outcomeDirty = true;
        if (!outcomeReady || ended) return Promise.resolve();
        return refreshing ??= (async () => {
          try {
            await Promise.resolve(); // Never call Session APIs in synchronous commit notification.
            while (outcomeDirty && !ended) { outcomeDirty = false; await publishOutcome(); }
          } finally { refreshing = undefined; }
        })(); // Coalesce to one pending refresh, not a transcript/history queue.
      };
      if (selected.type === 'observeOutcome') unsubscribeOutcome = read.subscribeOutcome(binding.conversationId, () => {
        void refreshOutcome().catch(() => { void finish('closed').catch(() => {}); });
      }, connectionContext);
      stream = await read.watchExisting(binding.conversationId, connectionContext);
      if (ended) { await stream.stop(); return; }
      await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'snapshot', id: selected.id, identity: binding, snapshot: stream.snapshot });
      outcomeReady = true;
      await refreshOutcome();
      if (ended) return;
      void stream.closed.then(() => finish('closed')).catch(() => {});
      stream.start(async events => {
        if (ended) return;
        try {
          await writeFrame(socket, { protocol: OBSERVATION_PROTOCOL, type: 'events', id: selected.id, events });
          if (events.some(event => ['snapshot', 'run_start', 'run_end', 'message_end', 'tool_execution_start', 'tool_execution_end'].includes(event.type)))
            await refreshOutcome(); // Committed history boundaries, not every generated token.
        }
        catch { void finish('closed').catch(() => {}); }
      });
    })();
    void attaching.catch(() => { void finish('refused').catch(() => {}); });
  });
  return { close: () => finish('closed') };
}

/** Injectable private capability library, not a trusted production bootstrap. Factory performs no I/O. */
export function createChildObservationService(options: ChildObservationOptions): ReadServiceDefinition {
  if (!options || !text(options.revision) || !isAbsolute(options.socketPath)
    || !options.ownerScope || !text(options.ownerScope.providerId) || !text(options.ownerScope.sessionId)
    || !text(options.ownerScope.parentThreadId)) throw Error('INVALID_OBSERVATION_OPTIONS');
  const socketPath = resolve(options.socketPath);
  const owner = Object.freeze({ ...options.ownerScope });
  return Object.freeze({ revision: options.revision, async bind(read: ReadFacade, context: Context, pairExisting?: NativePairOperation, controlExisting?: ChildControl) {
    const uid = process.getuid?.();
    const parent = dirname(socketPath);
    const directory = await lstat(parent);
    if (uid === undefined || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid
      || (directory.mode & 0o7777) !== 0o700 || await realpath(parent) !== parent) throw Error('PRIVATE_SOCKET_PARENT_REQUIRED');
    try { await lstat(socketPath); throw Error('SOCKET_PATH_EXISTS'); }
    catch (error) { if (code(error) !== 'ENOENT') throw error; }
    context.abortSignal?.throwIfAborted();

    // Node automatically unlinks its listen path on close. Listen in our own
    // private directory, then exclusively hard-link the inode at the capability
    // path. Thus native close can NEVER unlink a replacement at socketPath.
    const internalDirectory = await mkdtemp(join(parent, '.obs-'));
    const internalPath = join(internalDirectory, 's');
    const connections = new Set<ReturnType<typeof observeConnection>>();
    let active = false;
    let linked = false;
    let owned: Awaited<ReturnType<typeof lstat>> | undefined;
    let closing: Promise<void> | undefined;
    const server = createServer(socket => {
      if (!active || connections.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
      const connection = observeConnection(socket, read, owner, context, pairExisting, controlExisting);
      connections.add(connection);
      socket.once('close', () => { void connection.close().finally(() => connections.delete(connection)).catch(() => {}); });
    });
    const close = (): Promise<void> => closing ??= (async () => {
      active = false;
      const serverClosed = new Promise<void>((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return; }
        server.close(error => error ? reject(error) : resolveClose());
      });
      const results = await Promise.allSettled([...connections].map(connection => connection.close()));
      const errors: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      try { await serverClosed; } catch (error) { errors.push(error); }
      if (linked && owned) {
        try {
          const current = await lstat(socketPath);
          if (current.isSocket() && current.dev === owned.dev && current.ino === owned.ino) await unlink(socketPath);
        } catch (error) { if (code(error) !== 'ENOENT') errors.push(error); }
      }
      try { await rmdir(internalDirectory); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Observation service cleanup failed');
    })();
    server.on('error', () => { if (active) void close().catch(() => {}); });
    const abort = () => { void close().catch(() => {}); };
    try {
      await chmod(internalDirectory, 0o700);
      if (Buffer.byteLength(internalPath) > 107) throw Error('SOCKET_PATH_TOO_LONG');
      await new Promise<void>((resolveListen, reject) => {
        const failed = (error: Error) => { server.off('listening', listening); reject(error); };
        const listening = () => { server.off('error', failed); resolveListen(); };
        server.once('error', failed); server.once('listening', listening);
        server.listen(internalPath);
      });
      await chmod(internalPath, 0o600);
      owned = await lstat(internalPath);
      if (!owned.isSocket() || owned.uid !== uid || (owned.mode & 0o7777) !== 0o600) throw Error('PRIVATE_SOCKET_REQUIRED');
      context.abortSignal?.throwIfAborted();
      await link(internalPath, socketPath); // Exclusive: refuses raced files and symlinks.
      linked = true;
      active = true;
      context.abortSignal?.addEventListener('abort', abort, { once: true });
      if (context.abortSignal?.aborted) { await close(); throw Error('OBSERVATION_BIND_CANCELLED'); }
      return { close: () => { context.abortSignal?.removeEventListener('abort', abort); return close(); } };
    } catch (error) {
      try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Observation bind failed'); }
      throw error;
    }
  } });
}
