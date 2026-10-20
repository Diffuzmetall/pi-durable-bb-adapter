import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat, rm, symlink, open, readlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverNativeRoot, ROOT_RECOVERY_PLUGIN } from '../../compat/source/native-root-recovery.ts';
import { registerNativeHistoryRoutes } from '../../compat/source/native-history-route.ts';
import { rootRecoveryDigest, rootRecoveryRequestSchema } from '../../src/bb-compat/native-root-recovery-contract.ts';
import { stableRootProviderId } from '../../src/bootstrap/provider-grant.ts';
import { prepareRootRecovery, applyRootRecovery } from '../../src/bootstrap/root-recovery.ts';

const threadId = 'thr_root', providerThreadId = stableRootProviderId(threadId);
const selector = { threadId, providerThreadId };
const snapshot = { sessionId: 'native-session', conversationId: 1, userEntryId: 10, answerEntryId: 11,
  inputs: [{ entryId: 10, text: 'one input' }], answerText: 'saved answer', status: 'completed' };

// Real isolated SQLite transaction/rollback. These small Core adapters inject the same
// existing repository operations as the compatibility bundle; no production store opens.
function coreFixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE events(id INTEGER PRIMARY KEY, threadId TEXT, sequence INTEGER, data TEXT); CREATE TABLE metadata(threadId TEXT, pluginId TEXT, metadataJson TEXT, PRIMARY KEY(threadId,pluginId));');
  t.after(() => sqlite.close());
  let published = 0, selects = 0;
  const thread = { id: threadId, projectId: 'proj', environmentId: 'env', parentThreadId: null, providerId: 'pi-durable', deletedAt: null, archivedAt: null, status: 'error' };
  sqlite.prepare('INSERT INTO threads VALUES(?,?)').run(threadId, JSON.stringify(thread));
  const current = () => JSON.parse(sqlite.prepare('SELECT data FROM threads WHERE id=?').get(threadId).data);
  const setThread = patch => sqlite.prepare('UPDATE threads SET data=? WHERE id=?').run(JSON.stringify({ ...current(), ...patch }), threadId);
  const rows = () => sqlite.prepare('SELECT data FROM events ORDER BY sequence').all().map(row => JSON.parse(row.data));
  function append(type, data, turnId = null, itemId = null) {
    const id = Number(sqlite.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM events').get().n);
    const row = { id, threadId, environmentId: 'env', providerThreadId, sequence: id, type, data: JSON.stringify(data),
      scopeKind: turnId ? 'turn' : 'thread', turnId, itemId, itemKind: null, parentToolCallId: null, createdAt: id };
    sqlite.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, threadId, id, JSON.stringify(row));
  }
  append('thread/identity', { providerThreadId });
  append('client/turn/requested', { requestId: 'request-one', input: [{ type: 'text', text: 'one input' }] });
  append('turn/started', { providerThreadId }, 'existing-turn');
  append('turn/input/accepted', { providerThreadId, clientRequestId: 'request-one' }, 'existing-turn');
  append('item/started', { providerThreadId, item: { type: 'agentMessage', id: 'partial-item', text: '' } }, 'existing-turn', 'partial-item');
  append('item/agentMessage/delta', { providerThreadId, itemId: 'partial-item', delta: 'saved ' }, 'existing-turn', 'partial-item');
  append('system/error', { code: 'thread_command_failed', message: 'BB_OWNER_SESSION_NOT_AUTHORIZED' });
  const events = { threadId: 'threadId', sequence: 'sequence' }, threads = { id: 'id' }, metadata = { threadId: 'threadId', pluginId: 'pluginId' };
  const tx = {
    select() { selects++; return { from() { return this; }, where() { return this; }, orderBy() { return this; }, all: rows }; },
    update() { return { set(patch) { return { where() { return { run() { setThread(patch); } }; } }; } }; },
    insert() { return { values(value) { return { onConflictDoUpdate() { return { run() { sqlite.prepare('INSERT INTO metadata VALUES(?,?,?) ON CONFLICT(threadId,pluginId) DO UPDATE SET metadataJson=excluded.metadataJson').run(value.threadId, value.pluginId, value.metadataJson); } }; } }; } }; },
  };
  const db = { transaction(fn, options) {
    assert.equal(options.behavior, 'immediate'); sqlite.exec('BEGIN IMMEDIATE');
    try { const value = fn(tx); sqlite.exec('COMMIT'); return value; } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const core = { events, threads, threadPluginMetadata: metadata, eq: () => null,
    getThread: (_tx, id) => id === threadId ? current() : undefined,
    getEnvironment: () => ({ hostId: 'host' }),
    getThreadPluginMetadata: (_tx, id, plugin) => ({ corrupt: false, metadata: JSON.parse(sqlite.prepare('SELECT metadataJson FROM metadata WHERE threadId=? AND pluginId=?').get(id, plugin)?.metadataJson ?? '{}') }),
    appendStoredThreadEventsInTransaction(_tx, values) { for (const value of values) {
      assert.equal(value.threadId, threadId); assert.equal(value.scope.turnId, 'existing-turn');
      assert.ok(['item/completed', 'turn/completed'].includes(value.type));
      append(value.type, value.data, value.scope.turnId, value.data.item?.id ?? null);
    } },
    bumpThreadEventRewriteGeneration() { published++; },
  };
  const prepare = () => recoverNativeRoot(db, 'host', { operation: 'prepare', ...selector }, core);
  const apply = prepared => recoverNativeRoot(db, 'host', { operation: 'apply', ...selector, backupDigest: prepared.backupDigest, snapshot }, core);
  return { db, core, rows, append, setThread, current, prepare, apply, get selects() { return selects; }, get published() { return published; } };
}

test('backup-first root repair completes the SAME turn/item and preserves every original row', t => {
  const f = coreFixture(t), before = f.rows(), prepared = f.prepare();
  assert.deepEqual(prepared.backup.events, before);
  assert.equal(prepared.backupDigest, rootRecoveryDigest(prepared.backup));
  assert.equal(f.published, 0);
  const receipt = f.apply(prepared);
  assert.equal(receipt.itemId, 'partial-item'); assert.equal(receipt.turnId, 'existing-turn');
  assert.deepEqual(f.rows().slice(0, before.length), before);
  assert.equal(f.rows().filter(row => row.type === 'turn/started').length, 1, 'never manufacture another turn');
  assert.equal(f.rows().at(-2).type, 'item/completed');
  assert.equal(JSON.parse(f.rows().at(-2).data).item.text, 'saved answer');
  assert.equal(f.current().status, 'idle'); assert.equal(f.published, 1);
  assert.equal(f.apply(prepared).changed, false, 'lost ACK replay is an exact no-op');
  assert.equal(f.published, 1);
});

test('stale backup, changed input, foreign host/provider/child and active roots are refused', t => {
  const f = coreFixture(t), prepared = f.prepare();
  for (const [host, input] of [
    ['foreign', { operation: 'prepare', ...selector }],
    ['host', { operation: 'prepare', ...selector, providerThreadId: 'foreign' }],
    ['host', { operation: 'apply', ...selector, backupDigest: prepared.backupDigest, snapshot: { ...snapshot, inputs: [{ entryId: 10, text: 'different' }] } }],
  ]) assert.throws(() => recoverNativeRoot(f.db, host, input, f.core));
  f.setThread({ parentThreadId: 'parent' }); assert.throws(f.prepare, /scope/);
  f.setThread({ parentThreadId: null, status: 'active' }); assert.throws(f.prepare, /non-executing/);
  f.setThread({ status: 'error' }); f.append('system/error', { message: 'new event after backup' });
  assert.throws(() => f.apply(prepared), /changed after backup/);
  assert.equal(f.published, 0); assert.equal(f.current().status, 'error');
});

test('identical accepted inputs without unique native admission receipts are refused', t => {
  const f = coreFixture(t);
  f.append('client/turn/requested', { requestId: 'request-two', input: [{ type: 'text', text: 'one input' }] });
  f.append('turn/input/accepted', { providerThreadId, clientRequestId: 'request-two' }, 'existing-turn');
  const prepared = f.prepare();
  assert.throws(() => f.apply(prepared), /lineage/);
  assert.throws(() => recoverNativeRoot(f.db, 'host', { operation: 'apply', ...selector, backupDigest: prepared.backupDigest,
    snapshot: { ...snapshot, userEntryId: 12, answerEntryId: 13, inputs: [...snapshot.inputs, { entryId: 12, text: 'one input' }] } }, f.core), /lineage/);
});

test('multiple matching unfinished answers refuse without arbitrarily closing an item', t => {
  const f = coreFixture(t);
  f.append('item/started', { providerThreadId, item: { type: 'agentMessage', id: 'second-partial', text: 'saved ' } }, 'existing-turn', 'second-partial');
  const prepared = f.prepare(), before = f.rows();
  assert.throws(() => f.apply(prepared), /Ambiguous root answer/);
  assert.deepEqual(f.rows(), before); assert.equal(f.current().status, 'error');
});

test('partial write rolls back atomically without a receipt or committed notification', t => {
  const f = coreFixture(t), prepared = f.prepare(), before = f.rows();
  const append = f.core.appendStoredThreadEventsInTransaction;
  f.core.appendStoredThreadEventsInTransaction = (tx, values) => { append(tx, values.slice(0, 1)); throw Error('injected write failure'); };
  assert.throws(() => f.apply(prepared), /injected/);
  assert.deepEqual(f.rows(), before); assert.equal(f.current().status, 'error'); assert.equal(f.published, 0);
  assert.deepEqual(f.core.getThreadPluginMetadata(null, threadId, ROOT_RECOVERY_PLUGIN).metadata, {});
});

test('root contract rejects traversal, arbitrary payloads, live outcomes and reversed native identity', () => {
  for (const patch of [{ threadId: '../foreign' }, { execute: 'unsafe' }, { snapshot: { ...snapshot, status: 'working' } },
    { snapshot: { ...snapshot, answerEntryId: 9 } }, { snapshot: { ...snapshot, conversationId: 2 } }])
    assert.equal(rootRecoveryRequestSchema.safeParse({ operation: 'apply', ...selector, backupDigest: 'a'.repeat(64), snapshot, ...patch }).success, false);
});

async function operatorFixture(t) {
  const f = coreFixture(t), dir = await mkdtemp(join(tmpdir(), 'bb-root-restore-'));
  const nativeDir = join(dir, 'native'), dataDir = join(dir, 'bb'), bridgeDataDir = join(dir, 'bridge'), recoveryDir = join(dir, 'recovery');
  const rootDir = join(bridgeDataDir, 'native-roots', threadId), sessionDir = join(dir, 'session');
  for (const path of [nativeDir, dataDir, rootDir, sessionDir]) await mkdir(path, { mode: 0o700, recursive: true });
  const save = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const socketPath = join(nativeDir, 'control.sock'), nativeCommands = [], operations = [], sockets = new Set();
  const view = { session: { id: snapshot.sessionId, directory: sessionDir, cwd: dir },
    conversation: { conversation: { id: 1 }, docs: { 'pi.live': {}, 'pi.inbox': { items: [] } }, entries: [
      { id: 10, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: snapshot.inputs[0].text }] },
      { id: 11, conversationId: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: snapshot.answerText }], stopReason: 'stop' }] },
    ] } };
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = '';
    socket.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); nativeCommands.push(command.type);
        assert.ok(['attach', 'get_state'].includes(command.type), 'no prompt, stop, selection or execution command');
        socket.write(JSON.stringify({ id: command.id, type: 'response', success: true,
          data: command.type === 'attach' ? view : { sessionId: snapshot.sessionId, cwd: dir } }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
  await save(join(dataDir, 'auth.json'), { hostId: 'host', hostKey: 'fixture-machine-key', hostType: 'local' });
  await save(join(rootDir, 'root.json'), { protocol: 'bb-native-root/v1', threadId, providerThreadId, cwd: dir, privateDir: nativeDir });
  await save(join(nativeDir, 'shared-host.json'), { protocol: 'bb-durable-selected-session/v1', socket: socketPath, session: view.session });
  await save(join(nativeDir, 'ready.json'), { protocol: 'bb-native-ready/v1', sdk: '1.3.0', directory: sessionDir });
  const requestFetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/internal/hosts/threads/recover-native-root');
    assert.equal(options.headers.authorization, 'Bearer fixture-machine-key'); assert.equal(options.redirect, 'error');
    const request = JSON.parse(options.body); operations.push(request.operation);
    if (request.operation === 'apply') {
      const original = JSON.parse(await readFile(join(recoveryDir, 'backup.json'), 'utf8'));
      assert.equal(rootRecoveryDigest(original), request.backupDigest, 'fsynced backup exists before Core mutation');
    }
    try { return new Response(JSON.stringify(recoverNativeRoot(f.db, 'host', request, f.core)), { status: 200 }); }
    catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: error.status ?? 500 }); }
  };
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { ...f, view, nativeCommands, operations, requestFetch, args: { dataDir, serverUrl: 'http://127.0.0.1:38886', bridgeDataDir, threadId, recoveryDir } };
}

test('operator prepare/apply uses private backups, real Unix attach and SQLite; repeated apply does not resubmit', async t => {
  const f = await operatorFixture(t), before = f.rows();
  assert.equal((await prepareRootRecovery(f.args, f.requestFetch)).status, 'prepared');
  assert.deepEqual(f.rows(), before, 'prepare is read-only on Core');
  for (const name of ['backup.json', 'native.json', 'plan.json']) assert.equal((await stat(join(f.args.recoveryDir, name))).mode & 0o777, 0o600);
  assert.equal((await stat(f.args.recoveryDir)).mode & 0o777, 0o700);
  assert.equal((await applyRootRecovery(f.args, f.requestFetch)).changed, true);
  assert.equal((await applyRootRecovery(f.args, f.requestFetch)).changed, false);
  assert.deepEqual(f.nativeCommands, ['attach', 'get_state', 'attach', 'get_state', 'attach', 'get_state']);
  assert.deepEqual(f.rows().slice(0, before.length), before);
});

test('changed native outcome or symlinked backup blocks before any Core apply', async t => {
  const f = await operatorFixture(t);
  await prepareRootRecovery(f.args, f.requestFetch);
  f.view.conversation.entries.at(-1).model[0].content[0].text = 'a newer native result';
  await assert.rejects(applyRootRecovery(f.args, f.requestFetch), /NATIVE_CHANGED_AFTER_PREPARE/);
  assert.deepEqual(f.operations, ['prepare']);
  const otherDir = join(f.args.recoveryDir, 'symlink-test'); await mkdir(otherDir, { mode: 0o700 });
  await symlink(join(f.args.recoveryDir, 'backup.json'), join(otherDir, 'backup.json'));
  const count = f.nativeCommands.length;
  await assert.rejects(prepareRootRecovery({ ...f.args, recoveryDir: otherDir }, f.requestFetch));
  assert.equal(f.nativeCommands.length, count, 'backup is secured before reading native history');
});

test('existing backup must fsync again; a sync failure blocks before native read or apply', async t => {
  const f = await operatorFixture(t);
  await prepareRootRecovery(f.args, f.requestFetch);
  const file = await open(join(f.args.recoveryDir, 'backup.json'), 'r');
  const prototype = Object.getPrototypeOf(file), original = prototype.sync;
  await file.close();
  const nativeCount = f.nativeCommands.length;
  prototype.sync = async function () {
    const path = await readlink(`/proc/self/fd/${this.fd}`);
    if (path === join(f.args.recoveryDir, 'backup.json')) throw Error('injected backup fsync failure');
    return original.call(this);
  };
  try {
    await assert.rejects(prepareRootRecovery(f.args, f.requestFetch), /fsync failure/);
    await assert.rejects(applyRootRecovery(f.args, f.requestFetch), /fsync failure/);
    assert.equal(f.nativeCommands.length, nativeCount);
    assert.ok(!f.operations.includes('apply'));
  } finally { prototype.sync = original; }
});

test('native inbox with unconsumed input is not treated as a settled old answer', async t => {
  const f = await operatorFixture(t);
  f.view.conversation.docs['pi.inbox'].items.push({ id: 20, mode: 'followUp', content: 'one input' });
  await assert.rejects(prepareRootRecovery(f.args, f.requestFetch), /NATIVE_INPUT_PENDING/);
  assert.deepEqual(f.operations, ['prepare']);
});

test('bundled recovery CLI help has exactly one main entry and no attach CLI execution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-recovery-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'restore-native-root.mjs');
  await build({ entryPoints: ['src/bootstrap/root-recovery-cli.ts'], outfile: path, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: 'import {createRequire as __packageRequire} from "node:module";const require=__packageRequire(import.meta.url);' } });
  const result = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /^restore-native-root.mjs prepare\|apply /);
  assert.ok(!result.stdout.includes('BB_ATTACH'));
});

test('Core route authenticates before parsing and the operator refuses remote credential destinations', async t => {
  const f = coreFixture(t), routes = new Map(); let bodyRead = false;
  registerNativeHistoryRoutes({ post: (path, handler) => routes.set(path, handler) }, { db: f.db }, f.core, () => { throw Error('not authenticated'); });
  await assert.rejects(routes.get('/hosts/threads/recover-native-root')({ req: { text() { bodyRead = true; return '{}'; } } }), /not authenticated/);
  assert.equal(bodyRead, false);
  await assert.rejects(prepareRootRecovery({ serverUrl: 'https://external.invalid' }), /LOCAL_SERVER_REQUIRED/);
});
