#!/usr/bin/env python3
"""Own only the terminal transport. The admitted native CLI owns execution/storage."""
import fcntl, json, os, pty, stat, subprocess, sys

with open(sys.argv[1], encoding='utf-8') as f:
    spec = json.load(f)
claim = os.open(spec['claim'], os.O_RDWR | os.O_CREAT, 0o600)
try:
    fcntl.flock(claim, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)  # Existing terminal owner; the caller waits for that same socket.
resume = None
if os.path.exists(spec['ready']):
    with open(spec['ready'], encoding='utf-8') as f:
        owner = json.load(f)
    try:
        os.kill(owner['pid'], 0)
    except ProcessLookupError:
        resume = owner['directory']
    else:
        raise RuntimeError('Native owner is still alive; refusing a second CLI or takeover')
    for path in [spec['socket'], spec['grant'] + '.sock']:
        if os.path.lexists(path):
            info = os.lstat(path)
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeError('Refusing to remove a foreign endpoint')
            os.unlink(path)
    os.unlink(spec['ready'])
master, slave = pty.openpty()
env = dict(os.environ, **spec.get('env', {}), TERM='xterm-256color',
           PI_DURABLE_BB_OWNER_GRANT=spec['grant'], PI_DURABLE_BB_READY=spec['ready'])
args = [spec['cli'], '--listen', spec['socket'], '--extension', spec['global'], '--extension', spec['extension']]
if resume:
    args.extend(['--session', resume])
child = subprocess.Popen(args, cwd=spec['cwd'], env=env,
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
tail = b''
while True:
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    # No parallel transcript store. Retain only bounded PRE-ready startup diagnostics.
    if not os.path.exists(spec['ready']):
        tail = (tail + data)[-65536:]
    else:
        tail = b''
os.close(master)
code = child.wait()
if code and tail:
    fd = os.open(spec['failure'], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(tail)
sys.exit(code)
