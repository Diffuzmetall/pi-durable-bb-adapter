import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const zodRoot = '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/zod';
const hash = value => createHash('sha256').update(value).digest('hex');
if (hash(fs.readFileSync(zodRoot + '/package.json')) !== 'a046ed85fa09571dba539fee9ef236152d12dabd1f229b014ec3bd2ebaad9000' || hash(fs.readFileSync(zodRoot + '/index.js')) !== '32e7efd49a94a765f6d10a1a0a3c02c50c246def17c80c6f0225f85525d98505') throw new Error('PINNED_ZOD_CHANGED');
export const loadedDependencies = new Map();

export const effects = globalThis.__bb0Stage1Effects = {
  localPiModuleImports: 0, resourceInitializations: 0, runnerSpawns: 0,
  sessionConstructions: 0, storageOpens: 0, submits: 0, socketConnects: 0, unexpectedConfigReads: 0,
};
export function resetEffects() { for (const key of Object.keys(effects)) effects[key] = 0; }
export let metadataFault = null;
export function setMetadataFault(value) { metadataFault = value; }
const real = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: fs.readFileSync, openSync: fs.openSync };
fs.lstatSync = function(path, ...args) {
  if (metadataFault?.path === String(path)) {
    const stat = metadataFault.virtualSocket ? real.lstatSync(dirname(String(path))) : real.lstatSync(path, ...args);
    return new Proxy(stat, { get(target, key) {
      if (metadataFault.virtualSocket && key === 'isSocket') return () => true;
      if (metadataFault.virtualSocket && key === 'isSymbolicLink') return () => false;
      if (key === 'mode' && metadataFault.virtualSocket) return metadataFault.mode ?? 0o140600;
      if (key === 'uid' && metadataFault.foreignUid) return process.getuid() + 1;
      return Reflect.get(target, key);
    } });
  }
  return real.lstatSync(path, ...args);
};
fs.realpathSync = function(path, ...args) {
  if (metadataFault?.virtualSocket && metadataFault.path === String(path)) return String(path);
  return real.realpathSync(path, ...args);
};
function watchRead(path) {
  if (typeof path !== 'number' && /(?:^|\/)(?:auth\.json|models\.json|settings\.json|session\.sqlite)(?:$|[-.])/.test(String(path))) {
    effects.unexpectedConfigReads++;
    throw new Error('FORBIDDEN_CONFIG_READ');
  }
}
fs.readFileSync = function(path, ...args) { watchRead(path); return real.readFileSync(path, ...args); };
fs.openSync = function(path, ...args) { watchRead(path); return real.openSync(path, ...args); };
cp.spawn = function() { effects.runnerSpawns++; throw new Error('FORBIDDEN_SPAWN'); };
net.connect = net.createConnection = function() { effects.socketConnects++; throw new Error('FORBIDDEN_CONNECT'); };
syncBuiltinESMExports();

const bump = name => `globalThis.__bb0Stage1Effects.${name}++;`;
const body = name => `${bump(name)} throw new Error('FORBIDDEN_${name}');`;
const stubs = {
  'model-setup.ts': `${bump('localPiModuleImports')} export async function setupRunnerModels(){${body('resourceInitializations')}}`,
  'diagnostics.ts': `${bump('localPiModuleImports')} export async function inspectPiEnvironment(){${body('resourceInitializations')}}`,
  'runtime.ts': `${bump('localPiModuleImports')} export async function openDurable(){${body('storageOpens')}}`,
  'session.ts': `${bump('localPiModuleImports')} export class PiThreadSession { constructor(){${body('sessionConstructions')}} }`,
  'session-commands.ts': `${bump('localPiModuleImports')} export async function handleActiveSessionCommand(){${body('submits')}}`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'zod') return nextResolve(pathToFileURL(zodRoot + '/index.js').href, context);
    const leaf = specifier.split('/').at(-1);
    let source = stubs[leaf];
    if (specifier === 'node:sqlite') source = `export class DatabaseSync { constructor(){${body('storageOpens')}} }`;
    if (specifier.endsWith('/rpc/contract.ts')) source = 'export const rpcContract = {};';
    if (specifier === '@get-bb/plugin-sdk/host') source = 'export const experimental_defineHostEntry = x => x; export const experimental_nativeRootsHostContract = {};';
    if (specifier === '@get-bb/plugin-sdk/provider-bridge') source = 'export const experimental_defineProviderBridge = x => x;';
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source + '\n//' + context.parentURL)}`, shortCircuit: true };
    if (specifier.startsWith('@earendil-works/')) {
      effects.localPiModuleImports++;
      throw new Error('FORBIDDEN_PI_DEPENDENCY');
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:') && !specifier.startsWith('node:')) throw new Error(`UNADMITTED_DEPENDENCY:${specifier}`);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(pathToFileURL(zodRoot + '/').href)) loadedDependencies.set(url, hash(real.readFileSync(new URL(url))));
    return nextLoad(url, context);
  },
});

export async function verifyProbes() {
  resetEffects();
  for (const [specifier, call] of [
    ['./model-setup.ts', m => m.setupRunnerModels()], ['./runtime.ts', m => m.openDurable()],
    ['./session.ts', m => new m.PiThreadSession()], ['./session-commands.ts', m => m.handleActiveSessionCommand()],
  ]) {
    const module = await import(specifier);
    await Promise.resolve().then(() => call(module)).catch(() => {});
  }
  try { cp.spawn('must-not-execute'); } catch {}
  try { net.connect('must-not-connect'); } catch {}
  try { fs.readFileSync('/synthetic/auth.json'); } catch {}
  return { ...effects };
}
