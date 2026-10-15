#!/usr/bin/env python3
"""Run an explicit command with private config and read-only donor mounts.
No inherited environment enters the sandbox. Full baseline requires parent admission.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NODE_BIN = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin'
BB_APP = '/home/ubuntu/.bb-server/app'
BASE = ROOT / 'evidence/BB0/lead-private/.cache'

parser = argparse.ArgumentParser()
parser.add_argument('--probe', action='store_true')
parser.add_argument('--allow-test-bb-network', action='store_true', help='Uses host network, NOT a loopback-only firewall. Explicit BB target remains mandatory.')
CWD_ROOTS = {
    'provider': ROOT / 'candidates/provider', 'host': ROOT / 'candidates/host',
    'managed-provider': Path('/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29'),
    'managed-host': Path('/home/ubuntu/.local/share/pi-durable/host'),
}
parser.add_argument('--cwd', choices=list(CWD_ROOTS), default='provider')
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command and not args.probe:
    parser.error('Pass an explicit command after --')
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(BASE, 0o700)
state = Path(tempfile.mkdtemp(prefix='run-', dir=BASE))
protected = Path(tempfile.mkdtemp(prefix='readonly-', dir=BASE))
(protected / 'sentinel').write_text('private inventory probe, never a donor file\n')
for subdir in ['home', 'agent', 'config', 'cache', 'data', 'state', 'tmp', 'npm-cache']:
    (state / subdir).mkdir(mode=0o700)
env = {
    'PATH': f'{NODE_BIN}:{BB_APP}/node_modules/.bin:/usr/bin:/bin',
    'HOME': str(state / 'home'), 'PI_AGENT_DIR': str(state / 'agent'),
    'XDG_CONFIG_HOME': str(state / 'config'), 'XDG_CACHE_HOME': str(state / 'cache'),
    'XDG_DATA_HOME': str(state / 'data'), 'XDG_STATE_HOME': str(state / 'state'),
    'TMPDIR': str(state / 'tmp'), 'TMP': str(state / 'tmp'), 'TEMP': str(state / 'tmp'),
    'npm_config_cache': str(state / 'npm-cache'), 'npm_config_userconfig': str(state / 'home/.npmrc'),
    'npm_config_globalconfig': str(state / 'home/global.npmrc'),
    'npm_config_update_notifier': 'false', 'npm_config_audit': 'false', 'npm_config_fund': 'false',
    'USER': 'ubuntu', 'LOGNAME': 'ubuntu', 'SHELL': '/bin/sh', 'LANG': 'C.UTF-8', 'TZ': 'UTC',
    'CI': '1', 'NO_COLOR': '1',
    'BB_SERVER_URL': 'http://127.0.0.1:40886', 'BB_DATA_DIR': str(ROOT / '.test-bb'),
    'BB_HOST_DAEMON_PORT': '40887',
    'PI_DURABLE_GLOBAL_ROOT': '/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules',
}
# Dedicated mounts override the read-only root only for candidate output and fresh state.
bwrap = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--cap-drop', 'ALL',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--tmpfs', '/home/ubuntu/.pi', '--tmpfs', '/home/ubuntu/.agents',
    '--tmpfs', '/home/ubuntu/.local/share/pi-pocket-eval',
    '--tmpfs', '/home/ubuntu/.bb-server', '--ro-bind', BB_APP, BB_APP,
    '--bind', str(state), str(state),
    '--bind', str(ROOT / 'candidates/provider'), str(ROOT / 'candidates/provider'),
    '--bind', str(ROOT / 'candidates/host'), str(ROOT / 'candidates/host'),
    '--clearenv']
if not args.allow_test_bb_network:
    bwrap.append('--unshare-net')
for key, value in env.items():
    bwrap.extend(['--setenv', key, value])
bwrap.extend(['--chdir', str(CWD_ROOTS[args.cwd])])
if args.probe:
    code = r'''
import errno,json,os,pathlib
protected=pathlib.Path(__import__('sys').argv[1]); state=pathlib.Path(os.environ['HOME']).parent
try:
    (protected/'must-not-exist').write_text('blocked')
except OSError as error:
    assert error.errno == errno.EROFS, repr(error)
else:
    raise AssertionError('Read-only root accepted a write')
(state/'write-ok').write_text('private writes work')
assert (protected/'sentinel').read_text().startswith('private inventory probe')
assert not (protected/'must-not-exist').exists()
assert not pathlib.Path('/home/ubuntu/.pi/agent/settings.json').exists()
mounts=[]
for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
    fields=line.split(); mounts.append({'path':fields[4], 'options':fields[5]})
def mount_for(path):
    return max((m for m in mounts if path==m['path'] or path.startswith(m['path'].rstrip('/')+'/')),key=lambda m:len(m['path']))
for donor in ['/home/ubuntu/.local/share/pi-durable/bb-provider-shared-0.2.29/node_modules','/home/ubuntu/.local/share/pi-durable/host/node_modules','/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules']:
    m=mount_for(donor); assert 'ro' in m['options'].split(','), (donor,m)
print(json.dumps({'readonlyPrivateProbe':'PASS','privateWriteProbe':'PASS','donorMountsReadonly':'PASS','livePiConfigMasked':True,'environment':dict(os.environ)},indent=2))
'''
    command = ['/usr/bin/python3', '-c', code, str(protected)]
receipt = {'sandbox': 'bubblewrap', 'stateDirectory': str(state), 'privateReadonlyProbeDirectory': str(protected),
    'network': 'host network, explicit test BB only by command contract' if args.allow_test_bb_network else 'isolated network namespace',
    'environment': env, 'command': command, 'cwd': str(CWD_ROOTS[args.cwd]),
    'sandboxArguments': bwrap}
print(json.dumps(receipt, indent=2), flush=True)
run = subprocess.run(bwrap + command, env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
print(json.dumps({'exitCode': run.returncode, 'stateDirectory': str(state)}), flush=True)
raise SystemExit(run.returncode)
