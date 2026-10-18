import { constants, type Stats } from 'node:fs';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { assertPrivateOwnerParent, readOwnerGrant, readPrivateOwnerJson, type OwnerGrant } from "./owner-grant.ts";
import type { ProviderOwnerScope, SelectedNativeSession } from "./provider-grant.ts";

export const REGISTRATION_HANDOFF_PROTOCOL = 'bb-durable-registration-handoff/v1' as const;
export type RegistrationHandoff = Readonly<{
  protocol: typeof REGISTRATION_HANDOFF_PROTOCOL;
  ownerScope: OwnerGrant['ownerScope'];
  socketPath: string;
  nativeSession: Readonly<SelectedNativeSession['session']>;
}>;
export type RegistrationHandoffExpected = Pick<RegistrationHandoff, 'ownerScope' | 'nativeSession'>;
const MAX_BYTES = 16 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const same = (a: RegistrationHandoffExpected, b: RegistrationHandoffExpected) =>
  a.ownerScope.providerId === b.ownerScope.providerId && a.ownerScope.sessionId === b.ownerScope.sessionId && a.ownerScope.parentThreadId === b.ownerScope.parentThreadId &&
  a.nativeSession.id === b.nativeSession.id && a.nativeSession.directory === b.nativeSession.directory && a.nativeSession.cwd === b.nativeSession.cwd;
function absolute(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value) || resolve(value) !== value) throw Error('BB_REGISTRATION_HANDOFF_INVALID_PATH');
}
export function registrationHandoffPath(grantPath: string): string {
  absolute(grantPath);
  return grantPath + '.registration.json';
}
function validated(value: unknown): RegistrationHandoff {
  if (!object(value) || !exact(value, ['protocol', 'ownerScope', 'socketPath', 'nativeSession']) || value.protocol !== REGISTRATION_HANDOFF_PROTOCOL ||
    !object(value.ownerScope) || !exact(value.ownerScope, ['providerId', 'sessionId', 'parentThreadId']) ||
    !text(value.ownerScope.providerId) || !text(value.ownerScope.sessionId) || !text(value.ownerScope.parentThreadId) ||
    !object(value.nativeSession) || !exact(value.nativeSession, ['id', 'directory', 'cwd']) || !text(value.nativeSession.id)) throw Error('BB_REGISTRATION_HANDOFF_INVALID');
  absolute(value.socketPath); absolute(value.nativeSession.directory); absolute(value.nativeSession.cwd);
  if (Buffer.byteLength(value.socketPath) > 107) throw Error('BB_REGISTRATION_HANDOFF_INVALID_PATH');
  return Object.freeze({ protocol: REGISTRATION_HANDOFF_PROTOCOL, socketPath: value.socketPath,
    ownerScope: Object.freeze({ providerId: value.ownerScope.providerId, sessionId: value.ownerScope.sessionId, parentThreadId: value.ownerScope.parentThreadId }),
    nativeSession: Object.freeze({ id: value.nativeSession.id, directory: value.nativeSession.directory, cwd: value.nativeSession.cwd }) });
}
async function nativePaths(value: RegistrationHandoff) {
  if (await realpath(value.nativeSession.directory) !== value.nativeSession.directory || await realpath(value.nativeSession.cwd) !== value.nativeSession.cwd)
    throw Error('BB_REGISTRATION_HANDOFF_NATIVE_PATH_CHANGED');
}
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function privateFile(stat: Stats, uid: number) {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES)
    throw Error('BB_REGISTRATION_HANDOFF_PRIVATE_FILE_REQUIRED');
}
async function endpoint(path: string): Promise<void> {
  const uid = await assertPrivateOwnerParent(path);
  const before = await lstat(path);
  if (!before.isSocket() || before.uid !== uid || (before.mode & 0o7777) !== 0o600) throw Error('BB_REGISTRATION_HANDOFF_PRIVATE_SOCKET_REQUIRED');
  await new Promise<void>((yes, no) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); no(Error('BB_REGISTRATION_HANDOFF_STALE')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); yes(); });
    socket.once('error', () => { clearTimeout(timer); no(Error('BB_REGISTRATION_HANDOFF_STALE')); });
  });
  const after = await lstat(path);
  if (!sameInode(before, after) || !after.isSocket() || after.uid !== uid || (after.mode & 0o7777) !== 0o600) throw Error('BB_REGISTRATION_HANDOFF_ENDPOINT_CHANGED');
}
function matchesGrant(handoff: RegistrationHandoff, grant: OwnerGrant) {
  if (handoff.ownerScope.providerId !== grant.ownerScope.providerId || handoff.ownerScope.sessionId !== grant.ownerScope.sessionId ||
    handoff.ownerScope.parentThreadId !== grant.ownerScope.parentThreadId) throw Error('BB_REGISTRATION_HANDOFF_SCOPE_MISMATCH');
}

/** PAIR-TIME read only: absence/staleness must NOT prevent native observation bind.
 * Locator privacy/liveness is transport hygiene, NOT owner authority. Native caller
 * must validate actual child provenance, use NCR, then reread/compare before put.
 */
export async function readRegistrationHandoff(grantPath: string, expected: RegistrationHandoffExpected): Promise<RegistrationHandoff> {
  const path = registrationHandoffPath(grantPath);
  const grant = await readOwnerGrant(grantPath);
  const value = validated(await readPrivateOwnerJson(path));
  matchesGrant(value, grant);
  if (!expected || !same(value, expected)) throw Error('BB_REGISTRATION_HANDOFF_OWNER_OR_NATIVE_MISMATCH');
  await nativePaths(value);
  await endpoint(value.socketPath);
  const reread = validated(await readPrivateOwnerJson(path));
  if (!same(value, reread) || value.socketPath !== reread.socketPath || JSON.stringify(await readOwnerGrant(grantPath)) !== JSON.stringify(grant))
    throw Error('BB_REGISTRATION_HANDOFF_CHANGED');
  return value;
}

/** Internal provider callsite ONLY, after actual Core ACK and native verification.
 * Never call with wire/providerOptions tuples. Current NCR callback independently
 * rechecks actual Root/Core/native context; this file grants no pairing authority.
 */
export async function publishRegistrationHandoff(args: {
  grantPath: string; proof: ProviderOwnerScope;
  expected: Pick<ProviderOwnerScope, 'providerId' | 'threadId' | 'providerThreadId'>;
  socketPath: string; nativeSession: Readonly<SelectedNativeSession['session']>;
}): Promise<RegistrationHandoff> {
  const { proof, expected, grantPath } = args;
  if (!proof || proof.parentThreadId !== null || !text(proof.providerThreadId) || proof.providerThreadId.includes(':') ||
    proof.providerId !== expected.providerId || proof.threadId !== expected.threadId || proof.providerThreadId !== expected.providerThreadId)
    throw Error('BB_REGISTRATION_HANDOFF_AUTHENTICATED_ROOT_REQUIRED');
  const desired = validated({ protocol: REGISTRATION_HANDOFF_PROTOCOL,
    ownerScope: { providerId: proof.providerId, sessionId: proof.providerThreadId, parentThreadId: proof.threadId },
    socketPath: args.socketPath, nativeSession: args.nativeSession });
  const path = registrationHandoffPath(grantPath), uid = await assertPrivateOwnerParent(path);
  const grant = await readOwnerGrant(grantPath); matchesGrant(desired, grant);
  await nativePaths(desired); await endpoint(desired.socketPath);
  const existing = async () => {
    try {
      const value = validated(await readPrivateOwnerJson(path));
      if (!same(value, desired)) throw Error('BB_REGISTRATION_HANDOFF_CONFLICT');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error; }
  };
  const prior = await existing();
  if (prior?.socketPath === desired.socketPath) return prior; // No rewrite on identical retry.
  // Protected local publication lock, not a scheduler/lease/retry loop. Unknown
  // crash-left locks fail closed; never steal or age out another writer's lock.
  const lockPath = path + '.publish-lock';
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const lockStat = await lock.stat();
  const temporary = path + '.' + randomUUID() + '.tmp';
  let temporaryCreated = false;
  try {
    privateFile(lockStat, uid);
    const current = await existing();
    if (current?.socketPath === desired.socketPath) return current;
    const before = current ? await lstat(path) : undefined;
    if (before) privateFile(before, uid);
    if (JSON.stringify(await readOwnerGrant(grantPath)) !== JSON.stringify(grant)) throw Error('BB_REGISTRATION_HANDOFF_CHANGED');
    const bytes = Buffer.from(JSON.stringify(desired) + '\n');
    if (bytes.length > MAX_BYTES) throw Error('BB_REGISTRATION_HANDOFF_TOO_LARGE');
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try { privateFile(await file.stat(), uid); await file.writeFile(bytes); await file.sync(); privateFile(await file.stat(), uid); }
    finally { await file.close(); }
    if (before) {
      const now = await lstat(path); privateFile(now, uid);
      if (!sameInode(before, now) || !same(validated(await readPrivateOwnerJson(path)), desired)) throw Error('BB_REGISTRATION_HANDOFF_CHANGED');
      await rename(temporary, path); temporaryCreated = false;
    } else {
      // Exclusive first publication: never overwrite a path created after check.
      await link(temporary, path); await unlink(temporary); temporaryCreated = false;
    }
    privateFile(await lstat(path), uid);
    return desired;
  } finally {
    if (temporaryCreated) await unlink(temporary);
    try { if (sameInode(lockStat, await lstat(lockPath))) await unlink(lockPath); }
    finally { await lock.close(); }
  }
}
