import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { effects, resetEffects, setMetadataFault, verifyProbes, loadedDependencies } from './effects.mjs';
import { ownedCache, prepareFixture, materialize } from '../materialize.mjs';

test.after(() => console.log(JSON.stringify({ dependency: 'zod@4.6.5 MIT, existing read-only donor', loadedModules: [...loadedDependencies] })));
const zero = Object.fromEntries(Object.keys(effects).map(key => [key, 0]));
let sequence = 0;
function newRoot() {
  let root;
  do { root = join(ownedCache, randomUUID().slice(0, 3)); } while (fs.existsSync(root));
  return root;
}
async function load(variant, path) { return import(pathToFileURL(join(variant, path)).href); }
async function refusal(action, expected, label, boundary) {
  let error;
  try { await action(); } catch (caught) { error = caught; }
  assert.ok(error, `${label}: must refuse`);
  if (boundary) assert.equal(error.fixtureBoundary, boundary, `${label}: first refusal boundary`);
  assert.match(String(error.message), new RegExp(`BB0_FIXTURE_REFUSED:${expected}(?:$|\\b)`), label);
}

const cases = [
  { name: 'valid private declaration, real socket absent', expected: 'PATH_MISSING' },
  { name: 'valid declaration, socket metadata injected only, runtime still unavailable', virtual: true, expected: 'STAGE2_NOT_ADMITTED' },
  { name: 'missing admission', change: (_, c) => { c.omitAdmission = true; }, expected: 'PATH_MISSING' },
  { name: 'missing binding', change: (_, c) => { c.omitBinding = true; }, expected: 'PATH_MISSING' },
  { name: 'malformed JSON', after: (r) => fs.writeFileSync(join(r, 'admission.json'), '{'), expected: 'JSON_MALFORMED' },
  { name: 'stale declaration', change: d => { d.createdAt -= 600000; d.expiresAt -= 600000; }, expected: 'DECLARATION_STALE' },
  { name: 'missing S declaration', change: d => { delete d.socket; }, expected: 'DECLARATION_SCHEMA' },
  { name: 'foreign mode', change: d => { d.mode = 'standalone'; }, expected: 'DECLARATION_MODE' },
  { name: 'inconsistent K', change: d => { d.sessionKey = `bb0_${randomUUID()}`; }, expected: 'DECLARATION_BINDING' },
  { name: 'unsafe key', change: d => { d.sessionKey = '../escape'; }, expected: 'DECLARATION_KEY' },
  { name: 'inconsistent C', change: d => { d.cwd += '/elsewhere'; }, expected: 'DECLARATION_CWD' },
  { name: 'inconsistent S', change: d => { d.socket += '.other'; }, expected: 'DECLARATION_SOCKET' },
  { name: 'binding S mismatch', change: (_, c) => { c.binding = { socket: '/synthetic/elsewhere' }; }, expected: 'BINDING_SOCKET' },
  { name: 'admission symlink', change: (_, c) => { c.omitAdmission = true; }, after: r => fs.symlinkSync('not-read', join(r, 'admission.json')), expected: 'PATH_SYMLINK' },
  { name: 'binding symlink', change: (_, c) => { c.omitBinding = true; }, after: (_, d) => fs.symlinkSync('not-read', join(d.bindingDirectory, 'shared-host.json')), expected: 'PATH_SYMLINK' },
  { name: 'wrong admission mode', after: r => fs.chmodSync(join(r, 'admission.json'), 0o644), expected: 'PATH_MODE' },
  { name: 'wrong B mode', after: (_, d) => fs.chmodSync(d.bindingDirectory, 0o755), expected: 'PATH_MODE' },
  { name: 'wrong C mode', after: (_, d) => fs.chmodSync(d.cwd, 0o755), expected: 'PATH_MODE' },
  { name: 'wrong binding mode', after: (_, d) => fs.chmodSync(join(d.bindingDirectory, 'shared-host.json'), 0o644), expected: 'PATH_MODE' },
  { name: 'missing C directory', after: (_, d) => fs.renameSync(d.cwd, d.cwd + '.retained'), expected: 'PATH_MISSING' },
  { name: 'missing B directory', after: (_, d) => fs.renameSync(d.bindingDirectory, d.bindingDirectory + '.retained'), expected: 'PATH_MISSING' },
  { name: 'C directory symlink', after: (_, d) => { fs.renameSync(d.cwd, d.cwd + '.retained'); fs.symlinkSync(d.cwd + '.retained', d.cwd); }, expected: 'PATH_SYMLINK' },
  { name: 'B directory symlink', after: (_, d) => { fs.renameSync(d.bindingDirectory, d.bindingDirectory + '.retained'); fs.symlinkSync(d.bindingDirectory + '.retained', d.bindingDirectory); }, expected: 'PATH_SYMLINK' },
  { name: 'foreign UID metadata injected on admission', fault: r => ({ path: join(r, 'admission.json'), foreignUid: true }), expected: 'PATH_UID' },
  { name: 'foreign UID socket metadata injected', fault: (_, d) => ({ path: d.socket, virtualSocket: true, foreignUid: true }), expected: 'PATH_UID' },
  { name: 'wrong socket mode metadata injected', fault: (_, d) => ({ path: d.socket, virtualSocket: true, mode: 0o140644 }), expected: 'PATH_MODE' },
  { name: 'socket symlink', after: (_, d) => fs.symlinkSync('not-read', d.socket), expected: 'PATH_SYMLINK' },
  { name: 'socket regular file, never accepted as socket', after: (_, d) => fs.writeFileSync(d.socket, '', { flag: 'wx', mode: 0o600 }), expected: 'PATH_TYPE' },
];

test('effect probes are live and never perform their forbidden operation', async () => {
  const observed = await verifyProbes();
  for (const key of Object.keys(observed)) assert.ok(observed[key] > 0, `live counter ${key}`);
  resetEffects();
});

for (const item of cases) test(item.name, async () => {
  setMetadataFault(null);
  const root = newRoot();
  const d = prepareFixture(root, item.change);
  const variant = materialize(root, { patches: process.env.STAGE1_CONTROL !== 'baseline' });
  if (process.env.STAGE1_MUTATION) {
    const mutations = JSON.parse(fs.readFileSync(new URL('./mutations.json', import.meta.url), 'utf8'));
    const mutation = mutations[process.env.STAGE1_MUTATION];
    assert.ok(mutation, 'known test-only mutation');
    const target = join(variant, mutation.path);
    const before = fs.readFileSync(target, 'utf8');
    assert.equal(before.split(mutation.before).length, 2, 'unique mutation site');
    fs.writeFileSync(target + '.pre-mutation', before, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(target, 0o600);
    fs.writeFileSync(target, before.replace(mutation.before, mutation.after));
    fs.chmodSync(target, 0o400);
  }
  item.after?.(root, d);
  setMetadataFault(item.fault?.(root, d) ?? (item.virtual ? { path: d.socket, virtualSocket: true } : null));
  resetEffects();
  const { ProviderBridge } = await load(variant, 'src/host/bridge.ts');
  const { ModelCatalog } = await load(variant, 'src/host/catalog.ts');
  const { SessionRegistry } = await load(variant, 'src/host/session-registry.ts');
  const { RunnerProcess } = await load(variant, 'src/host/runner-process.ts');
  const { handleDiscoveryRequest } = await load(variant, 'src/host/discovery-handler.ts');
  const { handleTurnStart } = await load(variant, 'src/host/bridge-router.ts');
  const childrenBefore = fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8');
  const output = [];
  const bridge = new ProviderBridge(line => output.push(JSON.parse(line)));
  const catalog = new ModelCatalog(join(root, 'work'));
  const registry = new SessionRegistry(() => { effects.submits++; });
  for (const method of ['initialize', 'model/list', 'provider/diagnostics', 'provider/health', 'provider/installation/status', 'provider/installation/run', 'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'thread/stop', 'thread/fork']) {
    const params = { threadId: d.expectedThreadId, providerThreadId: d.sessionKey, cwd: d.cwd, input: [{ type: 'text', text: 'MUST_NOT_SUBMIT' }] };
    await bridge.handleLine(JSON.stringify({ id: ++sequence, method, params }));
    const response = output.at(-1);
    assert.equal(response.error?.code, -32000, method);
    assert.ok(response.error?.message.endsWith(':BOUNDARY=bridge.request'), `${method}: bridge must refuse before discovery/createOrGet`);
    assert.match(response.error?.message ?? '', new RegExp(`BB0_FIXTURE_REFUSED:${item.expected}`), method);
    await refusal(() => handleDiscoveryRequest(method, params, catalog), item.expected, `direct discovery ${method}`, 'discovery.request');
  }
  for (const [name, action, boundary] of [
    ['catalog autoprewarm', () => catalog.listModels(), 'catalog.start'], ['catalog diagnostics', () => catalog.getDiagnostics(), 'provider/diagnostics'], ['catalog health', () => catalog.getHealth(), 'provider/health'],
    ['registry explicit start', () => registry.createOrGet(d.expectedThreadId, d.sessionKey, { cwd: d.cwd })],
    ['implicit turn cwd reconciliation', () => registry.reconcileCwd(d.expectedThreadId, d.cwd)],
    ['actual implicit turn router', () => handleTurnStart(1, { threadId: d.expectedThreadId, providerThreadId: d.sessionKey, cwd: d.cwd, input: 'MUST_NOT_SUBMIT' }, { registry, sendNotification() { effects.submits++; }, sendResult() { effects.submits++; }, sendError() { effects.submits++; } })],
    ['direct RunnerProcess', () => new RunnerProcess({ cwd: d.cwd, args: ['--no-session'] })],
    ['host worker entry', () => load(variant, 'src/host/index.ts')],
  ]) await refusal(action, item.expected, name, boundary);
  const oldArgv = process.argv;
  try {
    process.argv = [process.execPath, 'fixture-runner', '--no-session', '--cwd', d.cwd];
    await refusal(() => load(variant, 'src/runner/index.ts'), item.expected, 'direct --no-session entry');
  } finally { process.argv = oldArgv; }
  const { default: plugin } = await load(variant, 'server.ts');
  let registrations = 0;
  let handlers;
  const bb = {
    settings: { define() {} }, rpc: { register(_contract, value) { handlers = value; } },
    providers: { register() { registrations++; return {}; } },
  };
  if (item.virtual) {
    plugin(bb);
    assert.equal(registrations, 1, 'metadata-only registration after complete injected preflight');
    await refusal(() => handlers.diagnostics_get(), item.expected, 'actual registered diagnostics_get handler');
  } else {
    await refusal(() => plugin(bb), item.expected, 'server registration');
    assert.equal(registrations, 0, 'invalid admission must not publish metadata/autoprewarm');
  }
  assert.deepEqual(effects, zero, 'zero forbidden effects across actual variant callpaths');
  assert.equal(fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8'), childrenBefore, 'no new process children');
  const stores = [];
  function findStores(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) findStores(path);
      else if (/(?:\.sqlite(?:-wal|-shm)?|\.lock)$/.test(entry.name)) stores.push(path);
    }
  }
  findStores(root);
  assert.deepEqual(stores, [], 'no SQLite/storage lock created in synthetic fixture');
  console.log(JSON.stringify({ case: item.name, root, variant, expected: item.expected, effects, nativeSocketProof: 'NOT_REACHED', sdk: 'metadata-only test doubles' }));
  setMetadataFault(null);
});

test('pure private admission succeeds; actual request fields reject foreign thread/key/cwd/env', async () => {
  const root = newRoot();
  const d = prepareFixture(root);
  const variant = materialize(root);
  const admission = await load(variant, 'src/fixture-admission.mjs');
  resetEffects();
  const pure = admission.admitPureFixture();
  assert.equal(pure.sessionKey, d.sessionKey);
  assert.equal(pure.runtimeAdmission, 'UNAVAILABLE');
  setMetadataFault({ path: d.socket, virtualSocket: true });
  assert.equal(admission.admitPrivateFixture().sessionKey, d.sessionKey);
  const { ProviderBridge } = await load(variant, 'src/host/bridge.ts');
  const output = [];
  const bridge = new ProviderBridge(line => output.push(JSON.parse(line)));
  for (const [method, params, expected] of [
    ['thread/start', { threadId: 'another-thread' }, 'REQUEST_THREAD'],
    ['thread/start', {}, 'REQUEST_THREAD'],
    ['thread/start', { threadId: d.expectedThreadId, providerThreadId: 'foreign-key' }, 'REQUEST_KEY'],
    ['thread/start', { threadId: d.expectedThreadId, providerThreadId: d.sessionKey + ':child' }, 'REQUEST_KEY'],
    ['thread/resume', { threadId: d.expectedThreadId }, 'REQUEST_REOPEN_KEY'],
    ['turn/start', { threadId: d.expectedThreadId, cwd: d.cwd + '/other' }, 'REQUEST_CWD'],
    ['turn/start', { threadId: d.expectedThreadId, options: { cwd: d.cwd + '/other' } }, 'REQUEST_CWD'],
    ['thread/start', { threadId: d.expectedThreadId, shellEnvOverrides: {} }, 'REQUEST_ENV'],
    ['turn/start', { threadId: d.expectedThreadId, options: { envVars: {} } }, 'REQUEST_ENV'],
    ['thread/start', { threadId: d.expectedThreadId }, 'STAGE2_NOT_ADMITTED'],
    ['thread/resume', { threadId: d.expectedThreadId, providerThreadId: d.sessionKey }, 'STAGE2_NOT_ADMITTED'],
  ]) {
    await bridge.handleLine(JSON.stringify({ id: ++sequence, method, params }));
    assert.match(output.at(-1).error?.message ?? '', new RegExp(`BB0_FIXTURE_REFUSED:${expected}`));
  }
  assert.deepEqual(effects, zero);
  console.log(JSON.stringify({ case: 'request identity refusals', root, effects, bootstrapIdentityContract: 'NOT_REACHED', reopenRuntime: 'UNAVAILABLE' }));
  setMetadataFault(null);
});
