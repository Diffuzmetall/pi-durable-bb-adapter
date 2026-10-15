import { AgentDoc } from '@earendil-works/pi-durable';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withCancel, awaitWithContext } from '@earendil-works/chord/context';
import { createHindsightExtension, createPinnedContextBuilder, resolveContextBinding, bindContextAdmission, ContextState, durableDeliveryStatus } from './extension.mjs';
import { registerDelivery, reconcileDelivery, DeliveryState } from './delivery.mjs';
import { createLifecycle } from './lifecycle.mjs';
import { resolvePiConfig, resolveHostMemory, readPiMessages } from './bridge.mjs';

// Definitions are installed before Harness.open. Binding happens before resume.
export function createHindsightController(registry, options = {}) {
  const resolveBinding = options.resolveBinding ?? resolvePiConfig;
  const resolveClient = options.resolveClient ?? (async binding => resolveHostMemory('pi', binding.cwd).client);
  let host, lifecycle, unsubscribe, closed = false, queued = false;
  let work = Promise.resolve(), reconciling = Promise.resolve();
  let controllerContext, cancelController, lastStatuses = [];
  // Deadlines bound asynchronous waiting, not synchronous JS/SQLite host stalls.
  async function bounded(timeoutMs, run, parent = controllerContext) {
    const scope = withCancel(parent);
    const timer = setTimeout(() => scope.cancel(), Math.max(0, timeoutMs));
    try { return await run(scope.context); }
    finally { clearTimeout(timer); scope.cancel(); }
  }
  const diagnostic = options.diagnostic ?? (() => {});
  let buildContext = options.buildContext ?? createPinnedContextBuilder({
    cacheFileFor: id => resolve(host.directory, `hindsight-context-${id}`), resolveBinding, resolveClient,
  });
  const extensionOptions = () => ({ resolveBinding, resolveClient, buildContext,
    getHost: () => host,
    lifecycleFor: async (id, binding, context) => {
      const { cfg, bankId } = await resolveBinding(binding.cwd);
      if (bankId !== binding.bankId) throw new Error('Lifecycle bank changed after admission');
      return lifecycle.lifecycleFor(id, { ...binding, cfg }, context);
    },
  });
  const install = () => registry.install(createHindsightExtension(extensionOptions()));
  install();
  registerDelivery(registry, { resolveClient, timeoutMs: options.timeoutMs ?? 15000 });
  async function reconcileUsage() {
    // Delivery discovery owns eligibility (settled submission.answer, not an
    // intermediate stop). Usage is independent of remote acknowledgement.
    const histories = await host.session.commit(async tx => {
      const result = []; let cursor;
      do {
        const page = await tx.scanConversations({}, 256, cursor);
        for (const conversation of page.items) {
          const state = await tx.doc(DeliveryState, conversation.id);
          if (!state.intents.length) continue;
          const history = []; let entryCursor;
          do {
            const entries = await tx.scanEntries({ conversationId: conversation.id }, 256, entryCursor);
            history.push(...entries.items); entryCursor = entries.next;
          } while (entryCursor !== undefined);
          result.push({ id: conversation.id, state: JSON.parse(JSON.stringify(state)), history: history.reverse() });
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return result;
    }, controllerContext);
    for (const { id, state, history } of histories) {
      for (const epoch of state.epochs) {
        if (!epoch.enabled) continue;
        const boundaries = state.intents.filter(i => i.ref === epoch.ref).map(i => i.boundary);
        if (!boundaries.length) continue;
        // Config resolvers need not support cancellation. Stop this continuation
        // before lifecycle admission; never abandon it with a live write context.
        const { cfg, bankId } = await awaitWithContext(Promise.resolve(resolveBinding(epoch.cwd)), controllerContext);
        controllerContext.abortSignal?.throwIfAborted();
        // Today's configuration supplies gates, never a replacement bank for
        // historical inputs. Configuration/credentials stay process-local.
        if (bankId !== epoch.bank) continue;
        const boundary = Math.max(...boundaries);
        const turns = readPiMessages(history.filter(e => e.id >= epoch.start && e.id <= boundary).flatMap(e => e.model ?? []));
        await lifecycle.recordUsage(id, { cwd: epoch.cwd, bankId, cfg, usageEpochRef: epoch.ref, usageSessionId: epoch.sessionId ?? epoch.ref.slice('conversation:'.length) }, turns, true, controllerContext);
      }
    }
  }
  function reconcile() {
    // drain, startup and commit wakes share a lane: a concurrent reconciliation
    // must not mistake this process's active append intent for a crash gap.
    const next = reconciling.then(async () => {
      if (!host || closed) return;
      await awaitWithContext(reconcileDelivery(host.session, controllerContext, { storage: host.storage }), controllerContext);
      controllerContext.abortSignal?.throwIfAborted();
      // Discovery can create intents after drain's initial cached snapshot.
      // Publish current durable counts before an unsupported usage resolver
      // stalls this shared lane. Controller ownership fences scans on close;
      // drain still bounds only its waiter, not this reconciliation.
      await awaitWithContext(statuses(controllerContext), controllerContext);
      await awaitWithContext(reconcileUsage(), controllerContext);
    });
    reconciling = next.catch(() => {});
    return next;
  }
  function wake() {
    if (closed || queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (!closed) work = work.then(reconcile).catch(() => diagnostic('Hindsight reconciliation failed; pending work remains durable'));
    });
  }
  async function statuses(context) {
    const result = []; let cursor;
    do {
      const page = await host.session.commit(tx => tx.scanConversations({}, 256, cursor), context);
      for (const record of page.items) {
        const state = await host.session.snapshot(DeliveryState, record.id, context);
        result.push({ conversationId: record.id, ...durableDeliveryStatus(state) });
      }
      cursor = page.next;
    } while (cursor !== undefined);
    context.abortSignal?.throwIfAborted();
    lastStatuses = result;
    return result;
  }
  return {
    async bind(input) {
      if (host) throw new Error('Hindsight controller already bound');
      host = input;
      ({ context: controllerContext, cancel: cancelController } = withCancel(host.context));
      await mkdir(host.directory, { recursive: true });
      controllerContext.abortSignal?.throwIfAborted();
      lifecycle = createLifecycle(host.session, { usagePath: resolve(host.directory, 'usage.jsonl'), ...(options.lifecycleEffects ?? {}), resolveClient, diagnostic });
      unsubscribe = host.session.subscribeCommits(publication => {
        // Only accepted frontier advancement wakes blocked successors. Pending,
        // sending and failed-attempt document updates must not retry themselves.
        if (publication.changes.some(change => change.type === 'submission'
          || (change.type === 'entry' && change.value.kind === 'pi.assistant')
          || (change.type === 'document' && change.record.kind === DeliveryState.definition.kind
            && change.value?.cursor && change.ops.some(op => op[0] === 's' && op[1][0] === 'cursor')))) wake();
      });
      await reconcile();
    },
    async admit(conversation, requestId, context = host?.context) {
      if (!host || closed) throw new Error('Hindsight controller is not available');
      // Replay must not re-resolve today's configuration for an admitted input.
      const state = await host.session.snapshot(ContextState, conversation.id, context);
      if (state?.admissions[requestId]) return;
      const agent = await host.session.snapshot(AgentDoc, conversation.id, context);
      if (!agent?.cwd) throw new Error('Hindsight admission requires the child effective cwd');
      let binding;
      try { binding = await resolveContextBinding(agent.cwd, { resolveBinding }); }
      catch {
        context.abortSignal?.throwIfAborted();
        diagnostic('Hindsight admission unavailable; memory disabled for this input');
        binding = { cwd: agent.cwd, bankId: '', enabled: false, contextEnabled: false, toolsEnabled: false };
      }
      // Commit failure is NOT degradation: input has not been submitted and no
      // caller may submit it with a different id after an ambiguous failure.
      await host.session.commit(tx => bindContextAdmission(tx, conversation.id, requestId, binding), context);
    },
    async submit(conversation, content, whenBusy = 'followUp') {
      const requestId = randomUUID();
      await this.admit(conversation, requestId);
      const submission = await conversation.submit({ type: 'input', content, whenBusy, requestId }, host.context);
      void submission.wait(host.context).then(wake, wake);
      return submission;
    },
    async reload(target = registry) {
      if (!host || closed) throw new Error('Hindsight controller is not available');
      const fresh = await import(`./extension.mjs?reload=${randomUUID()}`);
      const freshBuilder = options.buildContext ?? fresh.createPinnedContextBuilder({
        cacheFileFor: id => resolve(host.directory, `hindsight-context-${id}`), resolveBinding, resolveClient,
      });
      target.install(fresh.createHindsightExtension({ ...extensionOptions(), buildContext: freshBuilder }));
    },
    async drain(timeoutMs = 3000) {
      if (!host || closed) return lastStatuses;
      try {
        return await bounded(timeoutMs, async context => {
          // Capture pending notices before joining potentially stalled usage.
          await awaitWithContext(statuses(context), context);
          await awaitWithContext(work, context);
          await awaitWithContext(reconcile(), context);
          context.abortSignal?.throwIfAborted();
          host.session.resume();
          let result = await awaitWithContext(statuses(context), context);
          let accepted = result.reduce((sum, s) => sum + s.accepted, 0);
          while (result.some(s => s.pending > 0)) {
            let timer;
            try { await awaitWithContext(new Promise(resolve => { timer = setTimeout(resolve, 25); }), context); }
            finally { clearTimeout(timer); }
            result = await awaitWithContext(statuses(context), context);
            const next = result.reduce((sum, s) => sum + s.accepted, 0);
            // A drain timeout cancels only its waiter, not the shared once lane.
            if (next > accepted) { accepted = next; await awaitWithContext(reconcile(), context); }
          }
          return result;
        });
      } catch (error) {
        if (error?.name !== 'AbortError') throw error;
        diagnostic('Hindsight drain incomplete; durable pending delivery may remain');
        return lastStatuses;
      }
    },
    async close(timeoutMs = 3000) {
      closed = true; unsubscribe?.(); cancelController?.();
      if (!host) return;
      // The controller context fences future commits even when an unsupported
      // dependency itself keeps running. Joining must not depend on its release.
      try { await bounded(timeoutMs, context => awaitWithContext(Promise.all([work, reconciling]), context), host.context); }
      catch (error) { if (error?.name !== 'AbortError') throw error; }
    },
  };
}
