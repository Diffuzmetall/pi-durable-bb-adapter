#!/usr/bin/env python3
"""Bind corrected inventory, isolation evidence and known compatibility failures."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
mp = ROOT / 'candidate-manifest.json'
m = json.loads(mp.read_text())
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

before = ROOT / 'evidence/BB0/lead-inputs-before.json'
after = ROOT / 'evidence/BB0/lead-inputs-after.json'
assert before.read_bytes() == after.read_bytes(), 'Donor inputs changed'
audit = json.loads(before.read_text())
for source in m['sources'].values():
    for row in source['files']:
        assert sha(Path(source['donor']) / row['path']) == row['sha256']
        assert sha(Path(source['candidate']) / row['path']) == row['sha256']
probe_text = (ROOT / 'evidence/BB0/lead-sandbox-probe.log').read_text()
receipt, offset = json.JSONDecoder().raw_decode(probe_text)
probe, offset2 = json.JSONDecoder().raw_decode(probe_text[offset:].lstrip())
assert probe['readonlyPrivateProbe'] == probe['privateWriteProbe'] == probe['donorMountsReadonly'] == 'PASS'
assert '--cap-drop' in receipt['sandboxArguments']
compatibility = json.loads((ROOT / 'evidence/BB0/lead-compatibility-results.json').read_text())
m['phase'] = 'inventory_corrected_checkpoint'
m['isolation'].update({
    'dependencyStrategy': 'Per-package dependency symlinks retained, but donor writes are kernel-denied by bubblewrap read-only mounts during every executable probe. No donor permission or mount changes outside child namespaces.',
    'sandbox': {'runner': 'evidence/BB0/lead-sandbox.py', 'version': 'bubblewrap 0.11.0',
        'rootMount': 'read-only', 'capabilities': 'all dropped', 'pidNamespace': 'private',
        'writableMounts': ['candidates/provider', 'candidates/host', '<fresh private run directory>'],
        'maskedLiveRoots': ['/home/ubuntu/.pi', '/home/ubuntu/.agents', '/home/ubuntu/.local/share/pi-pocket-eval', '/home/ubuntu/.bb-server except read-only app installation'],
        'networkDefault': 'unshare-net', 'networkOptIn': '--allow-test-bb-network shares host network, NOT a firewall. Only explicitly admitted test-BB CLI commands may use it.',
        'clearEnvironment': True, 'completeVerifiedExampleEnvironment': receipt['environment'],
        'probeLog': 'evidence/BB0/lead-sandbox-probe.log', 'probeExitCode': 0,
        'proof': 'A newly created private read-only sentinel directory rejected a write with EROFS; private run writes succeeded. /proc/self/mountinfo confirmed all donor dependency/global roots ro. No donor canary was attempted.'},
    'testBBProvenance': 'Root-created fresh isolated BB instance per scope.md and parent. Startup-generated db/auth files were not inspected, copied, deleted or restarted. Host probes use distinct freshly generated private roots.',
})
m['inputAudit'] = {'schemaVersion': 2, 'before': str(before.relative_to(ROOT)), 'after': str(after.relative_to(ROOT)),
    'sha256': sha(before), 'records': len(audit['records']), 'symlinks': sum(row['kind'] == 'symlink' for row in audit['records']),
    'beforeAfterParity': True, 'coverage': audit['coverage'],
    'supersedes': 'The earlier lead-dependency-sha256.json flat walk is historical only, not the corrected coverage claim.'}
m['compatibility'] = {'probes': compatibility,
    'disposition': 'Preserve the mixed baseline honestly. Provider import surface and native shared-server/MCP adapter imports work. Full native coding-agent entry import fails because old support source requests MCP_TYPESCRIPT_PREAMBLE absent from global pi-codemode1.2 exports. No compatibility shim or SDK migration in BB0 inventory.',
    'scope': 'Import-only. No Harness, settings, model, SQLite, host socket, terminal or BB instance construction; not behavioral baseline acceptance.',
    'blockedBoundary': 'Full native coding-agent module/CLI execution under existing source1.0.2/global1.2 overlay; requires a separately assigned compatibility migration or narrowed baseline approval.'}
m['knownGaps'] = [
    'Host support source1.0.2/globalSDK1.2 overlay is not a coherent aligned SDK1.2 host. Full coding-agent import currently fails at removed MCP_TYPESCRIPT_PREAMBLE export; see compatibility evidence.',
    'Full tests/build/doctor, private runtime behavior and perf remain unrun pending parent inventory acceptance.',
    'Native BB child projection is absent and is not claimed by BB0.',
    'Dependencies are fingerprinted read-only external inputs, not a portable vendored backup. Rebuilding requires the same dependency bytes and verified sandbox.',
    'Host-network opt-in is not a network firewall; only an explicit admitted test-BB command may enable it.',
]
m['verificationCommands'] = [
    {'command':'python3 evidence/BB0/lead-inventory.py','exitCode':0},
    {'command':'python3 evidence/BB0/lead-managed-fixes.py','exitCode':0},
    {'command':'python3 evidence/BB0/lead-audit-inputs.py before','exitCode':0},
    {'command':'python3 evidence/BB0/lead-sandbox.py --probe','exitCode':0},
    {'command':'/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node evidence/BB0/lead-resolution.mjs','exitCode':0},
    {'command':'python3 evidence/BB0/lead-run-compatibility.py','exitCode':1,'disposition':'Provider0; host1 removed export. Failure retained, not waived.'},
    {'command':'python3 evidence/BB0/lead-audit-inputs.py after','exitCode':0},
]
m['inventoryTools'] = [{'path':str(p.relative_to(ROOT)), 'sha256':sha(p)} for p in sorted((ROOT / 'evidence/BB0').glob('lead-*')) if p.suffix in {'.py','.mjs'}]
mp.write_text(json.dumps(m, indent=2) + '\n')
print(json.dumps({'manifestSha256':sha(mp), 'donorInputSha256':sha(before), 'providerFiles':len(m['sources']['provider']['files']), 'hostFiles':len(m['sources']['host']['files']), 'sourceParity':'PASS', 'readonlyEnforcement':'PASS', 'providerImports':'PASS', 'hostImports':'PARTIAL: full coding-agent FAIL, shared-server and MCP adapter PASS'}, indent=2))
