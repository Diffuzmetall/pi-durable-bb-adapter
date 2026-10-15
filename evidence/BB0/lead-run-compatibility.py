#!/usr/bin/env python3
"""Execute import-only probes from the actual candidate module-resolution base."""
import json
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[2]
NODE = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
code = (ROOT / 'evidence/BB0/lead-compatibility.mjs').read_text()
results = []
for kind in ['provider', 'host']:
    command = ['/usr/bin/python3', str(ROOT / 'evidence/BB0/lead-sandbox.py'), '--cwd', kind, '--', NODE]
    if kind == 'host':
        command += ['--import', str(ROOT / 'candidates/host/global-runtime.mjs')]
    command += ['--input-type=module', '--eval', code, kind]
    run = subprocess.run(command, text=True, capture_output=True, env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    log = ROOT / f'evidence/BB0/lead-compatibility-{kind}.log'
    log.write_text(run.stdout + run.stderr)
    line = next((line for line in run.stdout.splitlines() if line.startswith('BB0_COMPATIBILITY=')), None)
    result = json.loads(line[len('BB0_COMPATIBILITY='):]) if line else {'result':'FAIL','error':'No structured probe result'}
    results.append({'kind':kind, 'exitCode':run.returncode, 'log':str(log.relative_to(ROOT)), 'probe':result})
(ROOT / 'evidence/BB0/lead-compatibility-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
raise SystemExit(0 if all(row['exitCode'] == 0 for row in results) else 1)
