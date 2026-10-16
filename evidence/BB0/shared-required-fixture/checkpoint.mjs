import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const own = fileURLToPath(new URL('.', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => fs.readFileSync(join(own, path));
const paths = ['README.md', 'overlay-v1.json', 'overlay/fixture-admission.mjs', 'materialize.mjs', 'parity.mjs', 'checkpoint.mjs', 'run-units.sh', 'tests/declaration.test.mjs', 'tests/entries.test.mjs', 'tests/effects.mjs', 'tests/mutations.json'];
const sources = paths.map(path => ({ path, sha256: sha(read(path)), bytes: read(path).length }));
const logPaths = fs.readdirSync(join(own, 'logs')).sort().map(path => 'logs/' + path);
const artifacts = [...logPaths, 'parity-before.json', 'parity-after.json'].map(path => ({ path, sha256: sha(read(path)), bytes: read(path).length }));
const rows = read('logs/025-final-units.log').toString().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const dependencyRow = rows.find(row => row.loadedModules);
const dependencies = dependencyRow.loadedModules.map(([url, expected]) => {
  const path = fileURLToPath(url);
  if (!path.startsWith('/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules/zod/')) throw new Error('UNEXPECTED_DEPENDENCY');
  const digest = sha(fs.readFileSync(path));
  if (digest !== expected) throw new Error('DEPENDENCY_CHANGED');
  return { path, sha256: digest };
});
const cases = rows.filter(row => row.case);
if (cases.length !== 29 || cases.some(row => Object.values(row.effects).some(Boolean))) throw new Error('UNIT_CASE_EFFECTS');
const parity = JSON.parse(read('parity-after.json'));
if (!parity.equal || parity.source.some(row => !row.match)) throw new Error('BASELINE_PARITY');
const receipts = logPaths.filter(path => path.endsWith('.receipt')).map(path => {
  const text = read(path).toString();
  return { path, ...Object.fromEntries(text.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })) };
});
const variantRecords = cases.map(row => {
  const path = join(row.root, 'variant-manifest.json');
  return { case: row.case, path, sha256: sha(fs.readFileSync(path)) };
});
const manifest = {
  schemaVersion: 1, stage: 'Stage1 refusal component ONLY', task: 'bbup-0-baseline', actor: 'IvoryBridge',
  node: { path: process.execPath, version: process.version },
  baselineManifest: { path: 'candidate-manifest.json', sha256: 'cf4e31a9e48a2286b507f59c7a53b32ce4947e16bc6275c482686873f7a59645' },
  sourceBoundary: 'Only evidence/BB0/shared-required-fixture/** and lead-private/.cache/shared-required-stage1/**; no Git/deps/rawcache additions',
  sources, artifacts, dependency: { name: 'zod', version: '4.6.5', license: 'MIT', loadedFiles: dependencies },
  materializedVariants: variantRecords,
  normalization: 'Each private module differs only by explicitly pinned fixtureRoot; its manifest contains exact 192 file hashes. No compiled variant exists.',
  inputPatchPaths: JSON.parse(read('overlay-v1.json')).patches.map(x => x.path),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(join(own, 'source-test-manifest.json'), manifestBytes, { flag: 'wx' });
const checkpoint = {
  schemaVersion: 1, status: 'needs_checks', generatedAt: new Date().toISOString(), actor: 'IvoryBridge', task: 'bbup-0-baseline', continuationOwner: 'same IvoryBridge Lead session',
  candidate: { manifest: 'evidence/BB0/shared-required-fixture/source-test-manifest.json', sha256: sha(manifestBytes) },
  implemented: 'Versioned eight-file source overlay plus one stdlib admission module; all operational entrypoints refuse before local Pi imports/resources/session/runner construction.',
  selfTests: { command: 'bash evidence/BB0/shared-required-fixture/run-units.sh 025-final-units units', tests: 31, pass: 31, fail: 0, skip: 0, exit: 0, effects: 'zero in all 29 logged refusal/identity case groups; probes verified live', processStoreAbsence: 'own process children unchanged and zero SQLite/lock files in 28 primary refusal fixtures; separate identity case also has zero effect counters' },
  mutationChecks: { finalTags: ['018-mutant-always-deny', '019-mutant-import-final', '020-mutant-bridge-final', '021-mutant-catalog-final', '022-mutant-registry-final', '023-mutant-diagnostics-final', '024-mutant-runner-final'], expectedExit: 1, killed: 7, total: 7, retainedFindings: '009/010 survived redundant downstream gates; tightened origin assertions; 015/016 and final 020/021 reject those mutations.' },
  parity: { sourceFiles: parity.source.length, frozenArtifactHashes: parity.frozen.length, sourceMatchesInventory: true, beforeAfterEqual: parity.equal, rawPrivateCacheMetadataRecords: parity.rawMetadata.length, rawByteScan: 'NOT_REACHED: private raw configuration/auth/store content deliberately not read; public raw result/samples byte hashed' },
  identity: 'Legacy providerThreadId/K exist, not trusted identity. NEW expectedThreadId is synthetic-fixture-only. params.threadId equality plus method start/resume do not prove fresh-root/reopen/second-thread general binding. Real trusted provisioning/persistence contract NOT_REACHED.',
  nativeSocket: 'NOT_REACHED: no socket creation or connection; labelled socket/foreign-UID metadata fault injection only',
  runtimeOwner: 'NOT_REACHED: no owner/Harness/SQLite allocation; no existing owner contacted/cleaned/aborted',
  fullBuild: 'NOT_REACHED; later supported build route remains npm run build, but no build/CLI/install was run and Stage3 needs separate GO',
  catalog: 'UNAVAILABLE; no catalog forwarder/healthy return implemented',
  independentReview: 'PENDING parent-arranged exact-source review; inspect guard/import ordering, request-field limitations, readonly baseline pins, mutation evidence and syscall checks',
  behavioralQA: 'PENDING distinct parent-arranged Node24 pure-unit replay on exact frozen source manifest; no runtime/build/namespace/install authority implied',
  gatesNotAuthorized: ['Stage2 native socket/catalog/namespace', 'Stage3 full supported build/closure', 'BB registration/installation/activation', 'positive runtime/core identity contract'],
  skillsApplied: { BoundaryDiscipline: 'real bridge/discovery/constructor/CLI boundaries, shared pure declaration parser', ProveItWorks: 'actual materialized entry calls, live effect probes, counterfactual mutations, exact hashes', SequenceVerifiableUnits: 'retained RED, setup failures, unit GREEN, mutation blind spot correction, fresh final units; no advance to Stage2', ponytail: 'stdlib UUID/fs/path and existing protocol source; no dependencies added, new builder, replacement provider or shims', AgentEngineering: 'IncrementalImplementation, TestDrivenDevelopment, manual CodeReviewAndQuality self-review; not independent checking' },
  receipts,
  leaseIds: { source: [228,229], lightUnitsCPU: 232 },
  forbiddenActions: { git: false, beadsWrites: false, acceptedSourceWrites: false, testBBWrites: false, bbCLIAPI: false, piConfigurationAuthReads: false, fullBuild: false, namespaceBinds: false, socketConnect: false, modelGeneration: false, nestedDelegation: false, cleanupDeletion: false },
};
fs.writeFileSync(join(own, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ candidateManifestSha256: sha(manifestBytes), checkpointSha256: sha(fs.readFileSync(join(own, 'checkpoint.json'))), sourceFiles: sources.length, artifactFiles: artifacts.length, zodLoadedFiles: dependencies.length, status: checkpoint.status }));
