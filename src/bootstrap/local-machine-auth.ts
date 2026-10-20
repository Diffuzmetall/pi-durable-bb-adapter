import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Existing OS-operator credentials, read in place. No CLI entry or key issuance. */
export async function localMachineAuth(dataDir: string): Promise<{ hostId: string; hostKey: string }> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || await realpath(dataDir) !== dataDir) throw Error('BB_ATTACH_LOCAL_DATA_DIR_REQUIRED');
  const handle = await open(join(dataDir, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > 16384)
      throw Error('BB_ATTACH_PRIVATE_MACHINE_AUTH_REQUIRED');
    const bytes = Buffer.alloc(16385); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('BB_ATTACH_MACHINE_AUTH_CHANGED');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (!value || typeof value.hostId !== 'string' || !value.hostId.trim() || typeof value.hostKey !== 'string' || !value.hostKey.trim()) throw Error('BB_ATTACH_MACHINE_AUTH_INVALID');
    return { hostId: value.hostId, hostKey: value.hostKey };
  } finally { await handle.close(); }
}
