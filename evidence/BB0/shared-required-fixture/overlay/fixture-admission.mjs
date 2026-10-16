import { constants, lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// Materialization pins this once; no environment/config fallback exists.
const fixtureRoot = '__MATERIALIZED_PRIVATE_FIXTURE_ROOT__';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const fields = ['version', 'mode', 'fixtureId', 'sessionKey', 'expectedThreadId', 'bindingDirectory', 'cwd', 'socket', 'createdAt', 'expiresAt'].sort();

function deny(code) {
  const error = new Error(`BB0_FIXTURE_REFUSED:${code}`);
  error.code = code;
  throw error;
}

export function validateDeclaration(value, root, now = Date.now()) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) deny('ROOT_INVALID');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== fields.join('|')) deny('DECLARATION_SCHEMA');
  if (value.version !== 1 || value.mode !== 'shared-required-stage1') deny('DECLARATION_MODE');
  if (typeof value.fixtureId !== 'string' || !new RegExp(`^${uuid}$`).test(value.fixtureId)) deny('DECLARATION_FIXTURE_ID');
  if (typeof value.sessionKey !== 'string' || !new RegExp(`^bb0_${uuid}$`).test(value.sessionKey)) deny('DECLARATION_KEY');
  if (typeof value.expectedThreadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.expectedThreadId)) deny('DECLARATION_THREAD');
  if (!Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.createdAt > now || value.expiresAt <= now || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 300000) deny('DECLARATION_STALE');
  if (value.bindingDirectory !== join(root, 'bindings', value.sessionKey)) deny('DECLARATION_BINDING');
  if (value.cwd !== join(root, 'work')) deny('DECLARATION_CWD');
  if (value.socket !== join(root, 's') || Buffer.byteLength(value.socket) > 107) deny('DECLARATION_SOCKET');
  return Object.freeze({ ...value, runtimeAdmission: 'UNAVAILABLE' });
}

function metadata(path, kind, mode) {
  let stat;
  try { stat = lstatSync(path); } catch { deny('PATH_MISSING'); }
  if (stat.isSymbolicLink()) deny('PATH_SYMLINK');
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) deny('PATH_UID');
  if ((stat.mode & 0o7777) !== mode) deny('PATH_MODE');
  if (!(kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile())) deny('PATH_TYPE');
  if (kind === 'file' && (stat.nlink !== 1 || stat.size > 65536)) deny('FILE_SHAPE');
  if (realpathSync(path) !== path) deny('PATH_CANONICAL');
  return stat;
}

function readPrivateJson(path) {
  const before = metadata(path, 'file', 0o600);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = fstatSync(fd);
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1 || after.size > 65536) deny('FILE_CHANGED');
    const text = readFileSync(fd, 'utf8');
    try { return JSON.parse(text); } catch { deny('JSON_MALFORMED'); }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function admitPureFixture() {
  metadata(fixtureRoot, 'directory', 0o700);
  const admission = validateDeclaration(readPrivateJson(join(fixtureRoot, 'admission.json')), fixtureRoot);
  for (const directory of [join(fixtureRoot, 'bindings'), admission.bindingDirectory, admission.cwd]) metadata(directory, 'directory', 0o700);
  const binding = readPrivateJson(join(admission.bindingDirectory, 'shared-host.json'));
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).join('|') !== 'socket' || binding.socket !== admission.socket) deny('BINDING_SOCKET');
  return admission;
}

export function admitPrivateFixture() {
  const admission = admitPureFixture();
  metadata(admission.socket, 'socket', 0o600);
  return admission;
}

export function refuseFixtureEntry(entry, params = {}, boundary = entry) {
  try {
    const admission = admitPureFixture();
    if (!params || typeof params !== 'object' || Array.isArray(params)) deny('REQUEST_SCHEMA');
    if (params.threadId !== undefined && params.threadId !== admission.expectedThreadId) deny('REQUEST_THREAD');
    if (/^(thread\/|turn\/|registry\.)/.test(entry) && params.threadId !== admission.expectedThreadId) deny('REQUEST_THREAD');
    if (params.providerThreadId !== undefined && params.providerThreadId !== admission.sessionKey) deny('REQUEST_KEY');
    if (entry === 'thread/resume' && params.providerThreadId !== admission.sessionKey) deny('REQUEST_REOPEN_KEY');
    if (params.cwd !== undefined && params.cwd !== admission.cwd) deny('REQUEST_CWD');
    if (params.options?.cwd !== undefined && params.options.cwd !== admission.cwd) deny('REQUEST_CWD');
    if (params.sessionDirectory !== undefined && params.sessionDirectory !== admission.bindingDirectory) deny('REQUEST_BINDING');
    if (params.shellEnvOverrides !== undefined || params.options?.envVars !== undefined) deny('REQUEST_ENV');
    metadata(admission.socket, 'socket', 0o600);
    // Stage1 cannot start a runner or attach even when every filesystem check passes.
    deny('STAGE2_NOT_ADMITTED');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BB0_FIXTURE_REFUSED:')) {
      error.fixtureBoundary = boundary;
      error.message += `:BOUNDARY=${boundary}`;
    }
    throw error;
  }
}
