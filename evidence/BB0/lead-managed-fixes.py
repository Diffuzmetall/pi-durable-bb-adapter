"""Record managed source deltas against retained pre-shared provider source only."""
import difflib
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
manifest_path = root / 'candidate-manifest.json'
m = json.loads(manifest_path.read_text())
old = Path('/home/ubuntu/.local/share/pi-durable/backups/provider-pi-durable-20261015-shared/plugin')
new = Path(m['sources']['provider']['donor'])
changes = []
diff = []
for row in m['sources']['provider']['files']:
    path = row['path']
    if not (path.startswith(('src/', 'scripts/', 'tests/')) or path == 'package.json'):
        continue
    before, after = old / path, new / path
    if not before.exists() or before.read_bytes() != after.read_bytes():
        changes.append({'path': path, 'beforeSha256': hashlib.sha256(before.read_bytes()).hexdigest() if before.exists() else None, 'afterSha256': row['sha256']})
        diff.extend(difflib.unified_diff(before.read_text().splitlines(True) if before.exists() else [], after.read_text().splitlines(True), fromfile=f'pre-shared/{path}', tofile=f'managed/{path}'))
(root / 'evidence/BB0/lead-managed-fixes.patch').write_text(''.join(diff))
m['managedFixes'] = {'comparisonRoot': str(old), 'comparisonCaveat': 'Retained managed pre-shared backup, not an upstream Git revision. Only source/scripts/tests/package compared; backup configuration not read.', 'changedFiles': changes, 'patch': 'evidence/BB0/lead-managed-fixes.patch', 'patchSha256': hashlib.sha256(''.join(diff).encode()).hexdigest(), 'preservation': 'All current managed source copied byte-for-byte, including fixes not distinguishable from upstream without a published pristine revision.'}
for item in m['sources'].values():
    outputs = []
    for p in sorted((Path(item['donor']) / 'dist').rglob('*')):
        if p.is_file():
            outputs.append({'path': str(p.relative_to(item['donor'])), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
    item['managedOutputs'] = outputs
manifest_path.write_text(json.dumps(m, indent=2) + '\n')
print(json.dumps({'changedFiles': changes, 'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest()}, indent=2))
