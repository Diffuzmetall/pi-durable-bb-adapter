import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/jiti/lib/jiti.mjs';

const sdk = '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/@earendil-works/pi-durable';
const sdkUrl = pathToFileURL(join(sdk, 'dist/index.js')).href;
const contextUrl = pathToFileURL(join(sdk, '../chord/dist/context/index.js')).href;
const sqliteUrl = pathToFileURL(join(sdk, 'dist/storage/sqlite/node.js')).href;
const [{ createSession, defineDoc, ROOT_CONVERSATION_ID }, { openNodeSqliteStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
  import(sdkUrl), import(sqliteUrl), import(contextUrl),
]);
const BindingDocForCorruption = defineDoc({
  kind: 'bb.native-child-binding',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ binding: null }),
});
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-durable': sdkUrl } });
const { createDurableBindingStore } = await jiti.import(new URL('../src/binding-store.ts', import.meta.url).pathname);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bb3-binding-'));
  const path = join(directory, 'candidate.sqlite');
  const storage = await openNodeSqliteStorage(path);
  const session = createSession(storage);
  await storage.commit([{ type: 'conversation', value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
  return { path, session, store: createDurableBindingStore(session, BACKGROUND_CONTEXT) };
}

test('Durable binding survives SQLite reopen and rejects conflicting identity tuples', async () => {
  const f = await fixture();
  const binding = {
    backendId: 'bb-provider-test',
    sessionId: 'session-test',
    conversationId: ROOT_CONVERSATION_ID,
    bbThreadId: 'thread-a',
    parentThreadId: 'thread-root',
  };
  try {
    await f.store.put(binding);
    await f.store.put({ ...binding });
    assert.deepEqual(await f.store.get(ROOT_CONVERSATION_ID), binding);
    assert.deepEqual(await f.store.findByThread({ backendId: binding.backendId, sessionId: binding.sessionId, bbThreadId: binding.bbThreadId }), binding);
    assert.equal(await f.store.findByThread({ backendId: binding.backendId, sessionId: 'other-session', bbThreadId: binding.bbThreadId }), undefined);
    assert.equal(await f.store.findByThread({ backendId: binding.backendId, sessionId: binding.sessionId, bbThreadId: 'missing-thread' }), undefined);
  } finally {
    await f.session.close(BACKGROUND_CONTEXT);
  }

  const reopened = createSession(await openNodeSqliteStorage(f.path));
  const store = createDurableBindingStore(reopened, BACKGROUND_CONTEXT);
  try {
    assert.deepEqual(await store.get(ROOT_CONVERSATION_ID), binding);
    assert.deepEqual(await store.findByThread({ backendId: binding.backendId, sessionId: binding.sessionId, bbThreadId: binding.bbThreadId }), binding);
    await assert.rejects(store.put({ ...binding, bbThreadId: 'forged-thread' }), /different BB binding/);
    const other = await reopened.commit(tx => tx.createConversation({ ownership: { kind: 'ownerless' } }), BACKGROUND_CONTEXT);
    await assert.rejects(store.put({ ...binding, conversationId: other.id }), /already bound to another Durable conversation/);
    assert.deepEqual(await store.get(ROOT_CONVERSATION_ID), binding);
    await assert.rejects(store.get(0), /Invalid Durable conversation ID/);
    await assert.rejects(store.findByThread({ backendId: 'bb', sessionId: 's', bbThreadId: '   ' }), /Invalid BB thread identity/);
    await assert.rejects(store.put({ ...binding, sessionId: '   ' }), /Invalid durable child binding/);
  } finally {
    await reopened.close(BACKGROUND_CONTEXT);
  }
});

test('get rejects a stored binding with an inconsistent embedded conversation ID', async () => {
  const f = await fixture();
  const binding = {
    backendId: 'bb-provider-test',
    sessionId: 'session-test',
    conversationId: ROOT_CONVERSATION_ID,
    bbThreadId: 'thread-corrupt-get',
  };
  try {
    await f.store.put(binding);
    await f.session.commit(async tx => {
      const state = await tx.doc(BindingDocForCorruption, ROOT_CONVERSATION_ID);
      state.binding = { ...state.binding, conversationId: ROOT_CONVERSATION_ID + 1 };
    }, BACKGROUND_CONTEXT);
    await assert.rejects(f.store.get(ROOT_CONVERSATION_ID), /Corrupt durable child binding/);
  } finally {
    await f.session.close(BACKGROUND_CONTEXT);
  }
});

test('findByThread rejects an indexed document with an inconsistent embedded conversation ID', async () => {
  const f = await fixture();
  const binding = {
    backendId: 'bb-provider-test',
    sessionId: 'session-test',
    conversationId: ROOT_CONVERSATION_ID,
    bbThreadId: 'thread-corrupt-index',
  };
  try {
    await f.store.put(binding);
    await f.session.commit(async tx => {
      const state = await tx.doc(BindingDocForCorruption, ROOT_CONVERSATION_ID);
      state.binding = { ...state.binding, conversationId: ROOT_CONVERSATION_ID + 1 };
    }, BACKGROUND_CONTEXT);
    await assert.rejects(
      f.store.findByThread({ backendId: binding.backendId, sessionId: binding.sessionId, bbThreadId: binding.bbThreadId }),
      /Corrupt durable child binding/,
    );
  } finally {
    await f.session.close(BACKGROUND_CONTEXT);
  }
});

test('binding write refuses a conversation absent from the owning Durable session', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.put({ backendId: 'bb', sessionId: 's', conversationId: 999, bbThreadId: 't' }),
      /Conversation 999 does not exist/,
    );
  } finally {
    await f.session.close(BACKGROUND_CONTEXT);
  }
});
