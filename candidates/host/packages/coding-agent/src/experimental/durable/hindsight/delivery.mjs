import { randomUUID } from 'node:crypto';
import { defineDoc, defineTask, AssistantEntry, UserEntry } from '@earendil-works/pi-durable';
import { readPiMessages, planRetain, renderSessionJsonl, uuidV5, fingerprintTurns, resolvePiConfig, buildRetainStamp } from './bridge.mjs';

// Native 0.8.0 attribution default; configured templates are resolved at admission.
const DEFAULT_RETAIN_CONTEXT = `conversation between the user and you (the coding agent): user turns are the user's words and decisions, assistant turns are yours. When an assistant turn says something is fixed, passes or works, record it as the agent's claim ("the agent reported X fixed"), not as an established fact.`;

export const DeliveryNamespace = defineDoc({ kind: 'hindsight.namespace', version: 1, scope: 'session', history: 'latest', initial: () => ({ namespace: randomUUID() }) });
export const DeliveryState = defineDoc({ kind: 'hindsight.delivery', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ identity: randomUUID(), epochs: [], admissions: {}, intents: [], cursor: null, diagnostics: [] }),
  // ACK release must replace the latest document's obsolete payload deltas,
  // not merely its materialized bytes. Canonical entries remain untouched.
  checkpointWhen: (_value, ops) => ops.some(([op, path, value]) => op === 's' && path.length === 3 && path[0] === 'intents' && Number.isInteger(path[1]) && path[2] === 'payload' && value === null)
});

export async function resolveDeliveryBinding(cwd, { resolveBinding = resolvePiConfig, hooksDisabled = false } = {}) {
  const { cfg, bankId } = await resolveBinding(cwd);
  const sessionId = randomUUID();
  const stamp = buildRetainStamp(cfg, { directory: cwd, harness: 'pi', bankId, sessionId });
  return { cwd, bankId, sessionId, stamp, enabled: !hooksDisabled && !cfg.disabled && cfg.retainSessions !== false };
}

// Persist before submit({ requestId, ... }); the logical input keeps this
// binding through queueing, cwd changes, and reopen. No credentials are copied.
export async function bindDeliveryAdmission(tx, conversationId, requestId, binding) {
  const state = await tx.doc(DeliveryState, conversationId);
  if (!state.admissions[requestId]) state.admissions[requestId] = { cwd: binding.cwd, bankId: binding.bankId, sessionId: binding.sessionId ?? randomUUID(), stamp: { tags: binding.stamp?.tags ?? [], metadata: binding.stamp?.metadata ?? {}, context: binding.stamp?.context ?? null }, enabled: binding.enabled !== false };
}

// Call in the placing commit, with Pi-resolved, credential-free binding. Never
// infer a historical input's binding from today's agent.cwd on startup.
export async function bindDeliveryInput(tx, conversationId, entryId, binding) {
  const state = await tx.doc(DeliveryState, conversationId);
  const last = state.epochs.at(-1);
  if (last && last.cwd === binding.cwd && last.bank === binding.bankId && last.enabled === (binding.enabled !== false)) return;
  const start = !last && binding.inheritedStart !== undefined ? binding.inheritedStart : entryId;
  const sessionId = binding.sessionId ?? `${state.identity}:${randomUUID()}`;
  const stamp = { tags: binding.stamp?.tags ?? [], metadata: binding.stamp?.metadata ?? {}, context: binding.stamp?.context ?? null };
  state.epochs.push({ at: entryId, start, cwd: binding.cwd, bank: binding.bankId, enabled: binding.enabled !== false, sessionId, stamp, ref: `conversation:${sessionId}` });
}

// Must run before appendEntry (Durable table reads are forbidden after writes).
export async function prepareDeliveryBinding(tx, conversationId, binding) {
  const conversation = await tx.conversation(conversationId);
  if (!conversation?.parent) return binding;
  const parent = await tx.doc(DeliveryState, conversation.parent.conversationId);
  const epoch = parent.epochs.filter(e => e.at <= conversation.parent.at).at(-1);
  return epoch && epoch.cwd === binding.cwd && epoch.bank === binding.bankId
    ? { ...binding, inheritedStart: epoch.start } : binding;
}

async function entries(tx, conversationId) {
  const result = [];
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId }, 256, cursor);
    result.push(...page.items); cursor = page.next;
  } while (cursor !== undefined);
  return result.reverse();
}

// One commit discovers all missed final boundaries and atomically creates both
// intents and executable tasks. Raw branch scans deliberately ignore head/edits.
export async function reconcileDelivery(session, context, { conversationIds, storage } = {}) {
  // A settled submission.answer is the actual final boundary. onYield may
  // continue despite a committed stop message; that is not a finished answer.
  const answers = new Set();
  const placed = [];
  if (storage) {
    let cursor;
    do { const page = await storage.scanSubmissions({}, 256, cursor, context); for (const s of page.items) { if (s.answer !== undefined) answers.add(s.answer); if (s.type === 'input' && s.entry !== undefined) placed.push(s); } cursor = page.next; } while (cursor !== undefined);
  }
  return session.commit(async tx => {
    let ids = conversationIds;
    if (!ids) {
      ids = []; let cursor;
      do { const page = await tx.scanConversations({}, 256, cursor); ids.push(...page.items.map(c => c.id)); cursor = page.next; } while (cursor !== undefined);
    }
    const namespace = (await tx.doc(DeliveryNamespace)).namespace;
    const schedule = [];
    for (const id of ids) {
      const history = await entries(tx, id);
      const state = await tx.doc(DeliveryState, id);
      for (const input of placed.filter(s => s.conversationId === id).sort((a, b) => a.entry - b.entry)) {
        const binding = state.admissions[input.requestId];
        if (binding && !state.epochs.some(e => e.at === input.entry) && !state.epochs.some(e => e.at > input.entry)) {
          await bindDeliveryInput(tx, id, input.entry, await prepareDeliveryBinding(tx, id, binding));
        }
      }
      for (const entry of history) {
        const message = entry.model?.[0];
        if (!AssistantEntry.is(entry) || !['stop', 'length', 'toolUse'].includes(message?.stopReason) || message.content?.some(c => c.type === 'toolCall')) continue;
        if (entry.byTaskId !== undefined && !answers.has(entry.id)) continue;
        if (state.intents.some(i => i.boundary === entry.id)) continue;
        const epoch = state.epochs.filter(e => e.at <= entry.id).at(-1);
        if (!epoch) {
          if (!state.diagnostics.includes('unbound committed history')) state.diagnostics.push('unbound committed history');
          continue;
        }
        if (!epoch.enabled) continue;
        const turns = readPiMessages(history.filter(e => e.id >= epoch.start && e.id <= entry.id && (UserEntry.is(e) || AssistantEntry.is(e))).flatMap(e => e.model ?? []));
        const plan = planRetain(turns, undefined, { appendSupported: false, bank: epoch.bank });
        if (plan.mode === 'skip') continue;
        const first = history.find(e => e.id >= epoch.start && UserEntry.is(e));
        const timestamp = new Date(first?.model?.[0]?.timestamp ?? message.timestamp ?? Date.now()).toISOString();
        const payload = renderSessionJsonl(epoch.ref, turns, timestamp);
        const operationId = uuidV5(`${namespace}\n${epoch.bank}\n${epoch.ref}\nreplace\n${payload}`);
        state.intents.push({ boundary: entry.id, cwd: epoch.cwd, bank: epoch.bank, ref: epoch.ref, sessionId: epoch.sessionId ?? epoch.ref.slice('conversation:'.length), stamp: epoch.stamp ?? { tags: [], metadata: {} }, timestamp, payload, operationId, turns: turns.length, fingerprint: fingerprintTurns(turns, turns.length), status: 'pending', taskId: null, idempotent: null, diagnostic: null });
      }
      // Terminal failed attempts are retried only when explicitly reconciled.
      for (const intent of state.intents) {
        if (intent.status === 'acked' || intent.status === 'uncertain') continue;
        const task = intent.taskId && await tx.task(intent.taskId);
        if (!task || task.state.status === 'terminal') schedule.push({ id, intent });
      }
    }
    for (const { id, intent } of schedule) intent.taskId = await tx.createTask(DeliveryTaskToken, { conversationId: id, operationId: intent.operationId }, { conversationId: id, ownership: { kind: 'conversation' }, background: true });
  }, context);
}

// Host must register before Harness.open, pass storage to reconciliation, and
// reconcile after commits/startup. Await each persisted taskId with waitForTask;
// repeat reconciliation after acknowledgements to wake blocked newer intents.
// No onYield delivery, implicit resume, credential persistence, or blind retry.
// Tx.createTask reads only definition.initial/name/version; execution resolves
// kind/version in the owning harness registry, not this token's closures.
// Every registration uses the same initial state, so sharing this token is safe.
let DeliveryTaskToken;
export function registerDelivery(registry, { resolveClient, timeoutMs = 15000, afterRemoteAck } ) {
  const task = defineTask({ name: 'hindsight.deliver', version: 1, initial: () => ({ phase: 'send' }), phases: {
    send: async (task, runtime, context) => {
      let intent;
      await runtime.commit(async tx => {
        const state = await tx.doc(DeliveryState, task.input.conversationId);
        const index = state.intents.findIndex(i => i.operationId === task.input.operationId);
        const current = state.intents[index];
        if (current.status === 'acked' || current.status === 'uncertain' || state.intents.slice(0, index).some(i => i.status !== 'acked')) return;
        if (current.status === 'sending' && !current.idempotent) { current.status = 'uncertain'; current.diagnostic = 'interrupted remote effect; idempotency unavailable'; return; }
        intent = JSON.parse(JSON.stringify(current));
      }, context);
      const finish = () => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);
      if (!intent) return finish();
      let timer, expired = false;
      const timeoutError = () => Object.assign(new Error('retain timeout'), { code: 'TIMEOUT' });
      const checkBudget = () => { if (expired) throw timeoutError(); };
      try {
        // Bound preparation as well as send. A late resolver/probe must not
        // start an effect after this attempt has already settled as pending.
        await Promise.race([new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(timeoutError()); }, timeoutMs);
        }), (async () => {
          const client = await resolveClient({ cwd: intent.cwd, bankId: intent.bank });
          checkBudget();
          if (client.bank !== intent.bank) throw Object.assign(new Error('resolved bank differs from persisted binding'), { accepted: false });
          let supported = intent.idempotent;
          if (supported === null) {
            try { supported = Boolean(await client.supportsIdempotentRetain()); }
            catch { supported = false; }
          }
          checkBudget();
          await runtime.commit(async tx => {
            const i = (await tx.doc(DeliveryState, task.input.conversationId)).intents.find(i => i.operationId === intent.operationId);
            checkBudget(); i.idempotent = supported; i.status = 'sending';
          }, context);
          checkBudget();
          intent.idempotent = supported;
          await client.retain(intent.payload, intent.stamp?.context ?? DEFAULT_RETAIN_CONTEXT, intent.ref,
            [...new Set([...(intent.stamp?.tags ?? []), 'source:chat', 'harness:pi'])], 'conversation',
            { timestamp: intent.timestamp, operationId: intent.operationId, metadata: {
              ...intent.stamp?.metadata, source: 'chat', session_id: intent.sessionId ?? intent.ref.slice('conversation:'.length), ref_id: intent.ref, harness: 'pi'
            } });
        })()]);
      } catch (error) {
        // HTTP rejection is a known non-acceptance. Transport failures may have
        // occurred after acceptance; unsupported effects cannot be blindly replayed.
        await runtime.commit(async tx => {
          const i = (await tx.doc(DeliveryState, task.input.conversationId)).intents.find(i => i.operationId === intent.operationId);
          const known = Number(error.status ?? error.statusCode) >= 400 || error.accepted === false;
          i.status = i.status !== 'sending' || known || i.idempotent ? 'pending' : 'uncertain';
          i.diagnostic = known ? `retain rejected (${error.status ?? error.statusCode ?? 'known failure'})` : `retain transport failure (${i.status})`;
        }, context);
        return finish();
      } finally { clearTimeout(timer); }
      // Fault injection models remote acceptance followed by process death. It
      // deliberately runs outside catch: sending checkpoint must survive.
      await afterRemoteAck?.(intent);
      await runtime.commit(async tx => {
        const state = await tx.doc(DeliveryState, task.input.conversationId);
        const i = state.intents.find(i => i.operationId === intent.operationId);
        i.status = 'acked'; i.diagnostic = null;
        // KTD4/5 require immutable bytes until acceptance, not ACKED snapshots.
        // Keep identity/membership receipts; canonical raw branch entries remain.
        i.payload = null;
        state.cursor = { boundary: i.boundary, operationId: i.operationId, bank: i.bank, turns: i.turns, fingerprint: i.fingerprint, acceptance: 'queued' };
        return { status: 'terminal', outcome: { status: 'completed', result: null } };
      }, context);
    }
  }, abort: async (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context) });
  DeliveryTaskToken = task;
  registry.install({ name: 'hindsight.delivery', tasks: [task] });
  return { task, namespaceDoc: DeliveryNamespace, conversationDoc: DeliveryState };
}
