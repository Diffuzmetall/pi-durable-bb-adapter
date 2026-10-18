import { constants, lstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { assertPrivateOwnerParent, readPrivateOwnerJson } from "./owner-grant.ts";
import { operatorGrantConfig, type OperatorGrantConfig } from "./provider-grant.ts";

/** ONLY the normal SDK ProviderBridgeDefinition.start(context) supplies this directory. */
export function sdkOperatorDirectory(context: { pluginId: string; dataDir: string }): string {
  if (!context || typeof context.pluginId !== 'string' || !context.pluginId.trim() || typeof context.dataDir !== 'string'
    || !isAbsolute(context.dataDir) || resolve(context.dataDir) !== context.dataDir || context.dataDir.includes('\0'))
    throw Error('BB_OPERATOR_SDK_CONTEXT_REQUIRED');
  return context.dataDir;
}
export function operatorProfilePath(dataDir: string, threadId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(threadId)) throw Error('BB_OPERATOR_PROFILE_ROOT_ID_REQUIRED');
  return join(dataDir, 'observation-roots', threadId + '.json');
}
/** Presence is a routing hint ONLY, never permission; contents are not read before Core proof. */
export function hasOperatorProfile(dataDir: string, threadId: string): boolean {
  try { lstatSync(operatorProfilePath(dataDir, threadId)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** Local OS operator writer only; no RPC or wire path calls this. Creation grants NO Core/native authority. */
export async function provisionOperatorRootProfile(dataDir: string, threadId: string, config: OperatorGrantConfig): Promise<void> {
  const path = operatorProfilePath(dataDir, threadId);
  await assertPrivateOwnerParent(path);
  const checked = operatorGrantConfig({ PI_DURABLE_OWNER_GRANT_PATH: config.grantPath,
    PI_DURABLE_SELECTED_SESSION_DESCRIPTOR: config.descriptorPath });
  if (!checked) throw Error('BB_OPERATOR_PROFILE_INVALID');
  await assertPrivateOwnerParent(checked.grantPath);
  await assertPrivateOwnerParent(checked.descriptorPath);
  await provisionPrivateOperatorFile(path, { protocol: 'bb-durable-operator-profile/v1', threadId, ...checked });
}
/** Shared exclusive writer for the two actual local operator files; not an RPC/config manager. */
export async function provisionPrivateOperatorFile(path: string, value: unknown): Promise<void> {
  await assertPrivateOwnerParent(path);
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > 16 * 1024) throw Error('BB_OPERATOR_PROFILE_TOO_LARGE');
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readPrivateOwnerJson(path);
    if (!isDeepStrictEqual(existing, value))
      throw Error('BB_OPERATOR_PROFILE_CONFLICT');
    return; // Exact explicit retry, never overwrite/rebase a committed profile.
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1)
      throw Error('BB_OPERATOR_PROFILE_PRIVATE_FILE_REQUIRED');
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); } // Partial failure remains fail-closed; no deletion/replacement.
}
/** Private operator routing ONLY. Actual current-process confirmation/getOwnerScope must follow native rootMatch. */
export async function readOperatorRootProfile(dataDir: string, threadId: string): Promise<OperatorGrantConfig> {
  const value = await readPrivateOwnerJson(operatorProfilePath(dataDir, threadId));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('BB_OPERATOR_PROFILE_INVALID');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 4 || v.protocol !== 'bb-durable-operator-profile/v1' || v.threadId !== threadId
    || typeof v.grantPath !== 'string' || typeof v.descriptorPath !== 'string') throw Error('BB_OPERATOR_PROFILE_INVALID');
  const config = operatorGrantConfig({ PI_DURABLE_OWNER_GRANT_PATH: v.grantPath, PI_DURABLE_SELECTED_SESSION_DESCRIPTOR: v.descriptorPath });
  if (!config) throw Error('BB_OPERATOR_PROFILE_INVALID');
  // The grant may not exist yet; its canonical private parent must already exist.
  await assertPrivateOwnerParent(config.grantPath);
  await assertPrivateOwnerParent(config.descriptorPath);
  return config; // Frozen by the existing config reader; paths alone confer NO owner authority.
}
