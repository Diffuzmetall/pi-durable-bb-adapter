#!/usr/bin/env python3
"""Real provider scripts and archived regressions in a fresh private source copy."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import xml.etree.ElementTree as ET

ROOT=Path('/home/ubuntu/Projects/pi-durable-bb-adapter')
STATE=Path('/bb0-state')
SOURCE=ROOT/'candidates/provider'
WORK=STATE/'provider'
NODE='/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
NPM='/home/ubuntu/.nvm/versions/node/v24.19.0/bin/npm'
report={'phase':'unit_build_doctor_prebuilt','commands':[],'candidateSourceMutated':False,
    'network':'private namespace; code/dependencies readonly; all outputs in fresh private source copy'}
assert os.environ['PI_AGENT_DIR']==os.environ['PI_CODING_AGENT_DIR']=='/bb0-state/agent'
assert os.readlink('/proc/self/ns/net')!=os.environ['BB0_HOST_NET_NS']
shutil.copytree(SOURCE,WORK,symlinks=True)
manifest=json.loads(Path('/bb0-candidate-manifest.json').read_text())
for row in manifest['sources']['provider']['files']:
    assert hashlib.sha256((WORK/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
report['verifiedProviderSourceFiles']=len(manifest['sources']['provider']['files'])
archive=WORK/'archived-upgrade'
archive.mkdir()
report['archiveTransforms']=[]
for original in sorted(Path('/bb0-archive').iterdir()):
    raw=original.read_bytes()
    transformed=raw.replace(b'/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29',str(WORK).encode())
    (archive/original.name).write_bytes(transformed)
    report['archiveTransforms'].append({'name':original.name,'originSha256':hashlib.sha256(raw).hexdigest(),
        'executedSha256':hashlib.sha256(transformed).hexdigest(),
        'change':'Only donor provider absolute import prefix rebased to verified private candidate source copy; assertions unchanged'})

def run(name,command,timeout=240,extra_env=None):
    started=time.monotonic()
    env=dict(os.environ)
    env.update(extra_env or {})
    log=STATE/(name+'.log')
    with log.open('wb') as out:
        child=subprocess.Popen(command,cwd=WORK,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
        timed_out=False
        try:
            code=child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out=True
            os.killpg(child.pid,signal.SIGTERM)
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid,signal.SIGKILL)
                child.wait(timeout=5)
            code=124
    record={'name':name,'command':command,'cwd':str(WORK),'environmentOverrides':extra_env or {},'exitCode':code,
        'timeout':timed_out,'elapsedSeconds':round(time.monotonic()-started,3),'log':str(log),
        'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()}
    report['commands'].append(record)
    (STATE/'baseline-unit-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(record),flush=True)
    return record

cache=Path(os.environ['BB_DATA_DIR'])/'plugins/toolchain-0.28.1-4.3.0-4.3.0-4.3.0'
expected={'esbuild':'0.28.1','@tailwindcss/node':'4.3.0','@tailwindcss/oxide':'4.3.0','tailwindcss':'4.3.0'}
try:
    marker=json.loads((cache/'.bb-toolchain.json').read_text())
    assert marker['pins']==','.join(sorted(k+'@'+v for k,v in expected.items()))
    actual={name:json.loads((cache/'node_modules'/name/'package.json').read_text())['version'] for name in expected}
    assert actual==expected, actual
    report['offlineToolchainContract']={'status':'PASS','actualVersions':actual,'markerPins':marker['pins'],
        'source':'Exact audited existing code cache mounted readonly under fresh private BB build-data root; no downloads'}
    built=run('provider-npm-build',[NPM,'run','build'],120)
    report['fullBuildGate']={'status':'PASS' if built['exitCode']==0 else 'FAIL','exitCode':built['exitCode']}
except (OSError,ValueError,KeyError,AssertionError) as error:
    report['fullBuildGate']={'status':'BLOCKED','reason':'Exact offline cache contract failed: '+str(error)}
    run('provider-npm-build-runner',[NPM,'run','build:runner'],120)
run('provider-npm-test',[NPM,'test'],300)
run('provider-npm-doctor',[NPM,'run','doctor'],60)
run('archived-regressions',[NODE,'--test',str(archive/'upgrade-background-contract.test.mjs'),
    str(archive/'upgrade-sdk-resources.test.mjs')],90)
run('shared-host-integration',[NODE,'--test','tests/shared-host.test.ts'],90,{
    'PI_DURABLE_SHARED_HOST_MODULE':str(ROOT/'candidates/host/packages/coding-agent/src/experimental/durable/shared-server.ts'),
    'PI_DURABLE_SHARED_HOST_LOADER':str(ROOT/'candidates/host/global-runtime.mjs'),
    'PI_DURABLE_RUNNER_PATH':str(WORK/'dist/runner/index.js')})
report['outputs']=[]
for path in sorted(WORK.rglob('*')):
    if path.is_file() and not path.is_symlink() and any(part in ['dist','.bb'] for part in path.relative_to(WORK).parts):
        report['outputs'].append({'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size})
blocked_build=report['fullBuildGate']['status']=='BLOCKED'
suite=ET.Element('testsuite',name='BB0-real-command-gates',tests=str(len(report['commands'])+int(blocked_build)),skipped=str(int(blocked_build)),
    failures=str(sum(c['exitCode']!=0 for c in report['commands'])))
if blocked_build:
    blocked=ET.SubElement(suite,'testcase',name='provider-full-build-required')
    ET.SubElement(blocked,'skipped',message=report['fullBuildGate']['reason'])
for record in report['commands']:
    case=ET.SubElement(suite,'testcase',name=record['name'],time=str(record['elapsedSeconds']))
    raw=Path(record['log']).read_text(errors='replace')
    if record['exitCode']!=0:
        ET.SubElement(case,'failure',message='Real command exit '+str(record['exitCode'])).text=raw
    ET.SubElement(case,'system-out').text=raw
ET.indent(suite)
ET.ElementTree(suite).write(STATE/'baseline-tests.xml',encoding='utf-8',xml_declaration=True)
report['junitSemantics']='One testcase per real command gate; full original test output retained, not a fabricated per-assertion count'
report['status']=('PASS' if report['fullBuildGate']['status']=='PASS' else 'PARTIAL_full_build_blocked') if all(c['exitCode']==0 for c in report['commands']) else 'FAIL'
(STATE/'baseline-unit-result.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2),flush=True)
raise SystemExit(0 if report['status']=='PASS' else 1)
