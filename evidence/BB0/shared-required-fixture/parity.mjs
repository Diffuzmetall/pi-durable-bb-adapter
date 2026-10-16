import { readFileSync, lstatSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { project, inventory } from './materialize.mjs';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const source = [];
for (const name of ['provider', 'host']) for (const record of inventory.sources[name].files) {
  const path = join(project, 'candidates', name, record.path);
  const digest = sha(path);
  source.push({ path: relative(project, path), sha256: digest, expected: record.sha256, match: digest === record.sha256 });
}
const frozenPaths = [
  'baseline.json', 'candidate-manifest.json',
  ...['outcome.json', 'tests.xml', 'lead-baseline-benchmark.md', 'lead-baseline-derived-metrics.json', 'lead-baseline-derived-checkpoint.json',
    'lead-sandbox.py', 'lead-baseline.py', 'lead-baseline-inputs.py', 'lead-baseline-inputs-before.json', 'lead-baseline-inputs-after.json',
    'lead-baseline-unit-checkpoint.json', 'lead-baseline-unit-result.json', 'lead-baseline-unit-tests.xml',
    'lead-baseline-live.py', 'lead-boot.py', 'test-bb-launch.log', 'lead-baseline-live-result.json', 'lead-baseline-perf-samples.json'].map(p => 'evidence/BB0/' + p),
];
const frozen = frozenPaths.map(path => ({ path, sha256: sha(join(project, path)) }));
const rawRoot = join(project, 'evidence/BB0/lead-private/.cache/run-9nukeo2a');
const rawMetadata = [];
function visit(path) {
  const s = lstatSync(path);
  rawMetadata.push({ path: relative(rawRoot, path), mode: s.mode, uid: s.uid, size: s.size, ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
  if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
}
visit(rawRoot);
const snapshot = { source, frozen, rawMetadata, rawCoverage: 'Metadata only, no Pi configuration/auth/store file content read. Public raw result/samples are byte hashed in frozen.' };
const action = process.argv[2];
const base = join(project, 'evidence/BB0/shared-required-fixture');
if (action === 'before') writeFileSync(join(base, 'parity-before.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
else if (action === 'after') {
  const before = JSON.parse(readFileSync(join(base, 'parity-before.json'), 'utf8'));
  const equal = JSON.stringify(before) === JSON.stringify(snapshot);
  writeFileSync(join(base, 'parity-after.json'), JSON.stringify({ equal, ...snapshot }, null, 2) + '\n', { flag: 'wx' });
  if (!equal) throw new Error('FROZEN_PARITY_CHANGED');
} else throw new Error('Expected before or after');
const mismatch = source.filter(x => !x.match);
console.log(JSON.stringify({ action, sourceFiles: source.length, frozenFiles: frozen.length, rawMetadataRecords: rawMetadata.length, sourceMismatch: mismatch }));
if (mismatch.length) process.exitCode = 1;
