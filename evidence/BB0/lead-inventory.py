#!/usr/bin/env python3
"""Copy admitted source only; verify donor parity and record dependency resolution.
Run from the project root. Never replaces existing candidate files or installs deps.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
NODE = Path('/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node')
DONORS = {
    'provider': Path('/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29'),
    'host': Path('/home/ubuntu/.local/share/pi-durable/host'),
}
EXCLUDE = {'node_modules', '.git', '.pi', 'dist', '.DS_Store'}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def inventory(root):
    rows = []
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE)
        for name in sorted(files):
            p = Path(current) / name
            if p.suffix in {'.db', '.sqlite', '.sqlite3'} or name.endswith(('-wal', '-shm')):
                raise RuntimeError(f'Refusing database in source tree: {p}')
            if p.is_symlink():
                raise RuntimeError(f'Unexpected source symlink: {p}')
            rows.append({'path': str(p.relative_to(root)), 'sha256': sha(p), 'bytes': p.stat().st_size})
    return rows

manifest = {'schemaVersion': 1, 'phase': 'inventory_checkpoint', 'actor': 'IvoryBridge',
    'node': {'path': str(NODE), 'version': subprocess.check_output([NODE, '--version'], text=True).strip()},
    'sources': {}, 'isolation': {'donorsReadOnly': True, 'storesCopied': False,
    'excluded': sorted(EXCLUDE), 'explicitSourceException': 'Only .pi/extensions/durable-reload/index.ts and durable-mcp/index.ts are copied because application modules statically import them. No .pi settings, auth, or stores are copied.', 'dependencyStrategy': 'Per-package donor symlinks. Execution permitted only through verified lead-sandbox.py enforcing read-only donor mounts. Dependencies fingerprinted, not vendored.',
    'testBB': {'url': 'http://127.0.0.1:40886', 'daemonPort': 40887, 'dataDir': str(ROOT / '.test-bb')}},
    'gates': {'unit': 'not_run', 'live': 'not_run', 'perf': 'not_run', 'independentReview': 'pending', 'independentQA': 'pending'}}
for name, donor in DONORS.items():
    target = ROOT / 'candidates' / name
    rows = inventory(donor)
    # These are statically imported application source, not user .pi configuration.
    if name == 'host':
        for relative in ['.pi/extensions/durable-reload/index.ts', '.pi/extensions/durable-mcp/index.ts']:
            p = donor / relative
            rows.append({'path': relative, 'sha256': sha(p), 'bytes': p.stat().st_size})
    for row in rows:
        src, dst = donor / row['path'], target / row['path']
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            if sha(dst) != row['sha256']:
                raise RuntimeError(f'Existing candidate differs; refusing overwrite: {dst}')
        else:
            shutil.copy2(src, dst)
    deps = target / 'node_modules'
    deps.mkdir(exist_ok=True)
    links = []
    for entry in sorted((donor / 'node_modules').iterdir()):
        if entry.name.startswith('@'):
            (deps / entry.name).mkdir(exist_ok=True)
            entries = list(entry.iterdir())
        else:
            entries = [entry]
        for package in entries:
            dest = deps / package.relative_to(donor / 'node_modules')
            if not dest.is_symlink() and not dest.exists():
                dest.symlink_to(package, target_is_directory=package.is_dir())
            if not dest.is_symlink() or dest.resolve() != package.resolve():
                raise RuntimeError(f'Unexpected dependency target: {dest}')
            pkg = package / 'package.json'
            links.append({'link': str(dest.relative_to(ROOT)), 'target': str(package.resolve()),
                'manifestSha256': sha(pkg) if pkg.is_file() else None,
                'version': json.loads(pkg.read_text()).get('version') if pkg.is_file() else None})
    assert all(sha(target / r['path']) == r['sha256'] for r in rows)
    assert all(sha(donor / r['path']) == r['sha256'] for r in rows), 'Donor changed during copy'
    manifest['sources'][name] = {'donor': str(donor), 'candidate': str(target), 'gitRevision': None,
        'revisionBasis': 'Unversioned managed installation; full SHA-256 file inventory is authoritative',
        'files': rows, 'treeSha256': hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
        'dependencies': links, 'package': json.loads((donor / 'package.json').read_text())}
# Preserve the deployed resolver semantics, changing only its relative source import.
loader = DONORS['host'].parent / 'global-runtime.mjs'
loader_dst = ROOT / 'candidates/host/global-runtime.mjs'
loader_text = loader.read_text().replace("'./host/packages/", "'./packages/")
if loader_dst.exists() and loader_dst.read_text() != loader_text:
    raise RuntimeError('Refusing to overwrite modified candidate loader')
loader_dst.write_text(loader_text)
manifest['hostLoader'] = {'donor': str(loader), 'donorSha256': sha(loader), 'candidate': str(loader_dst),
    'sha256': sha(loader_dst), 'change': 'Relative import ./host/packages -> ./packages only',
    'requiredEnvironment': {'PI_DURABLE_GLOBAL_ROOT': '/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules'}}
manifest['buildRecipe'] = {'cwd': str(ROOT / 'candidates/provider'),
    'commands': [f'python3 {ROOT}/evidence/BB0/lead-sandbox.py --cwd provider -- npm test',
        f'python3 {ROOT}/evidence/BB0/lead-sandbox.py --cwd provider -- npm run build',
        f'python3 {ROOT}/evidence/BB0/lead-sandbox.py --cwd provider -- npm run doctor'],
    'environment': {'policy': 'No ambient environment. lead-sandbox.py supplies fresh private HOME, PI_AGENT_DIR, XDG/config/cache/state/data, TMP and npm config roots on every invocation. Explicit test-BB target only.',
        'sandboxRecipe': 'evidence/BB0/lead-sandbox.py', 'BB_SERVER_URL': 'http://127.0.0.1:40886',
        'BB_DATA_DIR': str(ROOT / '.test-bb'), 'BB_HOST_DAEMON_PORT': '40887'},
    'admission': 'Recipes only. Full tests/build/doctor/baseline remain blocked until parent accepts corrected inventory.',
    'host': 'No standalone host root build script. Source runtime uses global-runtime.mjs overlay; do not run missing monorepo build scripts.'}
manifest['knownGaps'] = ['Host source coding-agent package declares 1.0.2; effective installed SDK override must be probed separately.',
    'Native BB child projection is not implemented or claimed by BB0.',
    'Dependency symlinks require verified read-only sandbox execution and the pinned donor installation to remain available and unchanged.',
    'Candidate build outputs and actual module resolution pending baseline checkpoint approval.']
(ROOT / 'candidate-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sources': {k: {'files': len(v['files']), 'sha256': v['treeSha256']} for k, v in manifest['sources'].items()},
    'manifestSha256': sha(ROOT / 'candidate-manifest.json'), 'hostLoaderSha256': sha(loader_dst)}, indent=2))
