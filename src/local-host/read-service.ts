import type { Context } from '@earendil-works/chord';
import { withCancel } from '@earendil-works/chord/context';
import { LiveDoc, InboxDoc, watchEvents, type AgentEventStream, type ConversationId, type Harness, type RegistryReader, type Storage } from '@earendil-works/pi-durable';
import type { OutcomeHistory } from "../outcome/coherent.ts";
import { bindNativePairer, type NativePairOptions, type NativePairOperation } from "../native/native-pair.ts";
import { createChildControl, type ChildControl, type NativeSubmitter } from '../native/child-control.ts';

export type ReadFacade = Readonly<Pick<Harness, 'snapshot' | 'closed'>> & {
  watchExisting(conversationId: ConversationId, context: Context): Promise<AgentEventStream>;
  subscribeOutcome(conversationId: ConversationId, notify: () => void, context: Context): () => void;
  readOutcomeHistory(conversationId: ConversationId, requestIds: string | readonly string[], context: Context): Promise<OutcomeHistory>;
};
export type ReadServiceDefinition = {
  readonly revision: string;
  /** Roll back non-facade resources on rejection; observe context cancellation. */
  readonly registration?: NativePairOptions;
  bind(read: ReadFacade, context: Context, pairExisting?: NativePairOperation, controlExisting?: ChildControl): { close(): void | Promise<void> } | Promise<{ close(): void | Promise<void> }>; 
};

// Compatibility with the documented EXTERNAL local-host handoff, not a Pi SDK API.
const CONTROLLER = Symbol.for('pi.durable.hindsight.controller');
const SERVICE = Symbol.for('pi.durable.local-host.read-service.v1');
type HostBinding = { session: Harness; storage: Storage; directory: string; context: Context };
type Controller = {
  bind(host: HostBinding): Promise<unknown>;
  close(timeoutMs?: number): Promise<unknown>;
  submit?: NativeSubmitter['submit'];
  [SERVICE]?: State;
};
type State = {
  phase: 'unbound' | 'binding' | 'bound' | 'closed';
  definition: ReadServiceDefinition | undefined;
};

function controllerFor(registry: RegistryReader): Controller {
  const extension: unknown = registry.snapshot().extension('hindsight');
  const value: unknown = extension && typeof extension === 'object' ? Reflect.get(extension, CONTROLLER) : undefined;
  if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'bind') !== 'function'
    || typeof Reflect.get(value, 'close') !== 'function') {
    throw Error('READ_SERVICE_LIFECYCLE_UNAVAILABLE: existing external local-host bind/close required');
  }
  return value as Controller;
}

/**
 * Call from local-host composition BEFORE its first bind, even when disabled.
 * undefined explicitly means removal. Same-revision reload retains the old factory.
 * The host must call this for every candidate (including removal) before publication.
 */
export function registerReadService<T extends RegistryReader>(registry: T, definition: ReadServiceDefinition | undefined): T {
  if (definition && (typeof definition.revision !== 'string' || !definition.revision.trim() || typeof definition.bind !== 'function'))
    throw Error('READ_SERVICE_INVALID_DEFINITION');
  // Capture identity and factory; caller mutation cannot rewrite a bound revision.
  const selected = definition && Object.freeze({ revision: definition.revision, bind: definition.bind.bind(definition),
    registration: definition.registration && Object.freeze({ grantPath: definition.registration.grantPath,
      ownerScope: Object.freeze({ ...definition.registration.ownerScope }) }) });
  const controller = controllerFor(registry);
  const existing = controller[SERVICE];
  if (existing) {
    if (existing.phase === 'closed') throw Error('READ_SERVICE_CLOSED');
    if (existing.definition?.revision === selected?.revision) return registry;
    if (existing.phase !== 'unbound') throw Error('READ_SERVICE_REOPEN_REQUIRED');
    existing.definition = selected;
    return registry;
  }

  const state: State = { phase: 'unbound', definition: selected };
  const originalBind = controller.bind.bind(controller);
  const originalClose = controller.close.bind(controller);
  let binding: Promise<unknown> | undefined;
  let closing: Promise<unknown> | undefined;
  let dispose: (() => Promise<void>) | undefined;

  const bind = (host: HostBinding): Promise<unknown> => {
    if (state.phase !== 'unbound') return Promise.reject(Error('READ_SERVICE_ALREADY_BOUND_OR_CLOSED'));
    state.phase = 'binding';
    binding = (async () => {
      // Native lifecycle failure remains a native failure; never run the service.
      const result = await originalBind(host);
      if (!state.definition) return result;
      const { context, cancel } = withCancel(host.context);
      const watches = new Set<Promise<AgentEventStream>>();
      let active = true;
      let service: { close(): void | Promise<void> } | undefined;
      let disposal: Promise<void> | undefined;
      dispose = () => disposal ??= (async () => {
        active = false;
        cancel();
        const errors: unknown[] = [];
        try { await service?.close(); } catch (error) { errors.push(error); }
        const stopped = await Promise.allSettled([...watches].map(async pending => {
          const stream = await pending;
          await stream.stop();
        }));
        for (const item of stopped) if (item.status === 'rejected') errors.push(item.reason);
        watches.clear();
        if (errors.length) throw new AggregateError(errors, 'Read service cleanup failed');
      })();
      const read: ReadFacade = Object.freeze({
        snapshot: host.session.snapshot.bind(host.session),
        closed: host.session.closed,
        async readOutcomeHistory(id: ConversationId, requested: string | readonly string[], requestContext: Context) {
          if (!active) throw Error('READ_SERVICE_UNAVAILABLE');
          const requestIds = typeof requested === 'string' ? [requested] : requested;
          if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(requestIds) || !requestIds.length || requestIds.length > 1000
            || requestIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 1024))
            throw Error('READ_SERVICE_INVALID_OUTCOME_TARGET');
          // A per-read public commit listener is only a consistency guard, never a
          // replica/cursor. No Session API is called from its synchronous callback.
          let changed = false;
          const unsubscribe = host.session.subscribeCommits(publication => {
            if (publication.changes.some(change => (change.type === 'document' || change.type === 'document.copy'
              ? change.conversationId : change.type === 'conversation' ? change.value.id : change.value.conversationId) === id)) changed = true;
          });
          try {
            const conversation = await host.session.conversation(id, requestContext);
            const configuration = conversation && await conversation.agent(requestContext);
            const agent = configuration?.model ? { model: `${configuration.model.provider}/${configuration.model.modelId}`,
              thinkingLevel: configuration.thinkingLevel ?? 'off' } : undefined;
            const live = await host.session.snapshot(LiveDoc, id, requestContext);
            const inbox = await host.session.snapshot(InboxDoc, id, requestContext);
            // Read the existing owner's public Storage, never open another store.
            // Tx has no submission scan; the listener guards both read boundaries.
            let latestRequest: string | undefined;
            const inputs: { entryId: string; requestId: string }[] = [];
            let cursor;
            let submissionScanTruncated = false;
            for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
              const page = await host.storage.scanSubmissions({ conversationId: id, order: 'descending' }, 64, cursor, requestContext);
              for (const submission of page.items) if (submission.type === 'input') {
                latestRequest ??= submission.requestId;
                if ('entry' in submission && submission.entry !== undefined) inputs.push({ entryId: String(submission.entry), requestId: submission.requestId });
              }
              if (page.next === undefined) break;
              cursor = page.next;
              if (pageIndex === 15) submissionScanTruncated = true;
            }
            const frame = await host.session.commit(async tx => {
              const conversation = await tx.conversation(id);
              if (!conversation) return { conversation, submission: undefined, entries: [], truncated: false };
              const receipts = await Promise.all(requestIds.map(requestId => tx.submissionByRequest(id, requestId)));
              const original = receipts[0];
              const submission = original?.type === 'input'
                ? await tx.submissionByRequest(id, latestRequest ?? requestIds[0]!) : undefined;
              const page = await tx.scanEntries({ conversationId: id, order: 'ascending' }, 1000);
              return { conversation, submission, entries: page.items, inputs,
                pendingAdmission: receipts.slice(1).some(receipt => receipt === undefined),
                truncated: page.next !== undefined || submissionScanTruncated };
            }, requestContext);
            if (!active) throw Error('READ_SERVICE_UNAVAILABLE');
            return { ...frame, ...(agent ? { agent } : {}), stable: !changed, unsupported: live?.compactionFailure !== undefined,
              active: live?.run !== undefined || (inbox?.items.length ?? 0) > 0 || (live?.compactions?.length ?? 0) > 0 };
          } finally { unsubscribe(); }
        },
        subscribeOutcome(id: ConversationId, notify: () => void, requestContext: Context) {
          if (!active) throw Error('READ_SERVICE_UNAVAILABLE');
          requestContext.abortSignal?.throwIfAborted();
          // Input settlement can commit AFTER run_end. Observe that public receipt
          // boundary, not LiveDoc token updates; the consumer defers any SDK reads.
          const stop = host.session.subscribeCommits(publication => {
            if (active && publication.changes.some(change => change.type === 'submission' && change.value.conversationId === id)) notify();
          });
          const unsubscribe = () => { stop(); requestContext.abortSignal?.removeEventListener('abort', unsubscribe); };
          requestContext.abortSignal?.addEventListener('abort', unsubscribe, { once: true });
          return unsubscribe;
        },
        async watchExisting(id: ConversationId, requestContext: Context) {
          if (!active) throw Error('READ_SERVICE_UNAVAILABLE');
          const pending = (async () => {
            if (!await host.session.conversation(id, requestContext)) throw Error('READ_SERVICE_CONVERSATION_NOT_FOUND');
            if (!active) throw Error('READ_SERVICE_UNAVAILABLE');
            const stream = await watchEvents(host.session, id, requestContext);
            if (!active) { await stream.stop(); throw Error('READ_SERVICE_UNAVAILABLE'); }
            void stream.closed.then(() => watches.delete(pending));
            return stream;
          })();
          watches.add(pending);
          // Failed acquisitions hold no disposable.
          void pending.catch(() => watches.delete(pending));
          return pending;
        },
      });
      try {
        let pairExisting: NativePairOperation | undefined;
        if (state.definition.registration) {
          try {
            const pair = await bindNativePairer(host.session, host.directory, state.definition.registration, context);
            pairExisting = async (id, requestContext) => {
              if (!active) throw Error('PAIR_UNAVAILABLE');
              const identity = await pair(id, requestContext);
              if (!active) throw Error('PAIR_UNAVAILABLE');
              return identity;
            };
          } catch { /* Unavailable pairing must not disable existing read-only observation. */ }
        }
        const controlExisting = state.definition.registration && typeof controller.submit === 'function'
          ? createChildControl(host.session, registry, state.definition.registration.ownerScope,
            { submit: controller.submit.bind(controller) }, context) : undefined;
        service = await state.definition.bind(read, context, pairExisting, controlExisting);
        if (!service || typeof service.close !== 'function') throw Error('READ_SERVICE_INVALID_HANDLE');
      } catch {
        // Keep native host available. No backend credentials/errors enter diagnostics.
        try { await dispose(); } catch { /* Cleanup failure must not take down native host. */ }
        console.warn('READ_SERVICE_UNAVAILABLE: bind failed; native host retained');
      }
      return result;
    })().finally(() => { if (state.phase !== 'closed') state.phase = 'bound'; });
    return binding;
  };
  const close = (timeoutMs?: number): Promise<unknown> => closing ??= (async () => {
    state.phase = 'closed';
    // A close racing a bind must join it before disposing its resources.
    try { await binding; } catch { /* Original bind failure already belongs to its caller. */ }
    const errors: unknown[] = [];
    let result: unknown;
    try { await dispose?.(); } catch (error) { errors.push(error); }
    try { result = await originalClose(timeoutMs); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Read service/native lifecycle close failed');
    return result;
  })();

  // Validate lifecycle descriptors before changing either original method.
  for (const key of ['bind', 'close'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(controller, key);
    if (!descriptor?.writable) throw Error('READ_SERVICE_LIFECYCLE_NOT_WRITABLE');
  }
  if (!Object.isExtensible(controller)) throw Error('READ_SERVICE_LIFECYCLE_NOT_EXTENSIBLE');
  Object.defineProperty(controller, SERVICE, { value: state });
  controller.bind = bind;
  controller.close = close;
  return registry;
}
