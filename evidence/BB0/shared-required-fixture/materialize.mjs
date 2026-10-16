import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../../../', import.meta.url));
export const ownedCache = join(project, 'evidence/BB0/lead-private/.cache/shared-required-stage1');
const own = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inventoryBytes = readFileSync(join(project, 'candidate-manifest.json'));
if (sha(inventoryBytes) !== 'cf4e31a9e48a2286b507f59c7a53b32ce4947e16bc6275c482686873f7a59645') throw new Error('BASELINE_MANIFEST_CHANGED');
export const inventory = JSON.parse(inventoryBytes);

export function prepareFixture(root, change = () => {}) {
  if (!resolve(root).startsWith(ownedCache + '/') || resolve(root) !== root) throw new Error('OUTSIDE_OWNED_CACHE');
  const sessionKey = `bb0_${randomUUID()}`;
  const now = Date.now();
  const declaration = {
    version: 1, mode: 'shared-required-stage1', fixtureId: randomUUID(), sessionKey,
    expectedThreadId: 'synthetic-thread', bindingDirectory: join(root, 'bindings', sessionKey),
    cwd: join(root, 'work'), socket: join(root, 's'), createdAt: now, expiresAt: now + 300000,
  };
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  for (const dir of [join(root, 'bindings'), declaration.bindingDirectory, declaration.cwd]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const controls = { omitAdmission: false, omitBinding: false, binding: { socket: declaration.socket } };
  change(declaration, controls);
  if (!controls.omitBinding) writeFileSync(join(root, 'bindings', sessionKey, 'shared-host.json'), JSON.stringify(controls.binding), { flag: 'wx', mode: 0o600 });
  // Publication is last; K and every declaration directory already exist.
  if (!controls.omitAdmission) writeFileSync(join(root, 'admission.json'), JSON.stringify(declaration), { flag: 'wx', mode: 0o600 });
  return declaration;
}

export function materialize(root, { patches = true } = {}) {
  if (!resolve(root).startsWith(ownedCache + '/') || resolve(root) !== root || realpathSync(root) !== root) throw new Error('OUTSIDE_OWNED_CACHE');
  const source = join(project, 'candidates/provider');
  const baseline = new Map(inventory.sources.provider.files.map(record => {
    const path = join(source, record.path);
    if (relative(source, path).startsWith('..') || !lstatSync(path).isFile() || realpathSync(path) !== path) throw new Error('UNSAFE_SOURCE');
    const bytes = readFileSync(path);
    if (sha(bytes) !== record.sha256) throw new Error(`BASELINE_CHANGED:${record.path}`);
    return [record.path, bytes];
  }));
  const overlay = JSON.parse(readFileSync(join(own, 'overlay-v1.json'), 'utf8'));
  const output = new Map(baseline);
  if (patches) for (const patch of overlay.patches) {
    let text = output.get(patch.path).toString('utf8');
    for (const [before, after] of patch.replacements) {
      if (text.split(before).length !== 2) throw new Error(`PATCH_NOT_UNIQUE:${patch.path}:${before}`);
      text = text.replace(before, after);
    }
    output.set(patch.path, Buffer.from(text));
  }
  const admission = readFileSync(join(own, 'overlay/fixture-admission.mjs'), 'utf8').replace("'__MATERIALIZED_PRIVATE_FIXTURE_ROOT__'", JSON.stringify(root));
  if (patches) output.set('src/fixture-admission.mjs', Buffer.from(admission));
  const variant = join(root, patches ? 'variant' : 'baseline-control');
  mkdirSync(variant, { mode: 0o700 });
  const records = [];
  for (const [path, bytes] of output) {
    const target = join(variant, path);
    mkdirSync(dirname(target), { mode: 0o700, recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(target, 0o400);
    records.push({ path, sha256: sha(bytes), bytes: bytes.length, baselineSha256: baseline.has(path) ? sha(baseline.get(path)) : null });
  }
  writeFileSync(join(root, `${patches ? 'variant' : 'baseline-control'}-manifest.json`), JSON.stringify({ version: 1, baselineManifestSha256: sha(inventoryBytes), overlaySha256: sha(readFileSync(join(own, 'overlay-v1.json'))), records }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return variant;
}
