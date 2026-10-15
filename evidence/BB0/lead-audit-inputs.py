#!/usr/bin/env python3
"""Fingerprint donor source files and the full reachable dependency graph.
Directory and file symlinks are recorded with targets; cycles are visited once.
Never reads live configuration or stores. Only declared source/dependency roots.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
manifest = json.loads((ROOT / 'candidate-manifest.json').read_text())
phase = sys.argv[1] if len(sys.argv) == 2 else ''
if phase not in {'before', 'after'}:
    raise SystemExit('Usage: lead-audit-inputs.py before|after')
roots = sorted({str(Path(s['donor']) / 'node_modules') for s in manifest['sources'].values()} |
    {manifest['hostLoader']['requiredEnvironment']['PI_DURABLE_GLOBAL_ROOT'] + '/@earendil-works'})
allowed = [Path(p).resolve() for p in roots]
records = []
visited = set()

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def visit(p):
    real = p.resolve(strict=True)
    if not any(real == a or a in real.parents for a in allowed):
        raise RuntimeError(f'Dependency link escapes declared roots: {p} -> {real}')
    if p.is_symlink():
        records.append({'kind': 'symlink', 'path': str(p), 'target': str(p.readlink()),
            'resolved': str(real), 'targetKind': 'directory' if real.is_dir() else 'file'})
    if real in visited:
        return
    visited.add(real)
    if real.is_dir():
        for child in sorted(real.iterdir()):
            visit(child)
    elif real.is_file():
        records.append({'kind': 'file', 'path': str(real), 'sha256': digest(real), 'bytes': real.stat().st_size})
    else:
        raise RuntimeError(f'Unsupported dependency input: {real}')

for directory in roots:
    visit(Path(directory))
for source in manifest['sources'].values():
    for row in source['files']:
        p = Path(source['donor']) / row['path']
        records.append({'kind': 'source', 'path': str(p), 'sha256': digest(p), 'bytes': p.stat().st_size})
loader = Path(manifest['hostLoader']['donor'])
records.append({'kind': 'source', 'path': str(loader), 'sha256': digest(loader), 'bytes': loader.stat().st_size})
records.sort(key=lambda row: (row['path'], row['kind']))
result = {'schemaVersion': 2, 'roots': roots, 'coverage': 'All files and symlinks transitively reachable from declared dependency roots plus exact donor source/loader inputs. Symlink targets outside declared roots fail closed.', 'records': records}
path = ROOT / f'evidence/BB0/lead-inputs-{phase}.json'
path.write_text(json.dumps(result, indent=2) + '\n')
receipt = {'phase': phase, 'records': len(records), 'symlinks': sum(r['kind'] == 'symlink' for r in records), 'sha256': digest(path)}
if phase == 'after':
    before = ROOT / 'evidence/BB0/lead-inputs-before.json'
    receipt['beforeAfterParity'] = before.read_bytes() == path.read_bytes()
    if not receipt['beforeAfterParity']:
        print(json.dumps(receipt)); raise SystemExit('Donor inputs changed during probes')
print(json.dumps(receipt, indent=2))
