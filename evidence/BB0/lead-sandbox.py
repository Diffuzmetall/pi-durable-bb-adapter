#!/usr/bin/env python3
"""Allowlist filesystem runner for BB0 probes. No real home or host network.
Only audited source/dependencies, system runtime files and fresh private state exist.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NODE_BIN = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin'
GLOBAL = '/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules'
BASE = ROOT / 'evidence/BB0/lead-private/.cache'
CWD_ROOTS = {'provider': ROOT / 'candidates/provider', 'host': ROOT / 'candidates/host'}
parser = argparse.ArgumentParser()
parser.add_argument('--probe', action='store_true')
parser.add_argument('--boot', action='store_true')
parser.add_argument('--allow-test-bb-network', action='store_true')
parser.add_argument('--cwd', choices=list(CWD_ROOTS), default='provider')
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
if args.allow_test_bb_network:
    parser.error('Host network is forbidden for bbup-0-boot')
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if args.probe and args.boot:
    parser.error('Choose --probe or --boot')
if (args.probe or args.boot) and command:
    parser.error('Probe/boot modes have fixed commands')
if not command and not (args.probe or args.boot):
    parser.error('Pass an explicit admitted probe command after --')
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(BASE, 0o700)
state = Path(tempfile.mkdtemp(prefix='boot-' if args.boot else 'run-', dir=BASE))
protected = Path(tempfile.mkdtemp(prefix='readonly-', dir=BASE))
hidden = Path(tempfile.mkdtemp(prefix='concealed-', dir=BASE)) / 'private-sentinel'
hidden.write_text('synthetic confidentiality sentinel, not a real credential\n')
(protected / 'sentinel').write_text('private readonly fixture\n')
for subdir in ['home', 'agent', 'config', 'cache', 'data', 'state', 'tmp', 'npm-cache', 'work']:
    (state / subdir).mkdir(mode=0o700)
env = {
    'PATH': f'{NODE_BIN}:/usr/bin:/bin', 'HOME': '/bb0-state/home', 'PI_AGENT_DIR': '/bb0-state/agent', 'PI_CODING_AGENT_DIR': '/bb0-state/agent',
    'XDG_CONFIG_HOME': '/bb0-state/config', 'XDG_CACHE_HOME': '/bb0-state/cache',
    'XDG_DATA_HOME': '/bb0-state/data', 'XDG_STATE_HOME': '/bb0-state/state',
    'TMPDIR': '/bb0-state/tmp', 'TMP': '/bb0-state/tmp', 'TEMP': '/bb0-state/tmp',
    'npm_config_cache': '/bb0-state/npm-cache', 'npm_config_userconfig': '/bb0-state/home/.npmrc',
    'npm_config_globalconfig': '/bb0-state/home/global.npmrc',
    'npm_config_update_notifier': 'false', 'npm_config_audit': 'false', 'npm_config_fund': 'false',
    'USER': 'ubuntu', 'LOGNAME': 'ubuntu', 'SHELL': '/bin/sh', 'LANG': 'C.UTF-8', 'TZ': 'UTC',
    'CI': '1', 'NO_COLOR': '1', 'TERM': 'xterm-256color',
    'PI_DURABLE_GLOBAL_ROOT': GLOBAL, 'HINDSIGHT_DISABLED': '1', 'HINDSIGHT_DISABLE_HOOKS': '1',
    'BB0_HIDDEN_SENTINEL': str(hidden), 'BB0_HOST_NET_NS': os.readlink('/proc/self/ns/net'),
}
if args.boot:
    settings = {'defaultProvider':'bb0-offline', 'defaultModel':'boot-only', 'packages':[], 'extensions':[]}
    models = {'providers': {'bb0-offline': {'api':'openai-completions', 'baseUrl':'http://127.0.0.1:9/never-call',
        'apiKey':'synthetic-offline-not-a-secret', 'models':[{'id':'boot-only','name':'BB0 offline boot only',
        'reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},
        'contextWindow':8192,'maxTokens':128}]}}}
    for name, value in [('settings.json',settings),('models.json',models)]:
        (state / 'agent' / name).write_text(json.dumps(value) + '\n')
# No root bind: real home/state/credential trees are absent, not merely read-only.
bwrap = ['/usr/bin/bwrap','--die-with-parent','--new-session','--unshare-pid','--unshare-net',
    '--cap-drop','ALL','--proc','/proc','--dev','/dev','--tmpfs','/tmp']
readable = ['/usr/bin','/usr/lib','/usr/lib64','/usr/share/terminfo','/usr/share/zoneinfo',
    '/etc/ld.so.cache','/etc/passwd','/etc/group','/etc/nsswitch.conf', NODE_BIN,
    GLOBAL + '/@earendil-works', str(ROOT / 'candidates/provider'), str(ROOT / 'candidates/host'),
    '/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules',
    '/home/ubuntu/.local/share/pi-durable/host/node_modules']
for path in readable:
    if Path(path).exists():
        bwrap += ['--ro-bind',path,path]
for name in ['bin','sbin','lib','lib64']:
    if Path('/' + name).is_symlink():
        bwrap += ['--symlink',os.readlink('/' + name),'/' + name]
bwrap += ['--bind',str(state),'/bb0-state','--ro-bind',str(protected),'/bb0-readonly']
if args.boot:
    bwrap += ['--ro-bind',str(ROOT / 'evidence/BB0/lead-boot.py'),'/bb0-boot.py']
    command = ['/usr/bin/python3','/bb0-boot.py']
if args.probe:
    code = r'''
import errno,json,os,pathlib,socket,subprocess
assert os.environ['PI_AGENT_DIR'] == os.environ['PI_CODING_AGENT_DIR'] == '/bb0-state/agent'
config_check = """
import * as host from '/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/host/packages/coding-agent/src/config.ts';
import * as sdk from '/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/provider/node_modules/@earendil-works/pi-coding-agent/dist/config.js';
import { getAgentDir as providerDir } from '/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/provider/src/runner/session-storage.ts';
import assert from 'node:assert/strict';
for (const cfg of [host,sdk]) {
 assert.equal(cfg.getAgentDir(), '/bb0-state/agent');
 assert.equal(cfg.getModelsPath(), '/bb0-state/agent/models.json');
 assert.equal(cfg.getSettingsPath(), '/bb0-state/agent/settings.json');
 assert.equal(cfg.getAuthPath(), '/bb0-state/agent/auth.json');
}
assert.equal(providerDir(), '/bb0-state/agent');
console.log('PASS effective host/provider-SDK/provider-storage configuration roots');
"""
subprocess.run(['/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node','--input-type=module','--eval',config_check],check=True)
assert os.readlink('/proc/self/ns/net') != os.environ['BB0_HOST_NET_NS'], 'Host network namespace exposed'
interfaces=[line.split(':')[0].strip() for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]]
assert interfaces == ['lo'], interfaces
hidden=pathlib.Path(os.environ['BB0_HIDDEN_SENTINEL'])
assert not hidden.exists(), 'Private sentinel outside allowlist became visible'
try: hidden.read_bytes()
except FileNotFoundError: pass
else: raise AssertionError('Hidden sentinel readable')
for path in ['/home/ubuntu/.ssh','/home/ubuntu/.pi','/home/ubuntu/.aws','/home/ubuntu/.local/share/pi-pocket-eval','/home/ubuntu/.bb-server','/run/user']:
    assert not pathlib.Path(path).exists(), path
try: pathlib.Path('/bb0-readonly/must-not-exist').write_text('blocked')
except OSError as e: assert e.errno==errno.EROFS,repr(e)
else: raise AssertionError('Readonly fixture accepted write')
pathlib.Path('/bb0-state/write-ok').write_text('private writes work')
assert pathlib.Path('/bb0-readonly/sentinel').read_text()=='private readonly fixture\n'
mounts=[line.split() for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines()]
for path in [os.environ['PI_DURABLE_GLOBAL_ROOT']+'/@earendil-works','/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules','/home/ubuntu/.local/share/pi-durable/host/node_modules']:
    row=max((r for r in mounts if path==r[4] or path.startswith(r[4].rstrip('/')+'/')),key=lambda r:len(r[4]))
    assert 'ro' in row[5].split(','),(path,row[5])
print(json.dumps({'confidentiality':'PASS','readonly':'PASS','privateWrites':'PASS','donorMountsReadonly':'PASS','isolatedNetwork':'PASS','environment':dict(os.environ)},indent=2))
'''
    command = ['/usr/bin/python3','-c',code]
cwd = '/bb0-state/work' if args.boot else str(CWD_ROOTS[args.cwd])
bwrap += ['--remount-ro','/','--clearenv']
for key,value in env.items():
    bwrap += ['--setenv',key,value]
bwrap += ['--chdir',cwd]
receipt = {'sandbox':'bubblewrap allowlist','stateDirectory':str(state),'network':'private namespace, no host opt-in',
    'readableRoots':readable,'environment':env,'command':command,'cwd':cwd,'sandboxArguments':bwrap}
print(json.dumps(receipt,indent=2),flush=True)
run = subprocess.run(bwrap+command,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
print(json.dumps({'exitCode':run.returncode,'stateDirectory':str(state)}),flush=True)
raise SystemExit(run.returncode)
