import { constants } from 'node:fs';
import { open, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertPrivateOwnerParent } from "./owner-grant.ts";
import { operatorProfilePath, provisionOperatorRootProfile } from "./operator-profile.ts";
import { attachmentPayloadFingerprint, operatorEnrollmentPath, provisionOperatorEnrollment, type OperatorAttachmentSelectors } from "./operator-profile-enrollment.ts";

interface AttachArgs { dataDir: string; serverUrl: string; requestId: string; projectId: string; environmentId: string; grantPath: string; descriptorPath: string }
function failure(code: string): never { throw Error(code); }
async function localMachineAuth(dataDir: string): Promise<{ hostId: string; hostKey: string }> {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || await realpath(dataDir) !== dataDir) failure('BB_ATTACH_LOCAL_DATA_DIR_REQUIRED');
  // Read existing normal BB machine credentials IN PLACE; no key issuance/copy/new auth system.
  const handle = await open(join(dataDir, 'auth.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size > 16384)
      failure('BB_ATTACH_PRIVATE_MACHINE_AUTH_REQUIRED');
    const bytes = Buffer.alloc(16385); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) failure('BB_ATTACH_MACHINE_AUTH_CHANGED');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    if (!value || typeof value.hostId !== 'string' || !value.hostId.trim() || typeof value.hostKey !== 'string' || !value.hostKey.trim()) failure('BB_ATTACH_MACHINE_AUTH_INVALID');
    return { hostId: value.hostId, hostKey: value.hostKey };
  } finally { await handle.close(); }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: Record<string, unknown>, keys: string[]): boolean { return Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k)); }
function sdkDirectoryFromFile(path: unknown, expectedName: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || basename(path) !== expectedName || basename(dirname(path)) !== 'observation-roots')
    failure('BB_ATTACH_CURRENT_DAEMON_LOCATION_INVALID');
  return dirname(dirname(path)); // Location came from authenticated CURRENT daemon response, never cwd/HOME/options.
}
/** ONE local OS-operator workflow. Not a plugin-server/public caller command and never invokes a model. */
export async function attachExistingNativeRoot(args: AttachArgs, requestFetch: typeof fetch = fetch): Promise<{ status: 'started'; requestId: string; threadId: string; enrollmentFingerprint: string }> {
  const url = new URL(args.serverUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    failure('BB_ATTACH_V1_LOCAL_SERVER_REQUIRED');
  const auth = await localMachineAuth(args.dataDir);
  const body = { requestId: args.requestId, projectId: args.projectId, environmentId: args.environmentId, providerId: 'pi-durable' as const };
  const scope: OperatorAttachmentSelectors = { ...body, hostId: auth.hostId };
  const config = { grantPath: args.grantPath, descriptorPath: args.descriptorPath };
  async function post(path: string): Promise<unknown> {
    const response = await requestFetch(new URL(path, url), { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${auth.hostKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      if (response.status === 409) {
        const value: unknown = await response.json().catch(() => null);
        if (record(value) && exact(value, ['error']) && value.error === 'BB_OBSERVATION_REOPEN_REQUIRED')
          failure('BB_OBSERVATION_REOPEN_REQUIRED: grant prepared. Reopen the packaged native host with the same owner-grant path, then repeat this exact command with the same request ID. No host was restarted automatically.');
      }
      failure(`BB_ATTACH_CORE_HTTP_${response.status}`);
    }
    return response.json();
  }
  const reservePath = '/internal/hosts/threads/attach-existing-root';
  let response = await post(reservePath);
  if (!record(response)) failure('BB_ATTACH_RESERVE_RESPONSE_INVALID');
  let sdkDir: string;
  if (response.status === 'enrollment-required') {
    if (!exact(response, ['status','enrollmentFile'])) failure('BB_ATTACH_DISCOVERY_RESPONSE_INVALID');
    sdkDir = sdkDirectoryFromFile(response.enrollmentFile, args.requestId + '.enrollment.json');
    const parent = dirname(operatorEnrollmentPath(sdkDir, args.requestId));
    if (await realpath(sdkDir) !== sdkDir) failure('BB_ATTACH_CURRENT_DAEMON_LOCATION_INVALID');
    try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await directory.stat();
      // BB data directories can propagate setgid. Clear only this bit on an already private, owned directory.
      if (stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o2700 && await realpath(parent) === parent)
        await directory.chmod(0o700);
    } finally { await directory.close(); }
    await assertPrivateOwnerParent(operatorEnrollmentPath(sdkDir, args.requestId));
    await provisionOperatorEnrollment(sdkDir, scope, config);
    response = await post(reservePath); // Identical selectors, not a rebase/replacement admission.
  } else {
    if (typeof response.threadId !== 'string') failure('BB_ATTACH_RESERVE_RESPONSE_INVALID');
    sdkDir = sdkDirectoryFromFile(response.profileFile, response.threadId + '.json');
  }
  if (!record(response) || !exact(response, ['status','threadId','enrollmentFingerprint','profileFile']) || response.status !== 'reserved'
    || typeof response.threadId !== 'string' || typeof response.enrollmentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(response.enrollmentFingerprint))
    failure('BB_ATTACH_RESERVE_RESPONSE_INVALID');
  if (response.profileFile !== operatorProfilePath(sdkDir, response.threadId)) failure('BB_ATTACH_ROOT_PROFILE_LOCATION_INVALID');
  const enrollment = await provisionOperatorEnrollment(sdkDir, scope, config); // Exact existing-file retry ONLY.
  const fingerprint = attachmentPayloadFingerprint(enrollment);
  if (fingerprint !== response.enrollmentFingerprint) failure('BB_ATTACH_ENROLLMENT_FINGERPRINT_MISMATCH');
  await provisionOperatorRootProfile(sdkDir, response.threadId, config);
  const started = await post('/internal/hosts/threads/' + encodeURIComponent(response.threadId) + '/start-existing-root');
  if (!record(started) || !exact(started, ['status','threadId']) || started.status !== 'started' || started.threadId !== response.threadId) failure('BB_ATTACH_START_RESPONSE_INVALID');
  return { status: 'started', requestId: args.requestId, threadId: response.threadId, enrollmentFingerprint: fingerprint }; // Not terminal/history success.
}
export function parseAttachArgs(argv: string[]): AttachArgs {
  const flags = new Map([['--bb-data-dir','dataDir'],['--server-url','serverUrl'],['--request-id','requestId'],['--project','projectId'],['--environment','environmentId'],['--grant','grantPath'],['--descriptor','descriptorPath']]);
  const value: Record<string, string> = {};
  for (let i=0;i<argv.length;i+=2) { const key = flags.get(argv[i]); if (!key || !argv[i+1] || argv[i+1].startsWith('--') || value[key]) failure('BB_ATTACH_ARGUMENTS_INVALID'); value[key]=argv[i+1]; }
  if (Object.keys(value).length !== flags.size) failure('BB_ATTACH_ARGUMENTS_REQUIRED: --bb-data-dir --server-url --request-id --project --environment --grant --descriptor');
  return value as unknown as AttachArgs;
}
if (import.meta.main) {
  let requestId: string | undefined;
  try { const args=parseAttachArgs(process.argv.slice(2)); requestId=args.requestId; console.log(JSON.stringify(await attachExistingNativeRoot(args))); }
  catch (error) {
    const reopen = error instanceof Error && error.message.startsWith('BB_OBSERVATION_REOPEN_REQUIRED:');
    console.error(JSON.stringify({ status:'blocked',requestId,
      error:reopen?'BB_OBSERVATION_REOPEN_REQUIRED':error instanceof Error&&/^BB_ATTACH_[A-Z0-9_]+$/.test(error.message)?error.message:'BB_ATTACH_FAILED',
      retainedFiles:true,action:reopen?'Grant prepared. Explicitly reopen the SAME packaged native session with the SAME owner-grant path, then repeat this exact command with the SAME request-id. No host was restarted automatically.':'Keep the SAME request-id and original files; no automatic rebase/replacement/retry' }));
    process.exitCode=1;
  }
}
