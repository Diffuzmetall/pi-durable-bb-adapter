import { constants } from 'node:fs';
import { open, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createConnection } from 'node:net';
import { localMachineAuth } from './local-machine-auth.ts';
import { assertPrivateOwnerParent, readPrivateOwnerJson } from './owner-grant.ts';
import { readSelectedNativeSession, stableRootProviderId, verifyNativeReady } from './provider-grant.ts';
import { rootRecoveryBackupSchema, rootRecoveryDigest, rootRecoveryRequestSchema, rootRecoverySnapshotSchema, type RootRecoverySnapshot } from '../bb-compat/native-root-recovery-contract.ts';

const MAX_BYTES = 8 * 1024 * 1024;
interface RecoveryArgs { dataDir: string; serverUrl: string; bridgeDataDir: string; threadId: string; recoveryDir: string }
const fail = (reason: string): never => { throw Error(`BB_ROOT_RECOVERY_${reason}`); };

async function readPrivate(path: string, durable = false): Promise<any> {
  const uid = await assertPrivateOwnerParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== uid || (before.mode & 0o7777) !== 0o600 || before.nlink !== 1 || before.size > MAX_BYTES) fail('PRIVATE_FILE_REQUIRED');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await file.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('FILE_CHANGED');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
    if (durable) await file.sync();
    return value;
  } finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function savePrivate(path: string, value: unknown): Promise<void> {
  await assertPrivateOwnerParent(path);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_BYTES) fail('BACKUP_TOO_LARGE');
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (rootRecoveryDigest(await readPrivate(path, true)) !== rootRecoveryDigest(value)) fail('EXISTING_BACKUP_DIFFERS');
    await syncDirectory(dirname(path));
    return;
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await syncDirectory(dirname(path));
}

function localUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('LOCAL_SERVER_REQUIRED');
  return url;
}
async function coreClient(args: RecoveryArgs, requestFetch: typeof fetch) {
  rootRecoveryRequestSchema.parse({ operation: 'prepare', threadId: args.threadId, providerThreadId: stableRootProviderId(args.threadId) });
  const url = new URL('/internal/hosts/threads/recover-native-root', localUrl(args.serverUrl));
  const auth = await localMachineAuth(args.dataDir);
  return { hostId: auth.hostId, async post(body: object): Promise<any> {
    const response = await requestFetch(url, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${auth.hostKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) fail(`CORE_HTTP_${response.status}`);
    if (!response.body) fail('CORE_RESPONSE_REQUIRED');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) fail('CORE_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } };
}

/** No Harness, SQLite open, launch, selection change or input command is possible here. */
async function captureNativeRoot(args: RecoveryArgs): Promise<{ snapshot: RootRecoverySnapshot; view: unknown }> {
  const record = await readPrivateOwnerJson(join(args.bridgeDataDir, 'native-roots', args.threadId, 'root.json')) as any;
  if (record.protocol !== 'bb-native-root/v1' || record.threadId !== args.threadId || record.providerThreadId !== stableRootProviderId(args.threadId)) fail('ROOT_IDENTITY_MISMATCH');
  const selected = await readSelectedNativeSession(join(record.privateDir, 'shared-host.json'));
  const ready = await readPrivateOwnerJson(join(record.privateDir, 'ready.json')) as any;
  if (selected.socket !== join(record.privateDir, 'control.sock') || selected.session.cwd !== record.cwd ||
    ready.protocol !== 'bb-native-ready/v1' || ready.sdk !== '1.3.0' || ready.directory !== selected.session.directory) fail('NATIVE_READY_MISMATCH');
  const view: any = await new Promise((resolve, reject) => {
    const socket = createConnection(selected.socket); let bytes = Buffer.alloc(0), attached: any;
    const done = (error?: Error, value?: unknown) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => done(Error('BB_ROOT_RECOVERY_ATTACH_TIMEOUT')), 10000);
    socket.once('error', () => done(Error('BB_ROOT_RECOVERY_NATIVE_DISCONNECTED')));
    socket.once('close', () => { clearTimeout(timer); reject(Error('BB_ROOT_RECOVERY_NATIVE_DISCONNECTED')); });
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'root-recovery-attach', type: 'attach', cwd: record.cwd }) + '\n'));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_BYTES) { done(Error('BB_ROOT_RECOVERY_NATIVE_FRAME_LIMIT')); return; }
      let end;
      while ((end = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
        try {
          const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
          if (frame.type === 'shared_view' || frame.type === 'agent_events') { attached = frame.view; continue; }
          if (frame.type !== 'response') continue;
          if (frame.id === 'root-recovery-attach') {
            if (!frame.success || !frame.data) throw Error('BB_ROOT_RECOVERY_ATTACH_REFUSED');
            attached = frame.data;
            socket.write(JSON.stringify({ id: 'root-recovery-state', type: 'get_state' }) + '\n');
          } else if (frame.id === 'root-recovery-state') {
            if (!frame.success || !attached) throw Error('BB_ROOT_RECOVERY_STATE_REFUSED');
            // Join verification before closing; never release unverified snapshot text.
            const captured = attached;
            void verifyNativeReady(selected, { kind: 'ready', sharedHost: true, session: captured.session }, frame.data, record.cwd)
              .then(() => done(undefined, captured), () => done(Error('BB_ROOT_RECOVERY_NATIVE_IDENTITY_MISMATCH')));
          }
        } catch { done(Error('BB_ROOT_RECOVERY_NATIVE_PROTOCOL_REFUSED')); }
      }
    });
  });
  const conversation = view.conversation, live = conversation?.docs?.['pi.live'];
  if (conversation?.conversation?.id !== 1 || !live || typeof live !== 'object' || Array.isArray(live) || live.run || live.generation || live.compactionFailure ||
    ['tools', 'nestedTools', 'compactions'].some(key => live[key] !== undefined && (!Array.isArray(live[key]) || live[key].length))) fail('NATIVE_NOT_SETTLED');
  const inbox = conversation.docs['pi.inbox'];
  if (!inbox || !Array.isArray(inbox.items) || inbox.items.length) fail('NATIVE_INPUT_PENDING');
  const entries = conversation.entries;
  if (!Array.isArray(entries) || !entries.every((entry, index) => entry?.conversationId === 1 && Number.isSafeInteger(entry.id) && entry.id > 0 &&
    entry.head === undefined && entry.edits === undefined && (!index || entries[index - 1].id < entry.id))) fail('NATIVE_ENTRIES_INVALID');
  const user = entries.findLast(entry => entry.kind === 'pi.user'), answer = entries.at(-1);
  const input = user?.model?.[0], message = answer?.kind === 'pi.assistant' && answer.model?.[0];
  if (!message || input?.role !== 'user' || message.role !== 'assistant' || !['stop', 'error', 'aborted'].includes(message.stopReason)) fail('NATIVE_TERMINAL_ANSWER_REQUIRED');
  const inputs = entries.filter(entry => entry.kind === 'pi.user').map(entry => {
    if (entry.model?.length !== 1 || entry.model[0]?.role !== 'user') fail('NATIVE_INPUT_LINEAGE_UNSUPPORTED');
    const content = entry.model[0].content;
    if (typeof content !== 'string' && (!Array.isArray(content) || content.some((block: any) => block?.type !== 'text' || typeof block.text !== 'string'))) fail('NATIVE_INPUT_LINEAGE_UNSUPPORTED');
    return { entryId: entry.id, text: typeof content === 'string' ? content : content.map((block: any) => block.text).join('') };
  });
  const answerText = message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') ||
    (typeof message.errorMessage === 'string' ? `Native model error: ${message.errorMessage}` : '');
  const snapshot = rootRecoverySnapshotSchema.parse({ sessionId: selected.session.id, conversationId: 1,
    userEntryId: user.id, answerEntryId: answer.id, inputs, answerText,
    status: message.stopReason === 'stop' ? 'completed' : message.stopReason === 'error' ? 'failed' : 'interrupted' });
  return { snapshot, view };
}

export async function prepareRootRecovery(args: RecoveryArgs, requestFetch: typeof fetch = fetch) {
  localUrl(args.serverUrl); // Reject an unsafe destination before filesystem/auth work.
  try { await mkdir(args.recoveryDir, { mode: 0o700 }); await chmod(args.recoveryDir, 0o700); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await assertPrivateOwnerParent(join(args.recoveryDir, 'backup.json'));
  await syncDirectory(dirname(args.recoveryDir)); // Persist a new (or interrupted previous) recovery-directory link.
  const client = await coreClient(args, requestFetch), providerThreadId = stableRootProviderId(args.threadId);
  const response = await client.post({ operation: 'prepare', threadId: args.threadId, providerThreadId });
  const backup = rootRecoveryBackupSchema.parse(response.backup);
  if (response.status !== 'prepared' || response.threadId !== args.threadId || backup.threadId !== args.threadId || backup.hostId !== client.hostId ||
    backup.providerThreadId !== providerThreadId || rootRecoveryDigest(backup) !== response.backupDigest) fail('CORE_BACKUP_MISMATCH');
  await savePrivate(join(args.recoveryDir, 'backup.json'), backup); // Durable backup MUST precede any native capture or mutation.
  const capture = await captureNativeRoot(args);
  await savePrivate(join(args.recoveryDir, 'native.json'), capture.view);
  await savePrivate(join(args.recoveryDir, 'plan.json'), { protocol: 'bb-native-root-recovery-plan/v1', serverUrl: localUrl(args.serverUrl).origin,
    hostId: client.hostId, threadId: args.threadId, providerThreadId, backupDigest: response.backupDigest, snapshot: capture.snapshot });
  return { status: 'prepared', threadId: args.threadId, backupDigest: response.backupDigest, recoveryDir: args.recoveryDir };
}

export async function applyRootRecovery(args: RecoveryArgs, requestFetch: typeof fetch = fetch) {
  const client = await coreClient(args, requestFetch);
  const backup = rootRecoveryBackupSchema.parse(await readPrivate(join(args.recoveryDir, 'backup.json'), true));
  await syncDirectory(args.recoveryDir);
  await syncDirectory(dirname(args.recoveryDir));
  const plan = await readPrivate(join(args.recoveryDir, 'plan.json'));
  const snapshot = rootRecoverySnapshotSchema.parse(plan.snapshot);
  if (plan.protocol !== 'bb-native-root-recovery-plan/v1' || plan.serverUrl !== localUrl(args.serverUrl).origin ||
    plan.threadId !== args.threadId || backup.threadId !== args.threadId || plan.hostId !== client.hostId || backup.hostId !== client.hostId ||
    plan.providerThreadId !== stableRootProviderId(args.threadId) || backup.providerThreadId !== plan.providerThreadId || rootRecoveryDigest(backup) !== plan.backupDigest) fail('PLAN_BACKUP_MISMATCH');
  const current = await captureNativeRoot(args);
  if (rootRecoveryDigest(current.snapshot) !== rootRecoveryDigest(snapshot)) fail('NATIVE_CHANGED_AFTER_PREPARE');
  const result = await client.post({ operation: 'apply', threadId: args.threadId, providerThreadId: plan.providerThreadId, backupDigest: plan.backupDigest, snapshot });
  if (result.status !== 'recovered' || result.threadId !== args.threadId || typeof result.changed !== 'boolean' || typeof result.turnId !== 'string' || typeof result.itemId !== 'string') fail('CORE_ACK_INVALID');
  await savePrivate(join(args.recoveryDir, 'receipt.json'), { status: result.status, threadId: result.threadId,
    turnId: result.turnId, itemId: result.itemId, backupDigest: plan.backupDigest, snapshotDigest: rootRecoveryDigest(snapshot) });
  return result;
}
