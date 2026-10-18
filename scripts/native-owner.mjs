import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export const nativeOwnerAlias = '@bb-durable/native-subagents';

/** Public external owner entry only; source aliases never escape the build. */
export async function selectedNativeOwner(nativeEntry, expectedSha256) {
  const factory = await realpath(nativeEntry);
  if (!factory.endsWith('/packages/local-host/src/global.ts')) throw Error('BUILD_POLICY_ENTRYPOINT_INVALID');
  const root = resolve(dirname(factory), '../../..');
  const path = resolve(root, 'packages/durable-subagents/src/index.ts');
  const entrypoint = await realpath(path).catch(() => { throw Error(`BUILD_NATIVE_OWNER_UNAVAILABLE: ${path}`); });
  if (entrypoint !== path) throw Error(`BUILD_NATIVE_OWNER_OUTSIDE_SELECTED_RELEASE: ${entrypoint}`);
  const sha256 = createHash('sha256').update(await readFile(entrypoint)).digest('hex');
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw Error('BUILD_NATIVE_OWNER_HASH_MISMATCH');
  return { alias: nativeOwnerAlias, entrypoint, sha256 };
}

/** esbuild canonicalizes paths: assert the owner exists once, with no second release. */
export function checkNativeOwnerGraph(metafile, owner, cwd) {
  const inputs = Object.keys(metafile.inputs).map(path => resolve(cwd, path));
  const roots = inputs.filter(path => path.endsWith('/packages/durable-subagents/src/index.ts'));
  if (roots.length !== 1 || roots[0] !== owner.entrypoint) throw Error('BUILD_NATIVE_OWNER_IDENTITY_MISMATCH');
  const selectedDirectory = dirname(owner.entrypoint) + '/';
  for (const path of inputs) {
    if (path.includes('/packages/durable-subagents/src/') && !path.startsWith(selectedDirectory))
      throw Error(`BUILD_NATIVE_OWNER_DUPLICATE_RELEASE: ${path}`);
  }
}
