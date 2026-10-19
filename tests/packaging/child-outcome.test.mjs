import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Unit seam only: native document tokens are opaque keys. Real owner admission,
// SQLite/reopen and execution are deliberately not claimed by this fake reader.
const directory = await mkdtemp(join(tmpdir(), 'bb-child-outcome-'));
let readCoherentOutcome, createChildControl, createChildObservationService, controlChild, observeChild;
try {
  const result = await build({ stdin: { contents: `export {readCoherentOutcome} from './src/outcome/coherent.ts';
    export {createChildControl} from './src/native/child-control.ts';
    export {createChildObservationService} from './src/native/child-observation.ts';
    export {controlChild,observeChild} from './src/history/observation-client.ts';`, resolveDir: resolve('.') }, bundle: true, write: false,
    platform: 'node', format: 'esm', plugins: [{ name: 'native-document-unit-seam', setup(builder) {
      builder.onResolve({ filter: /^@bb-durable\/native-subagents$/ }, () => ({ path: 'documents', namespace: 'unit' }));
      builder.onLoad({ filter: /.*/, namespace: 'unit' }, () => ({ contents: 'export const ChildBindingDoc={kind:"binding"},SubagentsDoc={kind:"agents"},TeamDoc={kind:"team"};' }));
      builder.onResolve({ filter: /^@earendil-works\// }, args => ({ path: new URL(import.meta.resolve(args.path)).pathname, external: true }));
    } }] });
  const path = join(directory, 'outcome.mjs');
  await writeFile(path, result.outputFiles[0].text);
  ({ readCoherentOutcome, createChildControl, createChildObservationService, controlChild, observeChild } = await import(pathToFileURL(path).href));
} finally { await rm(directory, { recursive: true, force: true }); }

const entries = [
  { id: 91, conversationId: 61, kind: 'pi.user', model: [{ role: 'user', content: 'first input' }] },
  { id: 92, conversationId: 61, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: {} }] }] },
  { id: 93, conversationId: 61, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'OK' }], isError: false }], data: { diagnostics: [] } },
  { id: 94, conversationId: 61, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'not a report' }] }] },
  { id: 120, conversationId: 61, kind: 'pi.user', model: [{ role: 'user', content: 'second input' }] },
  { id: 125, conversationId: 61, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '{"not":"ChildReport"}' }] }] },
];
function reader({ foreign = false, mutate = false, missing = false } = {}) {
  const team = { executions: {
    spawn: { child: 61, key: 'child', requestId: 'spawn' },
    followUp: { child: 61, key: 'child', requestId: 'send' },
  } };
  return {
    async snapshot(token) {
      if (token.kind === 'binding') return { binding: { parent: 1, key: 'child', anchor: 8 } };
      if (token.kind === 'agents') return { agents: { child: { conversationId: 61, ownerTaskId: 8, requestId: 'spawn' } } };
      return team;
    },
    async readOutcomeHistory() {
      if (mutate) team.executions.new = { child: 61, key: 'child', requestId: 'new' };
      return { conversation: { id: 61, owner: { conversationId: 1, taskId: foreign ? 9 : 8 } },
        submission: missing ? undefined : { id: 70, conversationId: 61, type: 'input', requestId: 'send', status: 'done', entry: 120, answer: 125 },
        entries, stable: true, active: false, truncated: false, unsupported: false };
    },
  };
}

test('latest authoritative receipt projects a multi-turn child, not the original spawn answer', async () => {
  const result = await readCoherentOutcome(reader(), 61, {});
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.requestId, 'send');
  assert.equal(result.answer, 125);
  assert.deepEqual(result.entries, entries);
});
test('foreign anchor cannot expose child history', async () => {
  const result = await readCoherentOutcome(reader({ foreign: true }), 61, {});
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'owner-mismatch');
});
test('a new execution during capture invalidates the frame', async () => {
  const result = await readCoherentOutcome(reader({ mutate: true }), 61, {});
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'execution-changed');
});
test('missing authoritative receipt cannot become terminal success', async () => {
  const result = await readCoherentOutcome(reader({ missing: true }), 61, {});
  assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'receipt-unavailable');
});

const owner = { providerId: 'pi-durable', sessionId: 'session', parentThreadId: 'parent' };
const binding = { ...owner, conversationId: 61, bbThreadId: 'child' };
test('native controls use existing admission and never configure or create an owner', async () => {
  const calls = [];
  const session = { ...reader(), async commit(fn) { return fn({ conversation: async () => ({ id: 61, owner: { conversationId: 1, taskId: 8 } }) }); },
    async conversation() { return { id: 61, async abort() { calls.push('abort'); }, configure() { throw Error('must not configure'); } }; } };
  const registry = { snapshot: () => ({ extension: () => undefined }) };
  const control = createChildControl(session, registry, owner, { async submit(target, message, mode, requestId) {
    calls.push({ id: target.id, message, mode, requestId }); return { id: 501 };
  } }, {});
  assert.deepEqual(await control(binding, { type: 'prompt', message: 'follow-up', requestId: 'stable-input' }, {}),
    { conversationId: 61, command: 'prompt', requestId: 'stable-input', submissionId: 501 });
  assert.equal(calls[0].mode, 'followUp');
  await assert.rejects(control({ ...binding, sessionId: 'foreign' }, { type: 'abort' }, {}), /REFUSED/);
  assert.equal(calls.length, 1);
});

test('receipt settlement refreshes history after run_end without another model event', { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-child-settlement-'));
  const base = reader(), closed = Promise.withResolvers(), first = Promise.withResolvers(), terminal = Promise.withResolvers();
  let active = true, notify, stopped = false, service, observation;
  try {
    const definition = createChildObservationService({ ownerScope: owner, socketPath: join(root, 's'), revision: 'receipt-unit' });
    service = await definition.bind({ ...base,
      async snapshot(token) { return ['binding', 'agents', 'team'].includes(token.kind) ? base.snapshot(token) : { binding }; },
      async readOutcomeHistory(...args) { return { ...await base.readOutcomeHistory(...args), active }; },
      subscribeOutcome(_id, callback) { notify = callback; return () => { stopped = true; }; },
      async watchExisting() { return { snapshot: { type: 'snapshot', entries: [], agent: {}, tools: [], nestedTools: [], compactions: [], inbox: [], usage: {} },
        closed: closed.promise, start() {}, async stop() { closed.resolve(); } }; },
    }, {});
    observation = await observeChild({ socketPath: join(root, 's'), binding, onSnapshot: async () => {}, onEvents: async () => {},
      onOutcome: async frame => { if (frame.status === 'working') first.resolve(); if (frame.status === 'completed') terminal.resolve(); } });
    await first.promise;
    active = false; notify(); // Native submission commits after the final model/run event.
    await terminal.promise;
  } finally { await observation?.close(); await service?.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(stopped, true, 'receipt listener is released with its observation');
});

test('private socket refuses sibling/foreign aliases before invoking any control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bb-child-ctl-'));
  let handle;
  const commands = [];
  try {
    const service = createChildObservationService({ ownerScope: owner, socketPath: join(root, 's'), revision: 'control-unit' });
    handle = await service.bind({ async snapshot(_token, cid) {
      return { binding: { ...binding, conversationId: cid, bbThreadId: cid === 61 ? 'child' : 'sibling' } };
    } }, {}, undefined, async (actual, command) => {
      commands.push({ actual, command }); return { conversationId: actual.conversationId, command: command.type,
        ...(command.type === 'abort' ? {} : { requestId: command.requestId, submissionId: 501 }) };
    });
    await assert.rejects(controlChild({ socketPath: join(root, 's'), binding: { ...binding, conversationId: 62 }, command: { type: 'abort' } }), /REFUSED|UNCONFIRMED/);
    assert.equal(commands.length, 0);
    const receipt = await controlChild({ socketPath: join(root, 's'), binding, command: { type: 'prompt', message: 'hello', requestId: 'stable' } });
    assert.equal(receipt.submissionId, 501); assert.equal(commands.length, 1);
    assert.equal(commands[0].actual.conversationId, 61);
  } finally { await handle?.close(); await rm(root, { recursive: true, force: true }); }
});
