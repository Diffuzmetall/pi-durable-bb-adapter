import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DurableBinding } from "../store/binding-store.ts";

export const OWNER_GRANT_PROTOCOL = 'bb-durable-owner-grant/v1' as const;
export type OwnerGrant = Readonly<{
  protocol: typeof OWNER_GRANT_PROTOCOL;
  ownerScope: Readonly<Required<Pick<DurableBinding, 'providerId' | 'sessionId' | 'parentThreadId'>>>;
  socketPath: string;
}>;
const MAX_BYTES = 16 * 1024;
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function absolute(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || resolve(path) !== path)
    throw Error('OWNER_GRANT_ABSOLUTE_CANONICAL_PATH_REQUIRED');
}
function validated(value: unknown): OwnerGrant {
  if (!object(value) || !exact(value, ['protocol', 'ownerScope', 'socketPath']) || value.protocol !== OWNER_GRANT_PROTOCOL
    || !object(value.ownerScope) || !exact(value.ownerScope, ['providerId', 'sessionId', 'parentThreadId'])
    || !nonblank(value.ownerScope.providerId) || !nonblank(value.ownerScope.sessionId) || !nonblank(value.ownerScope.parentThreadId))
    throw Error('OWNER_GRANT_INVALID');
  absolute(value.socketPath);
  return Object.freeze({ protocol: OWNER_GRANT_PROTOCOL,
    ownerScope: Object.freeze({ providerId: value.ownerScope.providerId, sessionId: value.ownerScope.sessionId,
      parentThreadId: value.ownerScope.parentThreadId }), socketPath: value.socketPath });
}
export async function assertPrivateOwnerParent(path: string): Promise<number> {
  absolute(path);
  const uid = process.getuid?.();
  if (process.platform !== 'linux' || uid === undefined || !constants.O_NOFOLLOW) throw Error('OWNER_GRANT_PLATFORM_UNSUPPORTED');
  const parent = dirname(path);
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700
    || await realpath(parent) !== parent) throw Error('OWNER_GRANT_PRIVATE_PARENT_REQUIRED');
  return uid;
}
function privateFile(stat: Stats, uid: number) {
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES)
    throw Error('OWNER_GRANT_PRIVATE_FILE_REQUIRED');
}

/**
 * Read an explicitly trusted operator/provisioner path. File ownership is NOT
 * evidence that a BB daemon authenticated the owner tuple. No default discovery,
 * network, storage, host bind or automatic pairing occurs here.
 */
export async function readPrivateOwnerJson(path: string): Promise<unknown> {
  const uid = await assertPrivateOwnerParent(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    privateFile(before, uid);
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (length > MAX_BYTES) throw Error('OWNER_GRANT_TOO_LARGE');
      if (!bytesRead) break;
    }
    const after = await handle.stat();
    privateFile(after, uid);
    if (before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw Error('OWNER_GRANT_CHANGED_DURING_READ');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally { await handle.close(); }
}

export async function readOwnerGrant(path: string): Promise<OwnerGrant> {
  const grant = validated(await readPrivateOwnerJson(path));
  await assertPrivateOwnerParent(grant.socketPath);
  return grant;
}

/**
 * Controlled-start provisioning ONLY. Caller must already possess trusted scope.
 * Exclusive creation never overwrites, chmods or deletes an existing path. A
 * failed write may retain a private incomplete file; readers always fail closed.
 */
export async function provisionOwnerGrant(path: string, value: OwnerGrant): Promise<OwnerGrant> {
  const grant = validated(value);
  const uid = await assertPrivateOwnerParent(path);
  await assertPrivateOwnerParent(grant.socketPath);
  const serialized = Buffer.from(JSON.stringify(grant) + '\n');
  if (serialized.length > MAX_BYTES) throw Error('OWNER_GRANT_TOO_LARGE');
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    privateFile(await handle.stat(), uid);
    await handle.writeFile(serialized);
    await handle.sync();
    privateFile(await handle.stat(), uid);
    return grant;
  } finally { await handle.close(); }
}
