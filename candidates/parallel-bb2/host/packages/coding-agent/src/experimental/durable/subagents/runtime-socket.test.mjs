import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { register } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension, defineTool, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { listenSharedHost } from '../shared-server.ts';
import { installSubagentOwner } from '../subagent-runtime.ts';

// This checkout is a sparse source overlay. Resolve its missing host imports from the read-only
// 0.2.29 reference source and dependency tree; the runtime under test remains the candidate file.
const candidateHost = fileURLToPath(new URL('../../../../../../', import.meta.url));
const candidateSource = join(candidateHost, 'packages/coding-agent/src');
const referenceHost = '/home/ubuntu/.local/share/pi-durable/host';
const referenceSource = join(referenceHost, 'packages/coding-agent/src');
const sharedNodeModules = '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules';
const resolverSource = `
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sources = [{ candidate: ${JSON.stringify(candidateSource)}, reference: ${JSON.stringify(referenceSource)} }];
const hostRoots = [${JSON.stringify(candidateHost)}, ${JSON.stringify(referenceHost)}];
const referenceHost = ${JSON.stringify(referenceHost)};
const testUrl = ${JSON.stringify(import.meta.url)};
const sharedUrl = pathToFileURL(join(${JSON.stringify(sharedNodeModules)}, '__bb2_resolver__.mjs')).href;
const within = (path, root) => path === root || path.startsWith(root + '/');
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : undefined;
  const source = sources.find((root) => parent && (within(parent, root.candidate) || within(parent, root.reference)));
  if (source && specifier.startsWith('.')) {
    const from = within(parent, source.candidate) ? source.candidate : source.reference;
    const target = fileURLToPath(new URL(specifier, context.parentURL));
    const relativeTarget = relative(from, target);
    if (!isAbsolute(relativeTarget) && relativeTarget !== '..' && !relativeTarget.startsWith('../')) {
      const candidatePath = join(source.candidate, relativeTarget);
      if (existsSync(candidatePath)) return nextResolve(pathToFileURL(candidatePath).href, context);
      const referencePath = join(source.reference, relativeTarget);
      if (existsSync(referencePath)) return nextResolve(pathToFileURL(referencePath).href, context);
    }
  }
  if (specifier === '@earendil-works/pi-durable/mcp-codemode') {
    return nextResolve(pathToFileURL(join(referenceHost, 'packages/durable/src/mcp-codemode.ts')).href, context);
  }
  if (parent && hostRoots.some((root) => within(parent, root)) && !specifier.startsWith('.')
      && !specifier.startsWith('node:') && !specifier.startsWith('#')) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      for (const parentURL of [testUrl, sharedUrl]) {
        try { return await nextResolve(specifier, { ...context, parentURL }); }
        catch (fallbackError) {
          if (fallbackError.code !== 'ERR_MODULE_NOT_FOUND' && fallbackError.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw fallbackError;
        }
      }
      throw error;
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(resolverSource)}`, import.meta.url);
const [{ openDurable, agentOf }, { ModelRuntime }] = await Promise.all([
  import('../runtime.ts'),
  import(pathToFileURL(join(referenceSource, 'core/model-runtime.ts')).href),
]);
const durableEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-durable'));
const durableVersion = JSON.parse(await readFile(join(dirname(dirname(durableEntry)), 'package.json'), 'utf8')).version;
assert.equal(durableVersion, '1.2.0', 'the startup fixture uses the installed SDK 1.2 package');

const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('bounded socket wait exceeded')), 5000); timer.unref();
})]);
function latch() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function eventsFor(client, id) {
  return client.messages.filter(m => m.type === 'agent_events' && String(m.conversationId) === String(id)).flatMap(m => m.events);
}
function socketClient(path) {
  const socket = createConnection(path);
  socket.setEncoding('utf8');
  const messages = [];
  const waiters = new Set();
  let buffer = '';
  const receive = message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) {
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message);
    }
  };
  socket.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      receive(JSON.parse(line));
    }
  });
  const waitFor = predicate => {
    const present = messages.find(predicate);
    if (present) return Promise.resolve(present);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('socket message not received')); }, 5000);
      waiter.timer.unref(); waiters.add(waiter);
    });
  };
  return {
    socket, messages, waitFor,
    async attach(cwd) {
      const response = waitFor(message => message.type === 'response' && message.id === 'attach');
      socket.write(`${JSON.stringify({ type: 'attach', id: 'attach', cwd })}\n`);
      return bounded(response);
    },
    async prompt(id, message) {
      const response = waitFor(item => item.type === 'response' && item.id === id);
      socket.write(`${JSON.stringify({ type: 'prompt', id, message })}\n`);
      return bounded(response);
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bb2-runtime-socket-'));
  const socketPath = join(directory, 'host.sock');
  const entered = latch(), released = latch();
  let childCalls = 0;
  const provider = fauxProvider();
  const models = createModels(); models.setProvider(provider.provider);
  const registry = createRegistry();
  installSubagentOwner(registry);
  registry.install(defineExtension({ name: 'socket-gate', tools: [defineTool({
    name: 'gate', parameters: Type.Object({}), replay: 'unsafe',
    execute: async (_args, _api, ctx) => {
      childCalls++; entered.resolve();
      await new Promise((resolve, reject) => {
        const signal = ctx.abortSignal;
        const abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        released.promise.then(resolve).finally(() => signal?.removeEventListener('abort', abort));
      });
      return { output: [{ type: 'text', text: 'gate released' }] };
    },
  })] }));
  const respond = transcript => {
    const messages = transcript.messages;
    const user = messages.findLast(message => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const last = messages.at(-1);
    if (text?.includes('child-task')) {
      return last?.role === 'toolResult' ? fauxAssistantMessage('child-result')
        : fauxAssistantMessage(fauxToolCall('gate', {}), { stopReason: 'toolUse' });
    }
    if (text?.includes('Subagent worker answered: child-result')) return fauxAssistantMessage('report-ack');
    if (last?.role === 'toolResult') return fauxAssistantMessage('foreground-result');
    if (text === 'foreground' || text === 'background') {
      return fauxAssistantMessage(fauxToolCall('subagent', {
        task: 'child-task', name: 'worker', requestId: `socket-${text}`, background: text === 'background',
      }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('unexpected synthetic turn');
  };
  provider.setResponses(Array.from({ length: 40 }, () => respond));
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'fixture.sqlite')), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
  const rootState = await root.viewState(context);
  const cwd = process.cwd();
  const view = {
    current: () => ({ session: { id: 'private-fixture', directory, cwd }, conversation: rootState.value, conversations: [], models: [], notices: [] }),
    subscribe: listener => rootState.subscribe(listener),
  };
  const host = {
    harness, view, modelRuntime: models,
    submitTo: async (id, text, whenBusy) => {
      const conversation = await harness.conversation(id, context);
      await conversation.submit({ type: 'input', content: text, whenBusy }, context);
    },
  };
  const shared = await listenSharedHost(host, socketPath);
  const client = socketClient(socketPath);
  await once(client.socket, 'connect');
  const attached = await client.attach(cwd);
  assert.equal(attached.success, true);
  return { directory, entered, released, childCalls: () => childCalls, harness, rootState, shared, client };
}

async function openDurableFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bb2-open-durable-'));
  const agentDir = join(directory, 'agent');
  const cwd = join(directory, 'workspace');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const adapterPath = join(directory, 'hindsight-adapter.mjs');
  const entered = latch(), released = latch();
  let childCalls = 0;
  const gateExtension = defineExtension({ name: 'socket-gate', tools: [defineTool({
    name: 'gate', parameters: Type.Object({}), replay: 'unsafe',
    execute: async (_args, _api, ctx) => {
      childCalls++; entered.resolve();
      await new Promise((resolve, reject) => {
        const signal = ctx.abortSignal;
        const abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        released.promise.then(resolve).finally(() => signal?.removeEventListener('abort', abort));
      });
      return { output: [{ type: 'text', text: 'gate released' }] };
    },
  })] });
  const stateKey = Symbol.for('bb2.runtime-socket.open-durable-hindsight');
  const hindsight = { ownerRegistrations: 0, bound: 0, admissions: [], closed: 0, entered, released, gateExtension };
  hindsight.controller = {
    async bind(host) { hindsight.bound++; hindsight.context = host.context; },
    async admit(conversation, requestId) {
      hindsight.admissions.push({ conversationId: conversation.id, requestId });
    },
    async submit(conversation, content, whenBusy) {
      hindsight.submitCalls ??= [];
      hindsight.submitCalls.push({ content, whenBusy });
      return conversation.submit({ type: 'input', content, whenBusy }, hindsight.context);
    },
    async drain() { return []; },
    async close() { hindsight.closed++; },
  };
  hindsight.extension = defineExtension({ name: 'hindsight', tools: [], tasks: [] });
  globalThis[stateKey] = hindsight;
  await writeFile(adapterPath, `
const state = globalThis[Symbol.for("bb2.runtime-socket.open-durable-hindsight")];
export default function installFixtureExtensions(registry) {
  registry.install(state.gateExtension);
  registry.install(state.extension);
  state.ownerRegistrations = registry.snapshot().installed().filter((item) => item.name === "subagent").length;
  Object.defineProperty(registry.snapshot().extension("hindsight"),
    Symbol.for("pi.durable.hindsight.controller"), { value: state.controller });
  return registry;
};
`, { mode: 0o600 });
  const provider = fauxProvider();
  const respond = (transcript) => {
    const messages = transcript.messages;
    const user = messages.findLast((message) => message.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const last = messages.at(-1);
    if (text?.includes('child-task')) {
      return last?.role === 'toolResult' ? fauxAssistantMessage('child-result')
        : fauxAssistantMessage(fauxToolCall('gate', {}), { stopReason: 'toolUse' });
    }
    if (text?.includes('Subagent worker answered: child-result')) return fauxAssistantMessage('report-ack');
    if (last?.role === 'toolResult') return fauxAssistantMessage('foreground-result');
    if (text === 'foreground' || text === 'background') {
      return fauxAssistantMessage(fauxToolCall('subagent', {
        task: 'child-task', name: 'worker', requestId: `open-durable-${text}`, background: text === 'background',
      }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('unexpected synthetic turn');
  };
  provider.setResponses(Array.from({ length: 80 }, () => respond));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const originalCreate = ModelRuntime.create;
  let runtime;
  let shared;
  let client;
  const cleanup = async () => {
    client?.socket.destroy();
    try { await shared?.close(); }
    finally {
      try { await runtime?.close(); }
      finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        delete globalThis[stateKey];
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    ModelRuntime.create = async function () {
      const modelRuntime = await originalCreate.call(this, {
        authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(provider.provider);
      await modelRuntime.setRuntimeApiKey(provider.provider.id, 'private-faux-key');
      return modelRuntime;
    };
    runtime = await openDurable({ cwd, mcp: false, extensions: [adapterPath] });
    const sessionRelative = relative(agentDir, runtime.view.current().session.directory);
    assert.ok(!isAbsolute(sessionRelative) && sessionRelative !== '..' && !sessionRelative.startsWith('../'),
      'openDurable stores its session beneath the private fixture data root');
    assert.equal(hindsight.ownerRegistrations, 1, 'actual startup registry contains one production subagent owner');
    assert.equal(hindsight.bound, 1, 'the startup-published Hindsight controller is bound once');
    await runtime.controller.setModel({ provider: provider.getModel().provider, modelId: provider.getModel().id });
    assert.equal(agentOf(runtime.view.current().conversation).model?.modelId, provider.getModel().id,
      'the isolated root uses the registered faux model');
    shared = await listenSharedHost(runtime, join(directory, 'host.sock'));
    client = socketClient(join(directory, 'host.sock'));
    await once(client.socket, 'connect');
    const attached = await client.attach(runtime.view.current().session.cwd);
    assert.equal(attached.success, true);
    return { directory, entered, released, childCalls: () => childCalls, runtime, shared, client, hindsight, cleanup };
  } catch (error) {
    ModelRuntime.create = originalCreate;
    await cleanup();
    throw error;
  } finally {
    ModelRuntime.create = originalCreate;
  }
}

async function startChild(f, mode) {
  const response = await f.client.prompt(`prompt-${mode}`, mode);
  assert.equal(response.success, true);
  await bounded(f.entered.promise);
  const rootEvents = eventsFor(f.client, ROOT_CONVERSATION_ID);
  const registration = rootEvents.find(event => event.type === 'tool_execution_update' && typeof event.details?.conversationId === 'number');
  const admittedChild = f.hindsight?.admissions.find(item => String(item.conversationId) !== String(ROOT_CONVERSATION_ID));
  const childId = registration?.details?.conversationId ?? admittedChild?.conversationId;
  assert.ok(childId !== undefined, 'the production subagent tool or Hindsight admission identifies the child conversation');
  await bounded(f.client.waitFor(message => message.type === 'agent_events' && String(message.conversationId) === String(childId)
    && message.events.some(event => event.type === 'tool_execution_start' && event.toolName === 'gate')));
  assert.equal(f.childCalls(), 1);
  return childId;
}

test('production owner traverses the actual shared socket: foreground waits at child gate', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const childId = await startChild(f, 'foreground');
    assert.ok(eventsFor(f.client, childId).some(event => event.type === 'tool_execution_start' && event.toolName === 'gate'));
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 0,
      'foreground parent has not completed while its child gate is closed');
    f.released.resolve();
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'message_end' && JSON.stringify(event.entry?.model).includes('foreground-result'))));
    assert.equal(f.childCalls(), 1);
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 1);
  } finally {
    f.released.resolve(); f.client.socket.destroy(); await f.shared.close(); f.rootState.dispose(); await f.harness.close(context);
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('production owner traverses the actual shared socket: background frees parent and Courier delivers once', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    const childId = await startChild(f, 'background');
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'run_end')));
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 1,
      'background parent is idle before child gate release');
    assert.ok(eventsFor(f.client, childId).some(event => event.type === 'tool_execution_start' && event.toolName === 'gate'));
    f.released.resolve();
    const report = 'Subagent worker answered: child-result';
    const delivered = await bounded(f.client.waitFor(message => message.type === 'shared_view'
      && JSON.stringify(message.view.conversation).includes(report)));
    const transcript = JSON.stringify(delivered.view.conversation);
    assert.equal(transcript.split(report).length - 1, 1, 'actual socket view contains one canonical Courier parent input');
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'message_end' && JSON.stringify(event.entry?.model).includes('report-ack'))));
    assert.equal(f.childCalls(), 1);
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 2,
      'one parent run before release and one Courier-report run after release');
  } finally {
    f.released.resolve(); f.client.socket.destroy(); await f.shared.close(); f.rootState.dispose(); await f.harness.close(context);
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('openDurable startup installs one owner and keeps Hindsight admission on the foreground path', { timeout: 15000 }, async () => {
  const f = await openDurableFixture();
  try {
    assert.equal(f.hindsight.ownerRegistrations, 1);
    assert.equal(f.hindsight.bound, 1);
    const childId = await startChild(f, 'foreground');
    assert.equal(f.hindsight.admissions.length, 1);
    assert.equal(String(f.hindsight.admissions[0].conversationId), String(childId));
    assert.match(f.hindsight.admissions[0].requestId, /^subagent:/);
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 0,
      'foreground openDurable parent stays blocked while child gate is closed');
    f.released.resolve();
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'message_end' && JSON.stringify(event.entry?.model).includes('foreground-result'))));
    assert.equal(f.childCalls(), 1);
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 1);
  } finally {
    f.released.resolve();
    await f.cleanup();
  }
  assert.equal(f.hindsight.closed, 1, 'the startup-bound Hindsight controller closes once');
});

test('openDurable startup frees the parent and admits one exactly-once Courier report', { timeout: 15000 }, async () => {
  const f = await openDurableFixture();
  try {
    assert.equal(f.hindsight.ownerRegistrations, 1);
    assert.equal(f.hindsight.bound, 1);
    const childId = await startChild(f, 'background');
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'run_end')));
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 1,
      'openDurable background parent is idle while the child gate is closed');
    f.released.resolve();
    const report = 'Subagent worker answered: child-result';
    const delivered = await bounded(f.client.waitFor(message => message.type === 'shared_view'
      && JSON.stringify(message.view.conversation).includes(report)));
    const transcript = JSON.stringify(delivered.view.conversation);
    assert.equal(transcript.split(report).length - 1, 1, 'one canonical Courier input crossed the actual shared socket');
    await bounded(f.client.waitFor(message => message.type === 'agent_events'
      && String(message.conversationId) === String(ROOT_CONVERSATION_ID)
      && message.events.some(event => event.type === 'message_end' && JSON.stringify(event.entry?.model).includes('report-ack'))));
    const finalTranscript = JSON.stringify(f.runtime.view.current().conversation);
    assert.equal(finalTranscript.split(report).length - 1, 1, 'the final runtime view retains exactly one Courier report');
    assert.equal(f.childCalls(), 1, 'the background child executes once');
    assert.equal(eventsFor(f.client, ROOT_CONVERSATION_ID).filter(event => event.type === 'run_end').length, 2,
      'one parent run and one Courier report run');
    const childAdmissions = f.hindsight.admissions.filter((item) => String(item.conversationId) === String(childId));
    const courierAdmissions = f.hindsight.admissions.filter((item) => String(item.conversationId) === String(ROOT_CONVERSATION_ID));
    assert.equal(childAdmissions.length, 1, 'the child has one Hindsight admission');
    assert.match(childAdmissions[0].requestId, /^subagent:/);
    assert.equal(courierAdmissions.length, 1, 'the Courier report has one Hindsight admission');
    assert.match(courierAdmissions[0].requestId, /^subagent-batch:/);
  } finally {
    f.released.resolve();
    await f.cleanup();
  }
  assert.equal(f.hindsight.closed, 1, 'the startup-bound Hindsight controller closes once');
});
