import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reconcileNativeHistory } from '../../compat/source/native-history-store.ts';

const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
function fixture() {
  const row = (id, type, data, turnId = 'native-turn', time = 10) => ({ id, type, data: JSON.stringify(data),
    threadId: 'child', environmentId: 'env', providerThreadId: 'session:61', scopeKind: turnId ? 'turn' : 'thread',
    turnId, itemId: null, itemKind: null, parentToolCallId: null, createdAt: time, sequence: id });
  const owned = [row(1, 'turn/started', { providerThreadId: 'session:61' }), row(2, 'item/completed', { native: 'owned transcript' })];
  const rows = [...owned,
    row(3, 'turn/completed', { providerThreadId: 'session:61', status: 'interrupted' }, 'native-turn', 20),
    row(4, 'system/error', { code: 'thread_command_failed', message: 'Thread interrupted because the host daemon disconnected', detail: 'Please retry the thread to continue.' }, 'native-turn', 20),
    row(5, 'system/thread/interrupted', { reason: 'host-daemon-restarted' }, null, 20)];
  rows[4].environmentId = null; // Core's host-level disconnect writer has no environment context.
  const metadata = { digest: 'a'.repeat(64), version: 1, nativeStatus: 'working', rowCount: owned.length, rowsDigest: hash(owned) };
  const select = { from() { return this; }, where() { return this; }, orderBy() { return this; }, all() { return rows; } };
  const db = { transaction(fn) { return fn({ select: () => select }); } };
  const core = {
    eq: () => null, events: {},
    getThread: (_tx, id) => ({ id, environmentId: 'env', providerId: 'pi-durable', parentThreadId: id === 'child' ? 'parent' : null, deletedAt: null, archivedAt: null, status: 'error' }),
    getEnvironment: () => ({ hostId: 'host' }),
    getThreadPluginMetadata: (_tx, _id, plugin) => ({ metadata: plugin === 'bb.core.native-registration'
      ? { kind: 'native-existing', hostId: 'host', providerId: 'pi-durable', sessionId: 'session', conversationId: '61', parentThreadId: 'parent' } : metadata, corrupt: false }),
    // Hermetic bookkeeping seam; the real Core parser is separately exercised
    // by the isolated Core/SQLite fixture, not represented by this unit stub.
    parseStoredThreadEvent: event => ({ ...event, ...event.data }),
    toStoredThreadEventData: event => Object.fromEntries(({
      'system/thread/interrupted': ['reason'], 'system/error': ['code', 'message', 'detail'],
      'turn/completed': ['providerThreadId', 'status'],
    }[event.type] ?? []).filter(key => Object.hasOwn(event.data, key)).map(key => [key, event.data[key]])),
  };
  return { rows, owned, metadata, read: () => reconcileNativeHistory(db, 'host', { threadId: 'child', providerId: 'pi-durable', providerThreadId: 'session:61' }, core) };
}

test('Core disconnect batch coexists with unchanged native transcript ownership', () => {
  const f = fixture(), before = JSON.stringify(f.rows);
  assert.equal(f.read().digest, f.metadata.digest);
  assert.equal(JSON.stringify(f.rows), before, 'transport diagnostics are retained, not erased');
  f.rows[1].data = '{"native":"modified"}';
  assert.throws(f.read, /Mixed or modified/);
});

test('scope, exact disconnect reason and canonical batch remain required', () => {
  for (const mutate of [
    f => { f.rows[4].environmentId = 'foreign'; },
    f => { f.rows[3].providerThreadId = 'foreign:61'; },
    f => { f.rows[4].data = '{"reason":"user-requested"}'; },
    f => { f.rows[3].createdAt++; },
    f => { f.rows[4].data = '{"reason":"host-daemon-restarted","unknown":true}'; },
    f => { f.rows[2].data = '{"providerThreadId":"session:61","status":"completed"}'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(f.read, /bookkeeping|Mixed or modified/);
  }
});
