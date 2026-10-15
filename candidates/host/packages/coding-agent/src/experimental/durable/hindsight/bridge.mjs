// Pinned algorithms, not a Durable runtime. Importing this module performs no
// config reads or backend effects. Calling live helpers may do both.
import * as pinned from './vendor/pi.mjs';
import { fileURLToPath } from 'node:url';
export { default } from './vendor/pi.mjs';
export {
  resolveHostConfig, loadConfig,
  buildKnowledgeTools, toPiTool, buildPageTrigger, buildRetainStamp,
  buildSessionStartContext, buildHookOutput, readPiMessages,
  memoryCursorStore, memoryUsageCursorStore, retainLiveSession, recordUsage,
  createRuntime, createPiHooks, createPiExtension,
  uuidV5, planRetain, renderSessionJsonl, fingerprintTurns, ensureDaemon,
  startBackgroundSeed, startCodebaseSurvey, buildSurveyPlan
} from './vendor/pi.mjs';

// The pinned lookup client deliberately tolerates 404. Retain must not inherit
// that convention: a resolved POST is acceptance evidence for the durable outbox.
// Keep the original authentication refresh and every non-retain request intact.
export function withRetainAcceptance(client) {
  const fetchWithAuth = client.fetchWithAuth.bind(client);
  client.fetchWithAuth = async (url, init) => {
    const response = await fetchWithAuth(url, init);
    if (init.method === 'POST' && url === client.bankUrl('/memories') && !response.ok) {
      throw Object.assign(new Error(`retain rejected (${response.status})`), { status: response.status, accepted: false });
    }
    return response;
  };
  return client;
}
export function resolveHostMemory(harness, directory) {
  const resolved = pinned.resolveHostMemory(harness, directory);
  return { ...resolved, client: withRetainAcceptance(resolved.client) };
}

// Omit the synthetic argument to use the ordinary Pi config/auth pipeline.
// Synthetic mode never reads config files or process env: callers supply layers.
// The small pipeline below follows resolveHostConfig using the same bindings.
export function resolvePiConfig(directory, synthetic) {
  if (synthetic === undefined) return pinned.resolveHostConfig('pi', directory);
  const { raw = {}, env = {} } = synthetic;
  const layered = pinned.applyLayer(pinned.applyLayer({}, pinned.readEnvConfig(env), 'pi'), raw, 'pi');
  if (!layered.harness) layered.harness = 'pi';
  const cfg = pinned.resolveConfig(layered);
  if (cfg.disabled) return { cfg, bankId: '' };
  const bankId = pinned.deriveBankIdOrSkip(cfg, directory, 'pi');
  if (bankId === null) return { cfg: { ...cfg, disabled: true }, bankId: '' };
  return pinned.applyBankConfig(cfg, bankId, directory);
}

// Inject the memory resolver/client, without replacing core runtime behavior.
// U2-U4 should compose the standalone helpers for Durable effects, not call the
// original fire-and-forget seedIfCold/retain lifecycle as a delivery engine.
export function createPiRuntime(directory, { resolveMemory = resolveHostMemory } = {}) {
  const { cfg, bankId, client } = resolveMemory('pi', directory);
  if (cfg.disabled) return undefined;
  return new pinned.RuntimeCore(client, bankId, cfg, 'pi', directory);
}

// pi.mjs is intentionally at vendor root (rather than upstream dist/). Route
// update's package lookup to the retained package metadata; no update on import.
// All effects require explicit invocation/authorization. Session-start accepts
// client/hasGit/startSeed/startSurvey/headSha/commitsSince injections upstream;
// retain accepts client/cursors, daemon/update accept their upstream opts.
export function maybeAutoUpdate(cfg, opts = {}) {
  return pinned.maybeAutoUpdate(cfg, { pkgRoot: fileURLToPath(new URL('./vendor/', import.meta.url)), ...opts });
}
