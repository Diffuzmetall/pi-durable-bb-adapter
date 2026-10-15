#!/usr/bin/env python3
"""Audit additional readonly npm/BB build-tool code and four exact archived fixtures."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = Path('/home/ubuntu/.bb-server/thread-storage/thr_m5gua3gqyg')
TOOLS = [Path('/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules/npm'),
    Path('/home/ubuntu/.bb-server/app/node_modules'),
    Path('/home/ubuntu/.bb/plugins/toolchain-0.28.1-4.3.0-4.3.0-4.3.0')]
FIXTURES = ['upgrade-background-contract.test.mjs','upgrade-sdk-resources.test.mjs',
    'upgrade-upstream-bg-original.ts','upgrade-upstream-bg-canonical.ts']
phase = sys.argv[1] if len(sys.argv)==2 else ''
assert phase in ['before','after'], 'Pass before or after'
records, seen = [], set()

def visit(path):
    real = path.resolve(strict=True)
    assert any(real==root or root in real.parents for root in TOOLS), f'Escaping build-tool link: {path} -> {real}'
    if path.is_symlink():
        records.append({'kind':'symlink','path':str(path),'target':str(path.readlink()),'resolved':str(real)})
    if real in seen:
        return
    seen.add(real)
    if real.is_dir():
        for child in sorted(real.iterdir()):
            visit(child)
    else:
        assert real.is_file(), real
        records.append({'kind':'file','path':str(real),'sha256':hashlib.sha256(real.read_bytes()).hexdigest(),'bytes':real.stat().st_size})

for root in TOOLS:
    visit(root)
for name in FIXTURES:
    path=ARCHIVE/name
    assert path.is_file() and not path.is_symlink()
    records.append({'kind':'archive-source','path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
records.sort(key=lambda row:(row['path'],row['kind']))
output=ROOT/f'evidence/BB0/lead-baseline-inputs-{phase}.json'
output.write_text(json.dumps({'toolRoots':list(map(str,TOOLS)),'records':records},indent=2)+'\n')
receipt={'phase':phase,'records':len(records),'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
if phase=='after':
    receipt['beforeAfterParity']=(ROOT/'evidence/BB0/lead-baseline-inputs-before.json').read_bytes()==output.read_bytes()
    assert receipt['beforeAfterParity'], 'Additional build-tool/archive inputs changed'
print(json.dumps(receipt,indent=2))
