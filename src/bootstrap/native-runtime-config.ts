import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readPrivateOwnerJson } from './owner-grant.ts';

export const nativeConfigPath = (dataDir: string) => join(dataDir, 'native-runtime', 'runtime.json');
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export type NativeRuntimeConfig = Readonly<{
  protocol: 'bb-native-runtime/v1'; cli: string; cliSHA256: string;
  manifest: string; manifestSHA256: string; helper: string; helperSHA256: string;
  env: Readonly<Record<string, string>>;
}>;
export async function checkedNativeRuntime(dataDir: string) {
  let value: unknown;
  try { value = await readPrivateOwnerJson(nativeConfigPath(dataDir)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw Error('NATIVE_RUNTIME_NOT_CONFIGURED: configure the admitted native CLI; managed execution is disabled'); throw e; }
  return verifyNativeRuntime(value);
}
export async function verifyNativeRuntime(value: unknown) {
  const v = value as NativeRuntimeConfig;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'cli,cliSHA256,env,helper,helperSHA256,manifest,manifestSHA256,protocol'
    || v.protocol !== 'bb-native-runtime/v1' || !v.env || typeof v.env !== 'object' || Array.isArray(v.env)
    || Object.keys(v.env).some(k => !['PI_CODING_AGENT_DIR', 'PI_AGENT_DIR'].includes(k))) throw Error('NATIVE_RUNTIME_CONFIG_INVALID');
  for (const [path, sha] of [[v.cli, v.cliSHA256], [v.manifest, v.manifestSHA256], [v.helper, v.helperSHA256]]) {
    if (typeof path !== 'string' || await realpath(path) !== path || digest(await readFile(path)) !== sha) throw Error('NATIVE_RUNTIME_PIN_CHANGED');
  }
  for (const path of Object.values(v.env)) if (typeof path !== 'string' || await realpath(path) !== path) throw Error('NATIVE_RUNTIME_ENV_INVALID');
  const manifest = JSON.parse(await readFile(v.manifest, 'utf8'));
  const extension = join(dirname(v.manifest), 'after-local-host.mjs');
  if (digest(await readFile(extension)) !== manifest.outputSHA256) throw Error('NATIVE_RUNTIME_EXTENSION_CHANGED');
  for (const [path, sha] of Object.entries(manifest.prerequisites ?? {}))
    if (digest(await readFile(path)) !== sha) throw Error('NATIVE_RUNTIME_PREREQUISITE_CHANGED');
  for (const name of ['pi-durable', 'pi-ai', 'chord']) {
    const p = JSON.parse(await readFile(join(manifest.sdkRoot, '@earendil-works', name, 'package.json'), 'utf8'));
    if (p.version !== '1.3.0') throw Error('NATIVE_RUNTIME_SDK_13_REQUIRED');
  }
  return { config: Object.freeze(v), extension, global: manifest.global as string, revision: digest(Buffer.from(JSON.stringify([v.cliSHA256, v.manifestSHA256, v.env]))) };
}
