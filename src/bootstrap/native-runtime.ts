import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, lstat, mkdtemp, realpath, readFile, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedNativeRuntime } from './native-runtime-config.ts';
import { provisionOwnerGrant, readOwnerGrant, readPrivateOwnerJson, OWNER_GRANT_PROTOCOL } from './owner-grant.ts';
import { provisionPrivateOperatorFile } from './operator-profile.ts';
import { readSelectedNativeSession, stableRootProviderId, type ProviderOwnerScope } from './provider-grant.ts';

type Record = { protocol: 'bb-native-root/v1'; threadId: string; providerThreadId: string; cwd: string;
  revision: string; privateDir: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e; } };
async function exists(path: string) { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function privateDir(path: string) {
  if (await mkdir(path, { recursive: true, mode: 0o700 })) await chmod(path, 0o700);
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700 || await realpath(path) !== path)
    throw Error('NATIVE_ROOT_PRIVATE_DIRECTORY_REQUIRED');
}
async function attach(socketPath: string, cwd: string): Promise<{ id: string; directory: string; cwd: string }> {
  const s = await lstat(socketPath);
  if (!s.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o600) throw Error('NATIVE_ROOT_PRIVATE_SOCKET_REQUIRED');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(Error('NATIVE_ROOT_ATTACH_TIMEOUT')); }, 5000);
    const finish = () => { clearTimeout(timer); socket.destroy(); };
    socket.once('error', e => { finish(); reject(e); });
    socket.once('connect', () => socket.write(JSON.stringify({ id: 'native-owner-bootstrap', type: 'attach', cwd }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk; if (buffer.length > 16 * 1024 * 1024) { finish(); reject(Error('NATIVE_ROOT_FRAME_LIMIT')); return; }
      let i; while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const f = JSON.parse(line); if (f.type !== 'response' || f.id !== 'native-owner-bootstrap') continue;
          if (!f.success || !f.data?.session) throw Error('NATIVE_ROOT_ATTACH_REFUSED');
          const session = f.data.session;
          if (typeof session.id !== 'string' || typeof session.directory !== 'string' || session.cwd !== cwd) throw Error('NATIVE_ROOT_IDENTITY_INVALID');
          finish(); resolve(session);
        } catch (e) { finish(); reject(e); }
      }
    });
  });
}
/** Core proof precedes any native attach/history. No wire option supplies a CLI, grant or runtime. */
export async function nativeRootFor(dataDir: string, proof: ProviderOwnerScope, providerThreadId: string, cwdInput: string) {
  const [base, child] = providerThreadId.split(':');
  const rootId = child === undefined ? proof.threadId : proof.parentThreadId;
  if (!rootId || proof.providerId !== 'pi-durable' || proof.providerThreadId !== providerThreadId
    || (child === undefined && proof.parentThreadId !== null) || base !== stableRootProviderId(rootId)) throw Error('NATIVE_ROOT_CORE_SCOPE_MISMATCH');
  const prepared = await checkedNativeRuntime(dataDir), cwd = await realpath(cwdInput);
  const directory = join(dataDir, 'native-roots', rootId), recordPath = join(directory, 'root.json');
  await privateDir(directory);
  let record: Record;
  if (await exists(recordPath)) record = await readPrivateOwnerJson(recordPath) as Record;
  else {
    if (child !== undefined) throw Error('NATIVE_CHILD_CANNOT_LAUNCH_ROOT');
    const socketDir = await mkdtemp(join(tmpdir(), 'bb-native-'));
    record = { protocol: 'bb-native-root/v1', threadId: rootId, providerThreadId: base, cwd,
      revision: prepared.revision, privateDir: socketDir };
    await provisionPrivateOperatorFile(recordPath, record);
  }
  if (record.protocol !== 'bb-native-root/v1' || record.threadId !== rootId || record.providerThreadId !== base
    || record.cwd !== cwd || record.revision !== prepared.revision) throw Error('NATIVE_ROOT_IDENTITY_CONFLICT');
  await privateDir(record.privateDir);
  const grantPath = join(record.privateDir, 'owner.json'), socket = join(record.privateDir, 'control.sock');
  const descriptorPath = join(record.privateDir, 'shared-host.json'), readyPath = join(record.privateDir, 'ready.json');
  const desired = { protocol: OWNER_GRANT_PROTOCOL, ownerScope: { providerId: proof.providerId, sessionId: base, parentThreadId: rootId },
    socketPath: grantPath + '.sock' } as const;
  if (!await exists(grantPath)) {
    if (child !== undefined) throw Error('NATIVE_CHILD_CANNOT_PROVISION_GRANT');
    await provisionOwnerGrant(grantPath, desired);
  }
  if (JSON.stringify(await readOwnerGrant(grantPath)) !== JSON.stringify(desired)) throw Error('NATIVE_ROOT_GRANT_CONFLICT');
  let failurePath: string | undefined;
  const previousReady = await exists(readyPath) ? await readPrivateOwnerJson(readyPath) as {pid: number} : undefined;
  if (!await exists(socket) || (previousReady && !alive(previousReady.pid))) {
    if (child !== undefined) throw Error('NATIVE_ROOT_REOPEN_REQUIRED');
    if (previousReady && alive(previousReady.pid)) throw Error('NATIVE_OWNER_ALIVE_WITHOUT_ENDPOINT: refusing takeover');
    const attempt = randomUUID();
    const specPath = join(record.privateDir, `launch.${attempt}.json`);
    failurePath = join(record.privateDir, `startup-failure.${attempt}.private.txt`);
    await provisionPrivateOperatorFile(specPath, { cli: prepared.config.cli, cwd, socket,
      global: prepared.global, extension: prepared.extension, grant: grantPath, ready: readyPath, claim: join(record.privateDir, 'terminal.lock'),
      failure: failurePath, env: prepared.config.env });
    const log = await open(join(record.privateDir, 'launcher.private.log'), 'a', 0o600);
    try {
      await new Promise<void>((resolveStarted, reject) => {
        const helper = spawn('/usr/bin/python3', [prepared.config.helper, specPath], { detached: true,
          stdio: ['ignore', log.fd, log.fd] });
        helper.once('error', reject);
        helper.once('spawn', () => { helper.unref(); resolveStarted(); });
      });
    } finally { await log.close(); }
  }
  const deadline = Date.now() + 45000;
  let ready: { protocol: string; sdk: string; pid: number; directory: string; tools: string[]; extensions: string[] } | undefined;
  while (true) {
    if (await exists(socket) && await exists(readyPath)) {
      ready = await readPrivateOwnerJson(readyPath) as typeof ready;
      if (ready && Number.isSafeInteger(ready.pid) && alive(ready.pid)) break;
    }
    if (failurePath && await exists(failurePath)) throw Error('NATIVE_ROOT_START_FAILED: inspect private startup diagnostics');
    if (Date.now() > deadline) throw Error('NATIVE_ROOT_START_TIMEOUT: inspect private startup diagnostics');
    await new Promise(r => setTimeout(r, 100));
  }
  if (ready.protocol !== 'bb-native-ready/v1' || ready.sdk !== '1.3.0' || typeof ready.directory !== 'string'
    || !Number.isSafeInteger(ready.pid) || !alive(ready.pid) || !Array.isArray(ready.tools)) throw Error('NATIVE_ROOT_READY_MISMATCH');
  const selected = { socket, session: await attach(socket, cwd) };
  if (selected.session.directory !== ready.directory) throw Error('NATIVE_ROOT_SESSION_MISMATCH');
  await provisionPrivateOperatorFile(descriptorPath, { protocol: 'bb-durable-selected-session/v1', ...selected });
  await readSelectedNativeSession(descriptorPath);
  return { config: { grantPath, descriptorPath }, selected, ready };
}
