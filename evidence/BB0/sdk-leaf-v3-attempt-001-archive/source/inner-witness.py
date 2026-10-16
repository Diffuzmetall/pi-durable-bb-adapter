# QA-only pre-exec witness. Not run during source/prep. Future controller passes these
# exact bytes as Python -c inside the existing four-RO command port.
import hashlib
import json
import os
import re
import stat

NODE = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
PROBE = '/home/ubuntu/Projects/pi-durable-bb-adapter/evidence/BB0/sdk-definition-leaf-probe/probe.mjs'
MANIFEST = '/home/ubuntu/Projects/pi-durable-bb-adapter/evidence/BB0/sdk-definition-leaf-probe/pin-manifest.json'
SDK = '/home/ubuntu/.bb-server/app/node_modules/bb-app/server/dist/plugin-sdk-runtime.js'
APP_META = '/home/ubuntu/.bb-server/app/node_modules/bb-app/package.json'
PINS = {
    PROBE: '5b094bd7eb12c565448f9be7eb5c093774c3380cd1391c2a5e224a6bb16624c4',
    MANIFEST: '1554ecd608c540d2e31330fb5c24c25a5278e9d4a983b05ac40736bcade76c58',
    SDK: '62c27b9bbb127417f2c3e13494289fd36f999c09614c120826785955935d4126',
    APP_META: '5bd18210c67fe46ddc6ee99ec05092504825c375cae2b43d8117241392e2a241',
}

def require(ok, reason):
    if not ok:
        raise RuntimeError('FS2_WITNESS_HOLD:' + reason)

def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb', buffering=0) as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def unescape_mount(s):
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), s)

def mount_rows():
    rows = []
    with open('/proc/self/mountinfo', encoding='utf-8') as f:
        for line in f:
            left, sep, right = line.rstrip('\n').partition(' - ')
            require(bool(sep), 'MOUNTINFO_PARSE')
            a, b = left.split(), right.split()
            rows.append((unescape_mount(a[4]), set(a[5].split(',')), b[0]))
    return rows

def covering(rows, path):
    matches = [r for r in rows if path == r[0] or path.startswith(r[0].rstrip('/') + '/')]
    require(bool(matches), 'MOUNT_MISSING:' + path)
    return max(matches, key=lambda r: len(r[0]))

# Exact helper-produced environment plus only witness metadata and the authorized marker.
state = '/bb0-state'
expected = {
    'PATH': '/home/ubuntu/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin',
    'HOME': state + '/home', 'PI_AGENT_DIR': state + '/agent',
    'PI_CODING_AGENT_DIR': state + '/agent', 'XDG_CONFIG_HOME': state + '/config',
    'XDG_CACHE_HOME': state + '/cache', 'XDG_DATA_HOME': state + '/data',
    'XDG_STATE_HOME': state + '/state', 'TMPDIR': state + '/tmp',
    'TMP': state + '/tmp', 'TEMP': state + '/tmp',
    'npm_config_cache': state + '/npm-cache',
    'npm_config_userconfig': state + '/home/.npmrc',
    'npm_config_globalconfig': state + '/home/global.npmrc',
    'npm_config_update_notifier': 'false', 'npm_config_audit': 'false',
    'npm_config_fund': 'false', 'USER': 'ubuntu', 'LOGNAME': 'ubuntu',
    'SHELL': '/bin/sh', 'LANG': 'C.UTF-8', 'TZ': 'UTC', 'CI': '1',
    'NO_COLOR': '1', 'TERM': 'xterm-256color',
    'PI_DURABLE_GLOBAL_ROOT': '/home/ubuntu/.nvm/versions/node/v24.19.0/lib/node_modules',
    'HINDSIGHT_DISABLED': '1', 'HINDSIGHT_DISABLE_HOOKS': '1',
}
require(os.environ.get('BB0_SDK_LEAF_GO') == 'sdk-definition-leaf-v1', 'GO_MARKER')
require('NODE_OPTIONS' not in os.environ, 'NODE_OPTIONS_PRESENT')
require(os.environ.get('BB0_EXPECT_HOST_PID_NS'), 'HOST_PID_NS_MISSING')
require(os.environ.get('BB0_HOST_NET_NS'), 'HOST_NET_NS_MISSING')
require(re.fullmatch(r'pid:\[\d+\]', os.environ['BB0_EXPECT_HOST_PID_NS']), 'HOST_PID_NS_FORMAT')
require(re.fullmatch(r'mnt:\[\d+\]', os.environ['BB0_EXPECT_HOST_MNT_NS']), 'HOST_MNT_NS_FORMAT')
require(re.fullmatch(r'net:\[\d+\]', os.environ['BB0_HOST_NET_NS']), 'HOST_NET_NS_FORMAT')
require(os.environ.get('BB0_EXPECT_HOST_MNT_NS'), 'HOST_MNT_NS_MISSING')
require(os.environ.get('BB0_EXPECT_HOST_UID', '').isdigit(), 'HOST_UID_MISSING')
require(os.environ.get('BB0_EXPECT_HOST_GID', '').isdigit(), 'HOST_GID_MISSING')
expected.update({
    'BB0_HIDDEN_SENTINEL': os.environ.get('BB0_HIDDEN_SENTINEL', ''),
    'BB0_HOST_NET_NS': os.environ.get('BB0_HOST_NET_NS', ''),
    'BB0_SDK_LEAF_GO': 'sdk-definition-leaf-v1',
    'BB0_EXPECT_HOST_PID_NS': os.environ['BB0_EXPECT_HOST_PID_NS'],
    'BB0_EXPECT_HOST_MNT_NS': os.environ['BB0_EXPECT_HOST_MNT_NS'],
    'BB0_EXPECT_HOST_UID': os.environ['BB0_EXPECT_HOST_UID'],
    'BB0_EXPECT_HOST_GID': os.environ['BB0_EXPECT_HOST_GID'],
})
require(set(os.environ) == set(expected), 'ENV_KEYS')
require(dict(os.environ) == expected, 'ENV_VALUES')
require(os.getcwd() == '/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/provider', 'CWD')
huid, hgid = int(expected['BB0_EXPECT_HOST_UID']), int(expected['BB0_EXPECT_HOST_GID'])
require(os.getuid() == os.geteuid() == huid, 'UID')
require(os.getgid() == os.getegid() == hgid, 'GID')

# Own proc/namespace evidence only; no process enumeration.
pid_ns = os.readlink('/proc/self/ns/pid')
net_ns = os.readlink('/proc/self/ns/net')
mnt_ns = os.readlink('/proc/self/ns/mnt')
require(pid_ns != expected['BB0_EXPECT_HOST_PID_NS'], 'PID_NS_NOT_PRIVATE')
require(net_ns != expected['BB0_HOST_NET_NS'], 'NET_NS_NOT_PRIVATE')
require(mnt_ns != expected['BB0_EXPECT_HOST_MNT_NS'], 'MNT_NS_NOT_PRIVATE')
status = {}
with open('/proc/self/status', encoding='ascii') as f:
    for line in f:
        if line.startswith(('CapInh:', 'CapPrm:', 'CapEff:', 'CapBnd:', 'CapAmb:')):
            k, v = line.split(':', 1)
            status[k] = int(v.strip(), 16)
require(set(status) == {'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'}, 'CAP_FIELDS')
require(all(v == 0 for v in status.values()), 'CAPABILITIES_NONZERO')
rows = mount_rows()
root_mount = next((r for r in rows if r[0] == '/'), None)
proc_mount = next((r for r in rows if r[0] == '/proc'), None)
require(root_mount is not None and 'ro' in root_mount[1], 'ROOT_NOT_READONLY')
require(proc_mount is not None and proc_mount[2] == 'proc', 'PROC_MOUNT')
require([x.split(':', 1)[0].strip() for x in open('/proc/net/dev', encoding='ascii').read().splitlines()[2:]] == ['lo'], 'NET_INTERFACES')

node_row = covering(rows, NODE)
require(stat.S_ISREG(os.stat(NODE).st_mode) and os.access(NODE, os.X_OK), "NODE_NOT_EXECUTABLE")
require("ro" in node_row[1], "NODE_NOT_READONLY")
# Verify exact private modes; record POSIX ACL-name presence as informational metadata.
def private_dir(path):
    s = os.stat(path, follow_symlinks=False)
    require(stat.S_ISDIR(s.st_mode), 'NOT_DIR:' + path)
    require(s.st_uid == huid and stat.S_IMODE(s.st_mode) == 0o700, 'DIR_MODE_OWNER:' + path)
    require(not (s.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)), 'DIR_SPECIAL_MODE:' + path)
    names = os.listxattr(path, follow_symlinks=False)
    return any(n.startswith('system.posix_acl_') for n in names)

private_acl_names_present = {state: private_dir(state)}
for name in ('home', 'agent', 'config', 'cache', 'data', 'state', 'tmp', 'npm-cache', 'work'):
    path = state + '/' + name
    private_acl_names_present[path] = private_dir(path)
private_acl_names_present['/bb0-readonly'] = private_dir('/bb0-readonly')
require('ro' in covering(rows, '/bb0-readonly')[1], 'FIXTURE_NOT_READONLY')

# Four exact path/hash/readonly checks; never attempt writes to public mounted sources.
for path, expected_sha in PINS.items():
    require(os.path.realpath(path) == path, 'SOURCE_NONCANONICAL:' + path)
    require(stat.S_ISREG(os.stat(path, follow_symlinks=False).st_mode), 'SOURCE_NOT_REGULAR:' + path)
    row = covering(rows, path)
    require(row[0] == path and 'ro' in row[1], 'SOURCE_NOT_EXACT_READONLY_BIND:' + path)
    require(sha(path) == expected_sha, 'SOURCE_HASH:' + path)

# The helper's synthetic concealed marker must be absent. Private RW canaries are left
# in this unique run state as evidence; nothing is removed on failure or success.
hidden = expected['BB0_HIDDEN_SENTINEL']
try:
    os.stat(hidden)
except FileNotFoundError:
    pass
else:
    raise RuntimeError('FS2_WITNESS_HOLD:HIDDEN_MARKER_VISIBLE')
for directory, name in ((expected['HOME'], 'sdk-leaf-home-canary'),
                        (expected['TMPDIR'], 'sdk-leaf-tmp-canary')):
    path = directory + '/' + name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, b'sdk-leaf-fs2-preexec-canary-v1\n')
        os.fsync(fd)
    finally:
        os.close(fd)
    require(stat.S_IMODE(os.stat(path, follow_symlinks=False).st_mode) == 0o600, 'CANARY_MODE:' + path)

# Remove only witness comparison variables. Keep the original helper environment and GO.
node_env = dict(os.environ)
for key in ('BB0_EXPECT_HOST_PID_NS', 'BB0_EXPECT_HOST_MNT_NS',
            'BB0_EXPECT_HOST_UID', 'BB0_EXPECT_HOST_GID'):
    node_env.pop(key)
receipt = {
    "phase": "preexec", "pid": os.getpid(),
    "namespaces": {"pid": pid_ns, "net": net_ns, "mnt": mnt_ns},
    "uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "egid": os.getegid(),
    "capabilities": status, "env_exact_match": True,
    "root_mount": {"mountpoint": root_mount[0], "options": sorted(root_mount[1])},
    "node_mount": {"mountpoint": node_row[0], "options": sorted(node_row[1])},
    "proc_mount": {"fstype": proc_mount[2], "options": sorted(proc_mount[1])},
    "interfaces": [x.split(":", 1)[0].strip() for x in open("/proc/net/dev", encoding="ascii").read().splitlines()[2:]],
    "go_marker": expected["BB0_SDK_LEAF_GO"], "node_options_absent": True,
    "private_dirs_posix_acl_names_present": private_acl_names_present,
    "private_dirs_mode": {p: oct(stat.S_IMODE(os.stat(p, follow_symlinks=False).st_mode))
                            for p in [state] + [state + "/" + n for n in ("home", "agent", "config", "cache", "data", "state", "tmp", "npm-cache", "work")]},
    "readonly_files_sha256": {p: sha(p) for p in PINS},
    "readonly_mounts": {p: {"mountpoint": covering(rows, p)[0], "options": sorted(covering(rows, p)[1])} for p in PINS},
    "private_canaries": [expected["HOME"] + "/sdk-leaf-home-canary", expected["TMPDIR"] + "/sdk-leaf-tmp-canary"],
}
os.write(1, b"BB0_LEAF_PREEXEC " + json.dumps(receipt, sort_keys=True).encode("utf-8") + b"\n")
# No argv/execArgv rewrite, Node flags, SDK edits, or pre-imports.
os.execve(NODE, [NODE, PROBE, '--execute-leaf'], node_env)
