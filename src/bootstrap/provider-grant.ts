import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { assertPrivateOwnerParent, provisionOwnerGrant, readOwnerGrant, readPrivateOwnerJson, OWNER_GRANT_PROTOCOL, type OwnerGrant } from "./owner-grant.ts";

export type OperatorGrantConfig = Readonly<{ grantPath: string; descriptorPath: string }>;
export type ProviderOwnerScope = Readonly<{ providerId: string; threadId: string; providerThreadId: string; parentThreadId: string | null }>; 
export type SelectedNativeSession = Readonly<{ socket: string; session: { id: string; directory: string; cwd: string } }>;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function operatorGrantConfig(env: NodeJS.ProcessEnv = process.env): OperatorGrantConfig | undefined {
  const grantPath = env.PI_DURABLE_OWNER_GRANT_PATH;
  const descriptorPath = env.PI_DURABLE_SELECTED_SESSION_DESCRIPTOR;
  if (grantPath === undefined && descriptorPath === undefined) return undefined;
  if (!text(grantPath) || !text(descriptorPath) || resolve(grantPath) !== grantPath || resolve(descriptorPath) !== descriptorPath
    || basename(descriptorPath) !== 'shared-host.json') throw Error('BB_OWNER_OPERATOR_PATHS_REQUIRED');
  return Object.freeze({ grantPath, descriptorPath });
}
export function stableRootProviderId(threadId: string): string {
  if (!text(threadId)) throw Error('BB_OWNER_THREAD_REQUIRED');
  return `pi_durable_bb_${createHash('sha256').update(threadId).digest('hex')}`;
}
export function ownerScopeFrom(value: unknown): ProviderOwnerScope {
  if (!record(value) || Object.keys(value).length !== 4 || !text(value.providerId) || !text(value.threadId) || !text(value.providerThreadId)
    || (value.parentThreadId !== null && !text(value.parentThreadId)))
    throw Error('BB_OWNER_SCOPE_UNCONFIRMED');
  return Object.freeze({ providerId: value.providerId, threadId: value.threadId, providerThreadId: value.providerThreadId, parentThreadId: value.parentThreadId });
}
export async function readSelectedNativeSession(path: string): Promise<SelectedNativeSession> {
  const value = await readPrivateOwnerJson(path);
  if (!record(value) || Object.keys(value).length !== 3 || value.protocol !== 'bb-durable-selected-session/v1'
    || !text(value.socket) || !record(value.session) || Object.keys(value.session).length !== 3
    || !text(value.session.id) || !text(value.session.directory) || !text(value.session.cwd)) throw Error('BB_OWNER_NATIVE_DESCRIPTOR_INVALID');
  const uid = await assertPrivateOwnerParent(value.socket);
  const socket = await lstat(value.socket);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o7777) !== 0o600) throw Error('BB_OWNER_NATIVE_SOCKET_REQUIRED');
  if (await realpath(value.session.directory) !== value.session.directory || await realpath(value.session.cwd) !== value.session.cwd)
    throw Error('BB_OWNER_NATIVE_CANONICAL_PATH_REQUIRED');
  return Object.freeze({ socket: value.socket, session: Object.freeze({ id: value.session.id, directory: value.session.directory, cwd: value.session.cwd }) });
}
export async function verifyNativeReady(selected: SelectedNativeSession, ready: unknown, state: unknown, requestedCwd: string | undefined): Promise<void> {
  if (!record(ready) || ready.kind !== 'ready' || ready.sharedHost !== true || !record(ready.session) || !record(state)
    || ready.session.id !== selected.session.id || ready.session.directory !== selected.session.directory || ready.session.cwd !== selected.session.cwd
    || state.sessionId !== selected.session.id || state.cwd !== selected.session.cwd || !requestedCwd
    || await realpath(requestedCwd) !== selected.session.cwd) throw Error('BB_OWNER_NATIVE_SESSION_MISMATCH');
}

async function requireObservationEndpoint(grant: OwnerGrant): Promise<void> {
  try {
    const uid = await assertPrivateOwnerParent(grant.socketPath);
    const stat = await lstat(grant.socketPath);
    if (!stat.isSocket() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) throw Error('INVALID_ENDPOINT');
    await new Promise<void>((resolveReady, reject) => {
      const socket = createConnection(grant.socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(Error('ENDPOINT_TIMEOUT')); }, 1000);
      socket.once('error', reject);
      socket.once('connect', () => { socket.destroy(); resolveReady(); });
      socket.once('close', () => clearTimeout(timer));
    });
  } catch { throw Error('BB_OBSERVATION_REOPEN_REQUIRED: operator must cold-start/reopen packaged native host'); }
}

/** Called ONLY by the real provider session after read-only native verification and scoped daemon RPC. */
export async function produceProviderOwnerGrant(args: {
  config: OperatorGrantConfig;
  proof: ProviderOwnerScope;
  expected: Pick<ProviderOwnerScope, 'providerId' | 'threadId' | 'providerThreadId'>;
  childConversationId?: string;
}): Promise<OwnerGrant> {
  const { config, proof, expected, childConversationId } = args;
  if (proof.providerId !== expected.providerId || proof.threadId !== expected.threadId || proof.providerThreadId !== expected.providerThreadId)
    throw Error('BB_OWNER_SCOPE_MISMATCH');
  const separator = proof.providerThreadId.indexOf(':');
  const sessionId = separator < 0 ? proof.providerThreadId : proof.providerThreadId.slice(0, separator);
  let existing: OwnerGrant | undefined;
  try { existing = await readOwnerGrant(config.grantPath); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  if (childConversationId !== undefined || proof.parentThreadId !== null) {
    if (childConversationId === undefined || proof.parentThreadId === null || !existing || existing.ownerScope.providerId !== proof.providerId
      || existing.ownerScope.sessionId !== sessionId || existing.ownerScope.parentThreadId !== proof.parentThreadId
      || existing.ownerScope.parentThreadId === proof.threadId) throw Error('BB_OWNER_CHILD_CANNOT_PROVISION');
    await requireObservationEndpoint(existing);
    return existing; // Child reuses authorized parent scope; never mints/promotes itself.
  }
  const desired: OwnerGrant = { protocol: OWNER_GRANT_PROTOCOL,
    ownerScope: { providerId: proof.providerId, sessionId, parentThreadId: proof.threadId }, socketPath: config.grantPath + '.sock' };
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(desired)) throw Error('BB_OWNER_GRANT_CONFLICT');
    await requireObservationEndpoint(existing);
    return existing;
  }
  try { await provisionOwnerGrant(config.grantPath, desired); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
    const raced = await readOwnerGrant(config.grantPath);
    if (JSON.stringify(raced) !== JSON.stringify(desired)) throw Error('BB_OWNER_GRANT_CONFLICT');
  }
  throw Error('BB_OBSERVATION_REOPEN_REQUIRED: grant prepared; operator must cold-start/reopen packaged native host');
}
