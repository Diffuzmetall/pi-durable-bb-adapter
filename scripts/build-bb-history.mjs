import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { patchNativeChildRuntime } from '../compat/source/native-child-session.mjs';

// Rebuild only the existing Core compatibility history module. No installation,
// live data, server lifecycle, Pi Host Core or migration change is performed.
const root = resolve(import.meta.dirname, '..');
const manifestPath = join(root, 'compat/manifest.json');
const originalManifest = await readFile(manifestPath);
const manifest = JSON.parse(originalManifest);
const archive = join(root, 'compat', manifest.archive);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(archive)), manifest.archiveSHA256, 'Archive drift');
const temporary = await mkdtemp(join(tmpdir(), 'bb-history-build-'));
const unpack = join(temporary, 'unpack');
await mkdir(unpack, { mode: 0o700 });
const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 2_000_000 }).trim().split('\n');
for (const name of names) assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), 'Unsafe archive path');
const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 4_000_000 });
for (const line of listing.trim().split('\n')) assert.ok(['-', 'd'].includes(line[0]), 'Archive links refused');
execFileSync('tar', ['-xzf', archive, '-C', unpack]);
for (const [name, digest] of Object.entries(manifest.outputs)) assert.equal(hash(await readFile(join(unpack, name))), digest, name);
const result = await build({ absWorkingDir: root, entryPoints: ['compat/source/native-registration.ts'],
  bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', target: 'node24' });
const output = result.outputFiles[0].contents;
await writeFile(join(unpack, 'native-history-server.mjs'), output);
manifest.outputs['native-history-server.mjs'] = hash(output);
const daemonPath = join(unpack, 'daemon-bundle.mjs');
const daemon = patchNativeChildRuntime(await readFile(daemonPath, 'utf8'));
await writeFile(daemonPath, daemon);
const previousDaemon = manifest.outputs['daemon-bundle.mjs'];
manifest.outputs['daemon-bundle.mjs'] = hash(Buffer.from(daemon));
if (previousDaemon !== manifest.outputs['daemon-bundle.mjs']) {
  const target = manifest.stagingTargets['daemon-bundle.mjs'];
  manifest.acceptedOverlayInputs ??= {};
  manifest.acceptedOverlayInputs[target] = [...new Set([...(manifest.acceptedOverlayInputs[target] ?? []), previousDaemon])];
}
// Pin the canonical sources alongside the executable, without disturbing base pins.
manifest.historySources = {};
for (const name of [...Object.keys(result.metafile.inputs).filter(name => name.startsWith('compat/source/') || name.startsWith('src/bb-compat/')), 'compat/source/native-child-session.mjs'].sort())
  manifest.historySources[name] = hash(await readFile(join(root, name)));
const candidate = join(temporary, manifest.archive);
execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', candidate, '-C', unpack, '.']);
manifest.archiveSHA256 = hash(await readFile(candidate));
assert.equal(hash(await readFile(archive)), JSON.parse(originalManifest).archiveSHA256, 'Archive changed during build');
assert.equal(hash(await readFile(manifestPath)), hash(originalManifest), 'Manifest changed during build');
const backup = join(temporary, 'before');
await mkdir(backup, { mode: 0o700 });
await copyFile(archive, join(backup, manifest.archive));
await writeFile(join(backup, 'manifest.json'), originalManifest, { mode: 0o600 });
const nextManifest = join(temporary, 'manifest.json');
await writeFile(nextManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
try {
  // Copy into the target filesystem before the atomic per-file renames.
  await copyFile(candidate, archive + '.building');
  await copyFile(nextManifest, manifestPath + '.building');
  await rename(archive + '.building', archive);
  await rename(manifestPath + '.building', manifestPath);
} catch (error) {
  await copyFile(join(backup, manifest.archive), archive);
  await copyFile(join(backup, 'manifest.json'), manifestPath);
  throw error;
}
console.log(JSON.stringify({ status: 'built-not-activated', archiveSHA256: manifest.archiveSHA256,
  historyModuleSHA256: manifest.outputs['native-history-server.mjs'], backup, migrationsChanged: false }));
