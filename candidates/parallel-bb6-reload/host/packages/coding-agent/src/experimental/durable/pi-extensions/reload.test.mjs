import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const sdkRoot = process.env.BB5_SDK_ROOT;
assert.ok(sdkRoot, 'BB5_SDK_ROOT must name the published Pi SDK 1.2.0 package directory');
const sdk = JSON.parse(await readFile(join(sdkRoot, 'package.json'), 'utf8'));
assert.equal(sdk.name, '@earendil-works/pi-coding-agent');
assert.equal(sdk.version, '1.2.0');
const durableRoot = process.env.PI_DURABLE_SDK_ROOT;
assert.ok(durableRoot, 'PI_DURABLE_SDK_ROOT must name the published Durable SDK package directory');
const jitiEntry = '/home/ubuntu/.local/share/pi-durable/host/node_modules/jiti/lib/jiti.mjs';
const aliases = new Map();
const aliasPatterns = [];
for (const [name, directory] of [
  ['@earendil-works/pi-coding-agent', sdkRoot],
  ['@earendil-works/pi-durable', durableRoot],
  ['@earendil-works/pi-ai', join(durableRoot, '../pi-ai')],
  ['@earendil-works/chord', join(durableRoot, '../chord')],
  ['@earendil-works/pi-codemode', join(durableRoot, '../pi-codemode')],
  ['@earendil-works/pi-tui', join(sdkRoot, '../pi-tui')],
]) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (!pkg.exports) {
    aliases.set(name, pathToFileURL(join(directory, pkg.module ?? pkg.main)).href);
    continue;
  }
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    let target = value;
    while (typeof target === 'object' && target !== null) target = target.import ?? target.default;
    if (typeof target !== 'string') continue;
    if (subpath.includes('*')) {
      aliasPatterns.push({ prefix: name + subpath.slice(1).split('*')[0], directory, target });
    } else {
      aliases.set(name + (subpath === '.' ? '' : subpath.slice(1)), pathToFileURL(join(directory, target)).href);
    }
  }
}
const codingAgentEntry = pathToFileURL(join(sdkRoot, 'dist/index.js')).href;
registerHooks({ resolve(specifier, context, next) {
  const alias = aliases.get(specifier);
  if (alias) return { url: alias, shortCircuit: true };
  for (const pattern of aliasPatterns) {
    if (specifier.startsWith(pattern.prefix)) {
      const target = pattern.target.replaceAll('*', specifier.slice(pattern.prefix.length));
      return { url: pathToFileURL(resolve(pattern.directory, target)).href, shortCircuit: true };
    }
  }
  if (specifier === '@earendil-works/pi-coding-agent') return { url: codingAgentEntry, shortCircuit: true };
  if (specifier === 'jiti') return { url: pathToFileURL(jitiEntry).href, shortCircuit: true };
  if (context.parentURL?.startsWith(pathToFileURL(candidateRuntime).href)) {
    if (specifier === './mcp.ts') {
      // mcp:false makes this unrelated startup branch inert; the runtime and reload caller remain real.
      return { url: 'data:text/javascript,export%20const%20openDurableMcp%3Dasync()%3D%3E%7Bthrow%20new%20Error(%22disabled%20in%20runtime%20fixture%22)%7D%3Bexport%20const%20openConfiguredDurableMcp%3DopenDurableMcp', shortCircuit: true };
    }
    if (specifier === './extensions.ts') {
      return { url: pathToFileURL(join(candidateHost, '.pi/extensions/durable-reload/index.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('./pi-extensions/')) {
      const relativePath = specifier.slice('./pi-extensions/'.length);
      const candidatePath = join(candidateDurable, 'pi-extensions', relativePath);
      if (existsSync(candidatePath)) return { url: pathToFileURL(candidatePath).href, shortCircuit: true };
      const bb5Path = join(bb5, relativePath);
      if (existsSync(bb5Path)) return { url: pathToFileURL(bb5Path).href, shortCircuit: true };
    }
    if (specifier.startsWith('.')) {
      const candidatePath = resolve(dirname(candidateRuntime), specifier);
      if (!existsSync(candidatePath)) {
        const basePath = resolve(baseDurable, relative(candidateDurable, candidatePath));
        if (existsSync(basePath)) return { url: pathToFileURL(basePath).href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
} });

const repo = resolve(import.meta.dirname, '../../../../../../../../../');
const candidateHost = join(repo, 'candidates/parallel-bb6-reload/host');
const candidateDurable = join(candidateHost, 'packages/coding-agent/src/experimental/durable');
const baseDurable = '/home/ubuntu/.local/share/pi-durable/host/packages/coding-agent/src/experimental/durable';
const candidateRuntime = join(candidateDurable, 'runtime.ts');
const bb5 = join(repo, 'candidates/parallel-bb5/host/packages/coding-agent/src/experimental/durable/pi-extensions');
const { loadPiResources } = await import(pathToFileURL(join(bb5, 'loader.ts')).href);
const { createPiToolRegistration } = await import(pathToFileURL(join(bb5, 'tool-bridge.ts')).href);
const { createPiRegistryPreparer } = await import(pathToFileURL(join(repo, 'candidates/parallel-bb6-reload/host/packages/coding-agent/src/experimental/durable/pi-extensions/reload-registry.ts')).href);
const { createRegistry } = await import('@earendil-works/pi-durable');
const { DurableExtensions } = await import(pathToFileURL(join(repo, 'candidates/parallel-bb6-reload/host/.pi/extensions/durable-reload/index.ts')).href);
const { openDurable } = await import(pathToFileURL(candidateRuntime).href);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bb6-reload-'));
  const cwd = join(root, 'project'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi/extensions'), { recursive: true });
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  return { root, cwd, agentDir };
}

function nativeRegistry() {
  const registry = createRegistry();
  registry.install({ name: 'native-owner', tools: [{
    name: 'native_tool', description: 'Native owner fixture', parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: [{ type: 'text', text: 'OLD_NATIVE_TOOL' }] }),
  }], sections: [{ key: 'native_doc', render: () => 'PERSISTED_NATIVE_DOC' }], tasks: [{ definition: {
    name: 'persisted_task', version: 1, initial: {}, phases: {}, abort: {},
  } }] });
  return registry;
}

async function actualPiPreparer(f, previousPiExtensionNames = []) {
  const extensionPath = join(f.cwd, '.pi/extensions/fixture.ts');
  await writeFile(extensionPath, `export default function(pi) { pi.registerTool({
    name: 'fixture_reload_tool', label: 'Fixture', description: 'Offline reload fixture',
    parameters: { type: 'object', properties: {} },
    execute: async (_callId, _args, _signal, _update, ctx) => ({ content: [{ type: 'text', text: ctx.cwd }], details: {} }),
  }); }`);
  return createPiRegistryPreparer({
    cwd: f.cwd, agentDir: f.agentDir, previousPiExtensionNames,
    resources: [{ path: extensionPath, kind: 'extension', enabled: true, admitted: true }],
  }, loadPiResources, createPiToolRegistration);
}

test('publishes one prepared registry containing real Pi registrations and preserved native owners', async () => {
  const f = await fixture(), base = nativeRegistry();
  base.install({ name: 'old-pi-extension', tools: [{
    name: 'fixture_reload_tool', description: 'Prior Pi tool', parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: [{ type: 'text', text: 'OLD_PI_TOOL' }] }),
  }] });
  const facade = new DurableExtensions(base, f.cwd, [], await actualPiPreparer(f, ['old-pi-extension']));
  let publications = 0;
  facade.subscribe(() => publications++);
  assert.equal(await facade.reload(async () => {}), 1);
  assert.equal(publications, 1);
  const snapshot = facade.snapshot();
  assert.ok(snapshot.tools().some(({ tool }) => tool.name === 'native_tool'));
  assert.ok(snapshot.tools().some(({ tool }) => tool.name === 'fixture_reload_tool'));
  assert.equal(snapshot.extension('old-pi-extension'), undefined);
  assert.equal(snapshot.sections().some(({ section }) => section.key === 'native_doc'), true);
  assert.ok(snapshot.task('persisted_task'));
  const registration = snapshot.tools().find(({ tool }) => tool.name === 'fixture_reload_tool').tool;
  const result = await registration.execute({}, { callId: 'fixture-call', agent: async () => ({ cwd: f.cwd }) }, { abortSignal: new AbortController().signal });
  assert.equal(result.output[0].text, f.cwd);
});

test('loader failure preserves prior Pi/native tools and native definitions', async () => {
  const f = await fixture(), base = nativeRegistry();
  base.install({ name: 'old-pi-extension', tools: [{
    name: 'old_pi_tool', description: 'Prior Pi tool', parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: [{ type: 'text', text: 'OLD_PI_TOOL' }] }),
  }] });
  const failedResource = join(f.cwd, '.pi/extensions/missing.ts');
  const prepare = createPiRegistryPreparer({
    cwd: f.cwd, agentDir: f.agentDir, resources: [{ path: failedResource, kind: 'extension', enabled: true, admitted: true }],
    previousPiExtensionNames: ['old-pi-extension'],
  }, loadPiResources, createPiToolRegistration);
  const facade = new DurableExtensions(base, f.cwd, [], prepare);
  await assert.rejects(facade.reload(async () => {}), /Pi candidate rejected|Pi extension loading failed/);
  assert.ok(facade.snapshot().task('persisted_task'));
  assert.ok(facade.snapshot().sections().some(({ section }) => section.key === 'native_doc'));
  const oldPi = facade.snapshot().tools().find(({ tool }) => tool.name === 'old_pi_tool').tool;
  assert.equal((await oldPi.execute()).output[0].text, 'OLD_PI_TOOL');
  const native = facade.snapshot().tools().find(({ tool }) => tool.name === 'native_tool').tool;
  assert.equal((await native.execute()).output[0].text, 'OLD_NATIVE_TOOL');
});

test('active background task holds reload before candidate initialization and disposes the graph', async () => {
  const f = await fixture(), base = nativeRegistry();
  let disposed = false, initialized = false;
  const facade = new DurableExtensions(base, f.cwd, [], async (registry) => { initialized = true; return registry; });
  await assert.rejects(facade.reloadWhenIdle({ taskGraph: async () => ({ value: { tasks: { backgroundTask: {} } }, dispose() { disposed = true; } }) }, {}), /Cannot reload while tasks are active/);
  assert.equal(initialized, false);
  assert.equal(disposed, true);
  assert.ok(facade.snapshot().task('persisted_task'));
  const native = facade.snapshot().tools().find(({ tool }) => tool.name === 'native_tool').tool;
  assert.equal((await native.execute()).output[0].text, 'OLD_NATIVE_TOOL');
});

test('actual openDurable controller reload replaces Pi registrations and refreshes its tool inventory', async () => {
  const f = await fixture();
  const extensionPath = join(f.cwd, '.pi/extensions/runtime-fixture.ts');
  const replacementPath = join(f.cwd, '.pi/extensions/runtime-replacement.ts');
  const writeExtension = (path, name) => writeFile(path, `export default function(pi) { pi.registerTool({
    name: '${name}', label: 'Runtime fixture', description: 'Actual openDurable reload caller',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: '${name}' }], details: {} }),
  }); }`);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  let opened;
  try {
    await writeExtension(extensionPath, 'runtime_startup_tool');
    const resources = [{ path: extensionPath, kind: 'extension', enabled: true, admitted: true }];
    opened = await openDurable({
      cwd: f.cwd,
      mcp: false,
      piResources: {
        agentDir: f.agentDir,
        resources,
      },
    });
    const initial = opened.view.current().toolInventory.map(({ name }) => name);
    assert.ok(initial.includes('runtime_startup_tool'));
    const nativeBefore = initial.filter((name) => name !== 'runtime_startup_tool').sort();

    await writeExtension(replacementPath, 'runtime_replacement_tool');
    resources[0] = { ...resources[0], path: replacementPath };
    await opened.controller.reload();

    const state = opened.view.current();
    const after = state.toolInventory.map(({ name }) => name);
    assert.ok(after.includes('runtime_replacement_tool'), JSON.stringify({ after, notices: state.notices }));
    assert.ok(!after.includes('runtime_startup_tool'));
    assert.deepEqual(after.filter((name) => name !== 'runtime_replacement_tool').sort(), nativeBefore);
    assert.match(state.notices.at(-1).message, /^Reloaded 1 Durable extension\(s\)\. Session preserved\.$/);
  } finally {
    try {
      if (opened) await opened.close();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
