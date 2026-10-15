import { spawn } from 'node:child_process';
import { defineDoc } from '@earendil-works/pi-durable';
import * as pinned from './bridge.mjs';

export const LifecycleState = defineDoc({ kind: 'hindsight.lifecycle', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ epochs: [] }) });
// Documents are accessed by token, not registered with the task registry.
export function registerLifecycle(registry) { const extension = { name: 'hindsight.lifecycle' }; registry.install(extension); return extension; }
const empty = () => ({ additionalContext: '', deferInitialReflect: false });
const keyOf = b => JSON.stringify([b.cwd, b.bankId, b.cfg.apiUrl]);

// Effects remain process-local. Never persist configuration, credentials or raw errors.
// A committed intent precedes each unsupported effect; reopening that gap is
// uncertain, not permission to repeat a detached launch or usage append.
export function createLifecycle(session, effects = {}) {
  const env = effects.env ?? process.env;
  const diagnostic = effects.diagnostic ?? (() => {});
  const gated = b => b.cfg.disabled || Boolean(env.HINDSIGHT_DISABLE_HOOKS);
  async function edit(id, binding, context, fn, usage = false) {
    return session.commit(async tx => {
      const state = await tx.doc(LifecycleState, id);
      // Usage revisits historical delivery epochs, not just the startup cache's
      // last cwd/bank/API key. Store only stable refs and accounting receipts.
      if (usage && binding.usageEpochRef) {
        state.usageEpochs ??= [];
        let epoch = state.usageEpochs.find(e => e.ref === binding.usageEpochRef);
        if (!epoch) { state.usageEpochs.push({ ref: binding.usageEpochRef, usageCursor: 0, usageStatus: 'idle' }); epoch = state.usageEpochs.at(-1); }
        return fn(epoch);
      }
      const key = keyOf(binding);
      let epoch = state.epochs.at(-1);
      if (!epoch || epoch.key !== key) { state.epochs.push({ key, actions: {}, context: null, usageCursor: 0, usageStatus: 'idle' }); epoch = state.epochs.at(-1); }
      return fn(epoch);
    }, context);
  }
  async function action(id, binding, context, name, run, detached = false) {
    const admitted = await edit(id, binding, context, e => {
      const previous = e.actions[name];
      if (previous) { if (previous.status === 'intent') previous.status = 'uncertain'; return false; }
      e.actions[name] = { status: 'intent' }; return true;
    });
    if (!admitted) return false;
    let status = 'uncertain'; let result;
    try { result = await run(); status = detached ? result === true ? 'launched' : result === false ? 'not-launched' : 'uncertain' : 'completed'; } catch { diagnostic('lifecycle_uncertain', { action: name, bank: binding.bankId }); }
    await edit(id, binding, context, e => { e.actions[name].status = status; });
    if (status === 'uncertain') diagnostic('lifecycle_uncertain', { action: name, bank: binding.bankId });
    return result;
  }
  async function lifecycleFor(id, binding, context) {
    if (gated(binding)) return empty();
    const cached = await edit(id, binding, context, e => e.context ? JSON.parse(JSON.stringify(e.context)) : null);
    if (cached) return cached;
    const { cfg, cwd, bankId } = binding;
    if (cfg.serverMode === 'daemon') await action(id, binding, context, 'daemon', async () => {
      const opts = effects.daemon ?? {};
      let launched, attempted = false;
      const trackedSpawn = (...args) => {
        attempted = true;
        const child = (opts.spawnFn ?? spawn)(...args);
        if (child?.pid) launched = true;
        return child;
      };
      await pinned.ensureDaemon(cfg, 'pi', { ...opts, spawnFn: trackedSpawn,
        ...(opts.launch ? { launch: (...args) => { attempted = true; launched = opts.launch(...args); } } : {}) });
      // Successful return without visiting launch proves a healthy/preflight
      // no-op. A swallowed spawn failure remains unknown, never acknowledged.
      return attempted ? launched : false;
    }, true);
    if (cfg.autoUpdate) await action(id, binding, context, 'update', () => pinned.maybeAutoUpdate(cfg, effects.update ?? {}));
    try {
      const nativeClient = await (effects.resolveClient ?? (b => pinned.resolveHostMemory('pi', b.cwd).client))(binding);
      const client = new Proxy(nativeClient, { get(target, key) {
        if (key === 'retain' && target.retain) return (...args) => action(id, binding, context, `baseline:${args[2]}`, () => target.retain(...args));
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      // Native bank management options, through the same intent-before-effect
      // lane as startup. Do not reset banks or substitute native session retention.
      if (client.configureBank) await action(id, binding, context, 'configure-bank', () => client.configureBank({
        manage: cfg.manageBankConfig, extractionMode: cfg.retainExtractionMode,
        defaults: cfg.defaultBankConfig, pageTrigger: pinned.buildPageTrigger(cfg),
        pages: cfg.pages, customPages: cfg.customPages,
      }));
      const result = await pinned.buildSessionStartContext({ cwd, bankId, cfg, client, harness: 'pi',
        hasGit: effects.hasGit, headSha: effects.headSha, commitsSince: effects.commitsSince,
        diagnostic: (_h, event, data) => diagnostic(event, data),
        startSeed: (dir, opts) => action(id, binding, context, 'seed', () => {
          if (effects.startSeed) return effects.startSeed(dir, { ...opts, ...effects.seed });
          let launched;
          pinned.startBackgroundSeed(dir, { ...opts, ...effects.seed, spawn: (...args) => {
            const child = (effects.seed?.spawn ?? spawn)(...args);
            if (child?.pid) launched = true;
            return child;
          } });
          return launched;
        }, true),
        startSurvey: (dir, opts) => action(id, binding, context, 'survey', () => (effects.startSurvey ?? pinned.startCodebaseSurvey)(dir, { ...opts, ...effects.survey, cfg, bankId }), true)
      });
      const prepared = { additionalContext: result.additionalContext ?? '', deferInitialReflect: result.deferInitialReflect === true };
      await edit(id, binding, context, e => { e.context = prepared; });
      diagnostic('session_start', { bank: bankId, systemMessage: result.systemMessage });
      return prepared;
    } catch {
      diagnostic('lifecycle_unavailable', { bank: bankId });
      return empty();
    }
  }
  async function recordUsage(id, binding, turns, lastTurnComplete, context) {
    if (gated(binding) || binding.cfg.retainSessions === false) return;
    const usageEdit = fn => edit(id, binding, context, fn, true);
    const sessionId = binding.usageSessionId ?? String(id);
    let cursor;
    await usageEdit(e => { if (e.usageStatus === 'intent') e.usageStatus = 'uncertain'; cursor = e.usageCursor; });
    // Reuse native turn accounting and JSONL formatting, capturing bytes only.
    let lines; let next = cursor;
    pinned.recordUsage({ turns, lastTurnComplete, sessionId, harness: 'pi', bankId: binding.bankId, now: effects.now,
      cursors: { read: () => cursor, write: (_id, n) => { next = n; } }, append: (_path, text) => { lines = text; } });
    if (!lines) return;
    const admitted = await usageEdit(e => { if (e.usageStatus === 'uncertain' || e.usageStatus === 'intent' || e.usageCursor !== cursor) return false; e.usageStatus = 'intent'; return true; });
    if (!admitted) { diagnostic('usage_uncertain', { bank: binding.bankId }); return; }
    let acknowledged = false;
    pinned.recordUsage({ turns, lastTurnComplete, sessionId, harness: 'pi', bankId: binding.bankId, now: effects.now,
      path: effects.usagePath, append: effects.usageAppend,
      cursors: { read: () => cursor, write: () => { acknowledged = true; } } });
    await usageEdit(e => { e.usageStatus = acknowledged ? 'acknowledged' : 'uncertain'; if (acknowledged) e.usageCursor = next; });
    if (!acknowledged) diagnostic('usage_uncertain', { bank: binding.bankId });
  }
  return { lifecycleFor, recordUsage };
}
