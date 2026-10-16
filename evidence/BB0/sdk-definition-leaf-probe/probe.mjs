// SOURCE-ONLY candidate. Actual leaf execution requires a separate coordinator GO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';

const SDK = '/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/plugin-sdk-runtime.js';
const SDK_SHA = '62c27b9bbb127417f2c3e13494289fd36f999c09614c120826785955935d4126';
const ZOD = '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/zod';
const ZOD_MAP_SHA = 'b54753d60453a9944906ba0c666040116ebedc33aadeb8fc042b18ce4a37b917';
const GO = 'sdk-definition-leaf-v1'; // Admission marker, NOT authentication or OS proof.
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const emit = process.stdout.write.bind(process.stdout);
const events = [];
const forbidden = Object.create(null);
let targetImports = 0;
const event = (name, data = {}) => events.push({ sequence: events.length, name, ...data });
const output = (value) => emit(JSON.stringify(value) + '\n');

function admissionReason(args, env) {
  if (args.length !== 1 || args[0] !== '--execute-leaf') return 'EXPLICIT_LEAF_MODE_REQUIRED';
  if (env.BB0_SDK_LEAF_GO !== GO) return 'SEPARATE_EXECUTION_GO_REQUIRED';
  return null;
}

function installEffectGuards() {
  const restore = [];
  const deny = (label) => function blockedEffect() {
    forbidden[label] = (forbidden[label] ?? 0) + 1;
    event('forbidden-attempt', { surface: label });
    throw new Error('OBSERVED_FORBIDDEN_EFFECT');
  };
  const patch = (object, key, label) => {
    const own = Object.getOwnPropertyDescriptor(object, key);
    const d = own ?? { value: object[key], configurable: true, writable: true, enumerable: false };
    if (!('value' in d) || typeof d.value !== 'function') return;
    if (!d.configurable && !d.writable) throw new Error('GUARD_SURFACE_NOT_PATCHABLE');
    Object.defineProperty(object, key, { ...d, value: deny(label) });
    forbidden[label] ??= 0;
    restore.push(() => { if (own) Object.defineProperty(object, key, own); else delete object[key]; });
  };
  const all = (object, label) => {
    for (const key of Object.getOwnPropertyNames(object)) patch(object, key, `${label}.${key}`);
  };
  // Guard ordinary public calls, NOT Node internals/native bindings/OS syscalls.
  try {
  all(fs, 'fs'); all(fsp, 'fs.promises'); all(childProcess, 'child_process');
  all(dns, 'dns'); all(dns.promises, 'dns.promises');
  for (const [object, label, keys] of [
    [net, 'net', ['connect', 'createConnection', 'createServer', 'Socket', 'Server']],
    [tls, 'tls', ['connect', 'createServer', 'TLSSocket', 'Server']],
    [http, 'http', ['request', 'get', 'createServer', 'ClientRequest', 'Agent']],
    [https, 'https', ['request', 'get', 'createServer', 'Agent']],
    [http2, 'http2', ['connect', 'createServer', 'createSecureServer']],
    [dgram, 'dgram', ['createSocket', 'Socket']],
    [workerThreads, 'worker_threads', ['Worker', 'MessageChannel']],
    [net.Socket.prototype, 'net.Socket.prototype', ['connect']],
    [net.Server.prototype, 'net.Server.prototype', ['listen']],
    [process, 'process', ['exit', 'abort', 'kill', 'chdir', 'dlopen', 'getBuiltinModule']],
    [process.stdout, 'stdout', ['write']], [process.stderr, 'stderr', ['write']],
    [globalThis, 'global', ['fetch', 'WebSocket', 'EventSource', 'setTimeout', 'setInterval', 'setImmediate']],
  ]) for (const key of keys) patch(object, key, `${label}.${key}`);
  syncBuiltinESMExports();
  } catch (error) {
    for (const undo of restore.reverse()) undo();
    syncBuiltinESMExports();
    throw error;
  }
  return () => { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); };
}

async function executeLeaf() {
  event('admission-marker-present');
  assert.equal(process.versions.node, '24.19.0');
  assert.equal(process.execArgv.length, 0, 'No preload/loader/other Node flags admitted');
  assert.equal(process.env.NODE_OPTIONS ?? '', '');
  // These checks inspect environment STRINGS only, never their config contents.
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    assert.ok(process.env[key]?.startsWith('/bb0-state/'), `Fresh confined ${key} required`);
  }
  assert.equal(process.env.PI_AGENT_DIR, '/bb0-state/agent');
  assert.equal(process.env.PI_CODING_AGENT_DIR, '/bb0-state/agent');
  event('environment-strings-checked');
  const manifestPath = new URL('./pin-manifest.json', import.meta.url);
  const pins = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(pins.schema, 'bb0-sdk-definition-leaf-pins-v1');
  assert.equal(pins.sdk.path, SDK); assert.equal(pins.sdk.sha256, SDK_SHA);
  assert.equal(pins.zod.length, 95);
  const canonical = [...pins.zod].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map((row) => `${row.path}\t${row.sha256}\n`).join('');
  assert.equal(sha(canonical), ZOD_MAP_SHA);
  const rows = [pins.sdk, ...pins.zod];
  assert.equal(new Set(rows.map((r) => r.path)).size, 96);
  const allowed = new Map();
  for (const row of rows) {
    assert.ok(row.path === SDK || row.path.startsWith(`${ZOD}/`));
    assert.equal(fs.realpathSync(row.path), row.path, 'Canonical public sources only');
    const bytes = fs.readFileSync(row.path);
    assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    allowed.set(pathToFileURL(row.path).href, row);
  }
  const metadataPins = new Map([
    [`${ZOD}/package.json`, 'a046ed85fa09571dba539fee9ef236152d12dabd1f229b014ec3bd2ebaad9000'],
    ['/home/ubuntu/.bb-server/app/node_modules/bb-app/package.json', '5bd18210c67fe46ddc6ee99ec05092504825c375cae2b43d8117241392e2a241'],
  ]);
  assert.equal(pins.packageMetadata.length, 2);
  assert.equal(new Set(pins.packageMetadata.map((row) => row.path)).size, 2);
  for (const row of pins.packageMetadata) {
    assert.equal(row.sha256, metadataPins.get(row.path));
    const bytes = fs.readFileSync(row.path);
    assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
  }
  event('public-source-pins-checked', { modules: allowed.size });
  let restore;
  let hook;
  try {
    restore = installEffectGuards();
    event('ordinary-effect-guards-installed', { guardedFunctions: Object.keys(forbidden).length });
    forbidden.sourceURL = 0;
    const builtins = new Set(['node:module', 'node:path', 'node:url']);
    hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context);
        if (!builtins.has(resolved.url) && !allowed.has(resolved.url)) {
          forbidden.sourceURL = (forbidden.sourceURL ?? 0) + 1;
          event('forbidden-source-url');
          throw new Error('SOURCE_URL_NOT_ADMITTED');
        }
        event('resolve-admitted', { url: resolved.url });
        return resolved;
      },
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        if (builtins.has(url)) return loaded;
        const row = allowed.get(url);
        assert.ok(row, 'Only pinned source URLs');
        assert.equal(loaded.format, 'module');
        const bytes = Buffer.from(loaded.source);
        assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
        event('load-source-pinned', { url });
        return loaded; // ORIGINAL bytes; never rewritten, generated, shimmed or bundled.
      },
    });
    event('source-url-guards-installed');
    event('sdk-import-start'); targetImports += 1;
    const sdk = await import(pathToFileURL(SDK).href);
    event('sdk-import-complete');
    assert.equal(typeof sdk.defineRpcContract, 'function');
    event('zod-import-start'); targetImports += 1;
    const { z } = await import(pathToFileURL(path.join(ZOD, 'index.js')).href);
    event('zod-import-complete');
    // Exact existing contract.ts object/schema shape; TS-only generic is erased.
    // diagnostics_get is a schema declaration, NOT an RPC handler invocation.
    const fixture = {
      diagnostics_get: {
        input: z.object({}).optional(),
        output: z.object({ report: z.custom() }),
      },
    };
    event('real-zod-schemas-constructed');
    event('actual-defineRpcContract-start');
    const contract = sdk.defineRpcContract(fixture);
    event('actual-defineRpcContract-complete');
    assert.equal(contract, fixture);
    assert.deepEqual(Object.keys(contract), ['diagnostics_get']);
    assert.deepEqual(Object.keys(contract.diagnostics_get), ['input', 'output']);
    assert.equal(contract.diagnostics_get.input, fixture.diagnostics_get.input);
    assert.equal(contract.diagnostics_get.output, fixture.diagnostics_get.output);
    assert.equal(typeof contract.diagnostics_get.input['~standard'].validate, 'function');
    assert.equal(contract.diagnostics_get.input.safeParse(undefined).success, true);
    assert.equal(contract.diagnostics_get.input.safeParse({}).success, true);
    assert.equal(contract.diagnostics_get.input.safeParse(null).success, false);
    assert.equal(contract.diagnostics_get.output.safeParse({ report: { synthetic: 'leaf-only' } }).success, true);
    assert.equal(contract.diagnostics_get.output.safeParse(null).success, false);
    assert.equal(Object.values(forbidden).reduce((a, b) => a + b, 0), 0);
    event('leaf-identity-and-schema-assertions-complete');
    const names = events.map((e) => e.name);
    for (const [before, after] of [
      ['public-source-pins-checked', 'ordinary-effect-guards-installed'],
      ['source-url-guards-installed', 'sdk-import-start'],
      ['sdk-import-complete', 'zod-import-start'],
      ['zod-import-complete', 'actual-defineRpcContract-start'],
      ['actual-defineRpcContract-complete', 'leaf-identity-and-schema-assertions-complete'],
    ]) {
      assert.ok(names.indexOf(before) >= 0 && names.indexOf(after) >= 0);
      assert.ok(names.indexOf(before) < names.indexOf(after));
    }
    return { status: 'LEAF_OBSERVATIONS_NEEDS_INDEPENDENT_CHECKS', targetImports, events, forbidden,
      rpcMethodsInvoked: 0, osConfinementProvenByThisProcess: false,
      originalProviderLoaderProven: false, compiledOrderingProven: false };
  } finally {
    hook?.deregister(); restore?.();
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--refusal-self-test') {
  for (const [argv, env] of [[[], {}], [['--execute-leaf'], {}], [['--execute-leaf'], { BB0_SDK_LEAF_GO: 'wrong' }], [['--unknown'], { BB0_SDK_LEAF_GO: GO }]]) {
    assert.notEqual(admissionReason(argv, env), null);
  }
  output({ status: 'REFUSAL_BRANCH_SELF_CHECK_ONLY', cases: 4, targetImports, sdkOrZodEvaluated: false });
} else {
  const reason = admissionReason(args, process.env);
  if (reason) {
    output({ status: 'REFUSED_BEFORE_TARGET_IMPORT', reason, targetImports, sdkOrZodEvaluated: false });
    process.exitCode = 77;
  } else {
    try { output(await executeLeaf()); }
    catch {
      output({ status: 'LEAF_FAILED_OR_UNAVAILABLE', targetImports, events, forbidden,
        osConfinementProvenByThisProcess: false, originalProviderLoaderProven: false, compiledOrderingProven: false });
      process.exitCode = 1;
    }
  }
}
