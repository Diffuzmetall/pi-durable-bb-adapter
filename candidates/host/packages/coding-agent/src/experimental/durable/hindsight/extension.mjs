import { AgentDoc, GenerationTask, hook, defineDoc, defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { buildKnowledgeTools, toPiTool, buildPageTrigger, buildRetainStamp, resolvePiConfig, resolveHostMemory, buildHookOutput } from './bridge.mjs';
import { DeliveryState, resolveDeliveryBinding, bindDeliveryAdmission } from './delivery.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { awaitWithContext } from '@earendil-works/chord/context';

export const ContextState = defineDoc({ kind: 'hindsight.context', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ admissions: {}, prepared: {}, current: null, cwd: null, bankId: null, turns: 0, snapshot: {} }) });

// Credential-free binding. Must be committed BEFORE submit with the same requestId.
export async function resolveContextBinding(cwd, { resolveBinding = resolvePiConfig, hooksDisabled = Boolean(process.env.HINDSIGHT_DISABLE_HOOKS) } = {}) {
  const resolved = await resolveBinding(cwd);
  const delivery = await resolveDeliveryBinding(cwd, { resolveBinding: () => resolved, hooksDisabled });
  return { ...delivery, toolsEnabled: !resolved.cfg.disabled, contextEnabled: !hooksDisabled && !resolved.cfg.disabled };
}
export async function bindContextAdmission(tx, conversationId, requestId, binding) {
  if (!requestId) throw new Error('Hindsight requires a stable requestId');
  await bindDeliveryAdmission(tx, conversationId, requestId, binding);
  const state = await tx.doc(ContextState, conversationId);
  if (state.admissions[requestId]) return; // Replay keeps the original binding.
  // Legacy toolSelection overlays are ambiguous with equal-valued caller policy.
  // Never infer permission to restore/broaden AgentDoc.tools from that state.
  state.admissions[requestId] = { cwd: binding.cwd, bankId: binding.bankId, contextEnabled: binding.contextEnabled !== false, toolsEnabled: binding.toolsEnabled !== false };
}

// Explicit filesystem boundary for pinned 0.8.0's cache-based algorithm. U5 must
// supply an adapter-owned path (and parent directory), never the global Pi cache.
// Pinned diagnostics also require process-local LOG_FILE/DIAG_FILE overrides;
// refuse the helper's otherwise-global log writes rather than mutate global env.
// U4 supplies the cached lifecycle result; this never calls startup/seed/update.
const liveClient = async binding => resolveHostMemory('pi', binding.cwd).client;
export function createPinnedContextBuilder({ cacheFileFor, resolveClient = liveClient, resolveBinding = resolvePiConfig }) {
  if (!cacheFileFor) throw new Error('An adapter-owned cacheFileFor is required');
  return async ({ conversationId, binding, prompt, snapshot, lifecycle, turn }) => {
    if (!process.env.HINDSIGHT_LOG_FILE || !process.env.HINDSIGHT_DIAG_FILE) throw new Error('Pinned context requires adapter-owned HINDSIGHT_LOG_FILE and HINDSIGHT_DIAG_FILE paths');
    const { cfg, bankId } = await resolveBinding(binding.cwd);
    if (cfg.disabled || bankId !== binding.bankId) return { context: '', snapshot, notice: 'Hindsight context binding unavailable' };
    // A cancelled read can finish late. Its cache must not overwrite another
    // preparation's restored snapshot; SQLite remains the authoritative cache.
    const cacheFile = `${cacheFileFor(conversationId, binding)}.${randomUUID()}`;
    // The pinned helper derives cadence from its cache; failed placed inputs
    // still consume a logical turn even when no cache was produced.
    // Native no-page startup defers synthesis, not retrieval-only modes.
    await writeFile(cacheFile, JSON.stringify({ ...snapshot, deferInitialReflect: cfg.autoInject === 'reflect' && snapshot.deferInitialReflect === true, turns: turn - 1 }));
    const output = await buildHookOutput({ harness: 'pi', prompt, cfg, client: await resolveClient(binding, cfg), cacheFile });
    return { ...output, snapshot: JSON.parse(await readFile(cacheFile, 'utf8')) };
  };
}

// Session/Storage are controller capabilities, not invented HookApi operations.
// Only placed submissions advance cadence; queue admissions and tool turns do not.
// Per-conversation serialization prevents two section preparations racing effects.
const preparing = new WeakMap();
export async function preparePlacedContext(session, storage, conversationId, context, { buildContext, lifecycleFor = async () => ({}) }) {
  let locks = preparing.get(session);
  if (!locks) preparing.set(session, locks = new Map());
  const previous = locks.get(conversationId) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    context.abortSignal?.throwIfAborted();
    const placed = []; let cursor;
    do {
      const page = await storage.scanSubmissions({ conversationId }, 256, cursor, context);
      placed.push(...page.items.filter(s => s.conversationId === conversationId && s.type === 'input' && s.entry !== undefined));
      cursor = page.next;
    } while (cursor !== undefined);
    placed.sort((a, b) => a.entry - b.entry);
    for (const input of placed) {
      let candidate;
      await session.commit(async tx => {
        const state = await tx.doc(ContextState, conversationId);
        const binding = state.admissions[input.requestId];
        if (!binding || state.prepared[input.requestId]) return;
        const changed = state.cwd !== binding.cwd || state.bankId !== binding.bankId;
        candidate = { binding: { ...binding }, turn: changed ? 1 : state.turns + 1, snapshot: changed ? {} : JSON.parse(JSON.stringify(state.snapshot)) };
      }, context);
      if (!candidate) continue;
      const raw = await storage.entry(input.entry, context);
      const entry = raw?.entry ?? raw;
      const prompt = (entry?.model ?? []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')).join('\n');
      const active = candidate.binding.contextEnabled && Boolean(prompt.trim());
      let lifecycle = {};
      let output = { context: '', snapshot: candidate.snapshot };
      if (active) {
        try {
          if (!buildContext) throw new Error('U3 requires a pinned or injected context builder');
          if (candidate.turn === 1) lifecycle = await awaitWithContext(Promise.resolve().then(() => lifecycleFor(conversationId, candidate.binding, context)), context);
          const snapshot = { ...candidate.snapshot, ...(lifecycle.deferInitialReflect ? { deferInitialReflect: true } : {}) };
          output = await awaitWithContext(Promise.resolve().then(() => buildContext({ conversationId, requestId: input.requestId, entryId: input.entry, prompt, ...candidate, snapshot, lifecycle, context })), context);
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          output = { context: '', snapshot: candidate.snapshot, notice: 'Hindsight context unavailable (preparation failed)' }; }
      }
      const block = candidate.binding.contextEnabled ? [candidate.turn === 1 ? lifecycle.additionalContext : '', output.context].filter(Boolean).join('\n\n') : '';
      await session.commit(async tx => {
        const state = await tx.doc(ContextState, conversationId);
        if (state.prepared[input.requestId]) return;
        state.prepared[input.requestId] = { entryId: input.entry, turn: active ? candidate.turn : candidate.turn - 1, context: block, notice: output.notice ?? null };
        state.current = input.requestId; state.cwd = candidate.binding.cwd; state.bankId = candidate.binding.bankId;
        state.turns = active ? candidate.turn : candidate.turn - 1; state.snapshot = output.snapshot ?? candidate.snapshot;
      }, context);
    }
    const state = await session.snapshot(ContextState, conversationId, context);
    const latest = placed.at(-1)?.requestId;
    return (latest && state?.prepared[latest]) || { context: '', notice: 'Hindsight: no bound placed input' };
  });
  locks.set(conversationId, work);
  const release = () => { if (locks.get(conversationId) === work) locks.delete(conversationId); };
  void work.then(release, release);
  return awaitWithContext(work, context);
}

export function durableDeliveryStatus(state) {
  const intents = state?.intents ?? [];
  return { pending: intents.filter(i => !['acked', 'uncertain'].includes(i.status)).length, uncertain: intents.filter(i => i.status === 'uncertain').length, accepted: intents.filter(i => i.status === 'acked').length, acceptance: 'queued is not extracted', diagnostics: state?.diagnostics ?? [] };
}

// Declarations come exclusively from pinned tools. Client/config are resolved at
// execution against this tool's conversation env/agent, never a selected UI cwd.
export function createHindsightExtension({ resolveBinding = resolvePiConfig, resolveClient = liveClient, getHost, buildContext, lifecycleFor, toolSpecs = buildKnowledgeTools } = {}) {
  const declarations = buildKnowledgeTools({}, '', { harness: 'pi' }).map(toPiTool);
  const tools = declarations.map(declaration => defineTool({
    name: declaration.name, description: declaration.description, parameters: declaration.parameters,
    replay: ['hindsight_capture_initiative', 'hindsight_ingest_document'].includes(declaration.name) ? 'unsafe' : 'safe',
    async execute(args, api, context) {
      const agent = await api.agent(context);
      const cwd = api.env?.cwd ?? agent.cwd;
      if (!cwd) throw new Error('Hindsight requires this conversation\'s effective cwd');
      const { cfg, bankId } = await resolveBinding(cwd);
      if (cfg.disabled) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Hindsight is disabled' }) }], details: null, isError: true };
      const client = await resolveClient({ cwd, bankId }, cfg);
      const specs = toolSpecs(client, bankId, { repoDir: cwd, harness: 'pi', loadConfig: () => cfg, pageTrigger: buildPageTrigger(cfg), reflectTimeoutMs: cfg.reflectToolTimeoutMs, reflectBudget: cfg.reflectBudget, toolGuideExtra: cfg.toolGuideExtra, stampFor: () => buildRetainStamp(cfg, { directory: cwd, harness: 'pi', bankId }) });
      const converted = toPiTool(specs.find(s => s.name === declaration.name));
      const result = await converted.execute(api.callId, args);
      if (['hindsight_sync_status', 'hindsight_diagnose'].includes(declaration.name)) {
        const state = await api.snapshot(DeliveryState, api.conversationId, context);
        api.diagnostic({ severity: state?.intents.some(i => i.status !== 'acked') ? 'warn' : 'info', code: 'hindsight_delivery', message: JSON.stringify(durableDeliveryStatus(state)) });
      }
      return result;
    },
  }));
  const memoryNames = new Set(declarations.map(tool => tool.name));
  return defineExtension({ name: 'hindsight', tools,
    hooks: [hook(GenerationTask, { async beforeRequest(request, api, context) {
      const agent = await api.snapshot(AgentDoc, api.conversationId, context);
      if (!agent?.cwd) throw new Error('Hindsight requires this conversation\'s effective cwd');
      if (!(await resolveBinding(agent.cwd)).cfg.disabled) return undefined;
      // Filter every historical and current addition: pi-ai replays system deltas
      // in order. No removal delta is needed when no memory declaration is added.
      // Never alter native caller policy, persisted history, or non-system messages.
      return { messages: request.messages.map(message => message.role === 'system' && message.toolsAdded
        ? { ...message, toolsAdded: message.toolsAdded.filter(tool => !memoryNames.has(tool.name)) }
        : message) };
    } })],
    sections: [section('hindsight_memory', async (input, context) => {
      if (!getHost) return undefined;
      const { session, storage } = getHost();
      const prepared = await preparePlacedContext(session, storage, input.conversationId, context, { buildContext, lifecycleFor });
      return [prepared.context, prepared.notice].filter(Boolean).join('\n\n') || undefined;
    }, { tag: false })],
    // Durable 1.0.0 recovery bypasses afterTool and emits its own observable
    // `interrupted` diagnostic. Do not replace or swallow that result.
  });
}

// Query helper; beforeRequest applies the same config gate without changing
// AgentDoc's native caller selection or the registry.
export async function availableHindsightTools(cwd, { resolveBinding = resolvePiConfig } = {}) {
  return (await resolveBinding(cwd)).cfg.disabled ? [] : buildKnowledgeTools({}, '', { harness: 'pi' }).map(s => s.name);
}
