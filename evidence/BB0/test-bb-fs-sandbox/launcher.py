#!/usr/bin/env python3
"""BB filesystem sandbox v1. Planning is default; execution requires separate parent GO."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
PROJECT = Path('/home/ubuntu/Projects/pi-durable-bb-adapter')
APP = Path('/home/ubuntu/.bb-server/app/node_modules')
NODE = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
PINS_SHA256 = '7ef4254c10b4d941d69b453a656f2ec0980a4b706f3c463d2d8b58f8f2ecc826'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def no_symlink_ancestors(path):
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise ValueError(f'symlink in owned path: {part}')


def load_pins():
    raw = (HERE / 'public-pins.json').read_bytes()
    if sha(raw) != PINS_SHA256:
        raise ValueError('public pins changed: new source/allowlist review required')
    return json.loads(raw)


def plan(fixture_id):
    if not isinstance(fixture_id, str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,31}', fixture_id):
        raise ValueError('invalid fixture ID')
    root = PROJECT / '.test-bb' / ('fs-private.' + fixture_id)
    no_symlink_ancestors(root)
    if os.path.lexists(root):
        raise ValueError('fresh owned root already exists; no reuse or old-state reads')
    pins = load_pins()
    no_symlink_ancestors(APP)
    if not APP.is_dir():
        raise ValueError('missing public app dependency root')
    for item in pins['fileMounts']:
        source = Path(item['source'])
        if not source.is_file() or source.resolve(strict=True) != source:
            raise ValueError(f'missing or symlinked public mount: {source}')
        if str(Path(item['destination']).resolve(strict=True)) != item['source']:
            raise ValueError(f'public alias drift: {item["destination"]}')
    mounts = [{'source':str(APP), 'destination':str(APP), 'mode':'ro',
               'inventorySha256':PINS_SHA256}]
    mounts += [dict(item, mode='ro') for item in pins['fileMounts']]
    mounts.append({'source':str(root), 'destination':str(root), 'mode':'rw', 'requiresFreshProvisioning':True})
    data = str(root / 'bb-data')
    env = {
        'PATH':str(Path(NODE).parent) + ':/usr/bin:/bin', 'HOME':str(root / 'home'),
        'PI_AGENT_DIR':str(root / 'agent'), 'PI_CODING_AGENT_DIR':str(root / 'agent'),
        'TMPDIR':str(root / 'tmp'), 'TMP':str(root / 'tmp'), 'TEMP':str(root / 'tmp'),
        'XDG_CONFIG_HOME':str(root / 'config'), 'XDG_CACHE_HOME':str(root / 'cache'),
        'XDG_DATA_HOME':str(root / 'data'), 'XDG_STATE_HOME':str(root / 'state'),
        'XDG_RUNTIME_DIR':str(root / 'run'), 'USER':'ubuntu', 'LOGNAME':'ubuntu',
        'SHELL':'/bin/sh', 'LANG':'C.UTF-8', 'TZ':'UTC', 'TERM':'xterm-256color',
        'BB_DATA_DIR':data, 'BB_SERVER_URL':'http://127.0.0.1:40886',
        'BB_SERVER_BIND_HOST':'127.0.0.1', 'BB_SERVER_PORT':'40886', 'BB_HOST_DAEMON_PORT':'40887',
        'BB_TELEMETRY':'false', 'BB_HOST_DAEMON_AUTO_UPDATE':'0',
        'BB_MARKETPLACE_URL':'http://127.0.0.1:9/disabled',
    }
    argv = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-user',
            '--disable-userns', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
            '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
    for m in mounts:
        argv += ['--ro-bind' if m['mode'] == 'ro' else '--bind', m['source'], m['destination']]
    argv += ['--remount-ro', '/', '--clearenv']
    for name, value in sorted(env.items()):
        argv += ['--setenv', name, value]
    argv += ['--chdir', str(root / 'home'), '--', NODE, str(APP / 'bb-app/dist/bb-app.js'),
             'start', '--data-dir', data, '--server-bind-host', '127.0.0.1', '--server-port', '40886',
             '--host-daemon-port', '40887', '--no-in-app-updates', '--bundled']
    transport = {'C':str(PROJECT / '.test-bb' / ('fs-owner.' + fixture_id) / 'session'),
                 'socketDir':str(root / 's'), 'socketPath':str(root / 's/d.sock'),
                 'ownerDatabaseMounted':False, 'active':False}
    if len(transport['socketPath'].encode()) > 107:
        raise ValueError('Unix socket pathname too long')
    return {'schemaVersion':1, 'fixtureVersion':'1.0.0-source-only', 'fixtureId':fixture_id,
            'root':str(root), 'dataDir':data, 'ports':{'server':40886,'daemon':40887},
            'network':'host-shared-NOT-network-isolation', 'runtimeCapability':'UNAVAILABLE',
            'dependencyClosure':pins['closure'], 'publicPinsSha256':PINS_SHA256,
            'launcherSha256':sha(Path(__file__).read_bytes()),
            'mounts':mounts, 'innerEnvironment':env, 'argv':argv,
            'spawn':{'env':{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}, 'close_fds':True,
                     'pass_fds':[], 'stdin':'DEVNULL', 'stdout':'NEW_OWNED_LOG',
                     'stderr':'STDOUT', 'cwd':str(root / 'home'), 'umask':'0077'},
            'privateDirectories':['bb-data','home','agent','tmp','config','cache','data','state','run','s'],
            'futureTransport':transport,
            'requiredBeforeRuntime':['Stage1 accepted','exact source/allowlist independent review',
                'separate parent runtime GO','serialized CPU reservation',
                'owned old-instance retirement GO and fixed ports free',
                'fresh root exclusive ownership/provisioning',
                'public pins reverified; runtime dependency/capability preflight']}


def validate(value):
    if not isinstance(value, dict) or 'fixtureId' not in value:
        raise ValueError('plan must be an object with fixtureId')
    expected = plan(value['fixtureId'])
    if json.dumps(value, sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise ValueError('plan differs from exact allowlist; overrides/extra fields refused')
    return {'planValidation':'PASS', 'runtimeCapability':'UNAVAILABLE', 'publicPinsSha256':PINS_SHA256}


def verify_public():
    # Only fixed public dependencies are read; never BB state or candidate/private donors.
    pins = load_pins()
    no_symlink_ancestors(APP)
    actual_names = sorted(str(p.relative_to(APP)) for p in APP.rglob('*') if not p.is_dir() or p.is_symlink())
    if actual_names != sorted(e['path'] for e in pins['appEntries']):
        raise ValueError('public dependency inventory changed')
    for e in pins['appEntries']:
        p = APP / e['path']
        if 'link' in e:
            if not p.is_symlink() or p.readlink().as_posix() != e['link'] or str(p.resolve(strict=True)) != e['resolved']:
                raise ValueError(f'public link drift: {p}')
        elif p.is_symlink() or p.resolve(strict=True) != p or sha(p.read_bytes()) != e['sha256'] or p.stat().st_mode & 0o777 != e['mode']:
            raise ValueError(f'public dependency drift: {p}')
    for e in pins['fileMounts']:
        p = Path(e['source'])
        if p.resolve(strict=True) != p or sha(p.read_bytes()) != e['sha256']:
            raise ValueError(f'public mount drift: {p}')
        if str(Path(e['destination']).resolve(strict=True)) != e['source']:
            raise ValueError(f'public alias drift: {e["destination"]}')
    b = pins['outerBwrap']
    if str(Path(b['path']).resolve(strict=True)) != b['resolved'] or sha(Path(b['path']).read_bytes()) != b['sha256']:
        raise ValueError('outer bubblewrap drift')
    return {'publicPins':'PASS', 'runtimeCapability':'UNAVAILABLE', 'publicPinsSha256':PINS_SHA256}


def launch(args):
    if not (args.runtime_go and args.stage1_accepted and args.old_owned_instance_retired):
        raise ValueError('runtime GO unavailable: require separate parent GO, Stage1 acceptance and owned-instance retirement')
    proposed = plan(args.fixture_id)
    encoded = json.dumps(proposed, sort_keys=True, indent=2) + '\n'
    if args.reviewed_plan_sha256 != sha(encoded.encode()):
        raise ValueError('reviewed plan SHA256 missing or mismatched')
    verify_public()
    # These acknowledgements are NOT an authorization mechanism. The parent alone grants GO.
    # Socket and process operations are reachable only beyond all refusal gates above.
    import socket
    import subprocess
    guards = []
    try:
        for port in (40886, 40887):
            guard = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            guards.append(guard)
            guard.bind(('127.0.0.1', port))
    finally:
        for guard in guards:
            guard.close()
    root = Path(proposed['root'])
    os.umask(0o077)
    root.mkdir(mode=0o700)  # Exclusive: existing profiles are never reused or inspected.
    for name in proposed['privateDirectories']:
        (root / name).mkdir(mode=0o700)
    (root / 'launch-plan.json').write_text(encoded)
    with (root / 'launcher.log').open('x') as log:
        result = subprocess.run(proposed['argv'], env=proposed['spawn']['env'],
                                cwd=root / 'home', stdin=subprocess.DEVNULL,
                                stdout=log, stderr=subprocess.STDOUT,
                                close_fds=True, pass_fds=())
    return {'exitCode':result.returncode, 'root':str(root), 'runtimeCapability':'UNAVAILABLE',
            'note':'process exit is not capability/ENV/PTY/visual acceptance; root retained'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan','validate','verify-public','launch'])
    parser.add_argument('--fixture-id', default='source-v1')
    parser.add_argument('--runtime-go', action='store_true')
    parser.add_argument('--stage1-accepted', action='store_true')
    parser.add_argument('--old-owned-instance-retired', action='store_true')
    parser.add_argument('--reviewed-plan-sha256')
    args = parser.parse_args()
    try:
        if args.action == 'launch':
            result = launch(args)
        elif args.runtime_go or args.stage1_accepted or args.old_owned_instance_retired or args.reviewed_plan_sha256:
            raise ValueError('runtime acknowledgement flags are only valid for launch')
        elif args.action == 'plan':
            result = plan(args.fixture_id)
        elif args.action == 'validate':
            result = validate(json.load(sys.stdin))
        else:
            result = verify_public()
        print(json.dumps(result, sort_keys=True, indent=2))
        return result.get('exitCode', 0)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
