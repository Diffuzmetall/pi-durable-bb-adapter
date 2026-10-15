#!/usr/bin/env python3
"""Fixed zero-generation exact-main PTY smoke; run only via lead-sandbox.py --boot."""
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import sqlite3
import struct
import subprocess
import termios
import time

STATE = Path('/bb0-state')
HOST = Path('/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/host')
NODE = '/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
SOCKET = STATE / 'shared.sock'
command = [NODE, '--import', str(HOST / 'global-runtime.mjs'),
    str(HOST / 'packages/coding-agent/src/experimental/durable/main.ts'), '--no-mcp', '--listen', str(SOCKET)]
report = {'status':'FAIL', 'command':command, 'cwd':os.getcwd(), 'submittedPrompts':0,
    'modelProfile':'OFFLINE ZERO-GENERATION BOOT; NOT native faux generation',
    'submittedPromptsMeaning':'Fixed driver input fact, not a measured model-invocation counter',
    'network':'isolated namespace; no BB or model endpoints', 'checks':{}}
output = bytearray()
proc = None
master = None
client = None
started = time.monotonic()

def drain(timeout=0.1):
    if select.select([master], [], [], timeout)[0]:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            return
        output.extend(chunk)
        # Answer terminal capability queries only, never send a prompt/command.
        if b'\x1b[c' in chunk:
            os.write(master, b'\x1b[?1;2c')

try:
    assert os.getcwd() == '/bb0-state/work'
    assert os.environ['HOME'] == '/bb0-state/home'
    assert os.environ['PI_AGENT_DIR'] == os.environ['PI_CODING_AGENT_DIR'] == '/bb0-state/agent'
    assert os.environ['HINDSIGHT_DISABLED'] == os.environ['HINDSIGHT_DISABLE_HOOKS'] == '1'
    assert os.readlink('/proc/self/ns/net') != os.environ['BB0_HOST_NET_NS']
    assert not Path(os.environ['BB0_HIDDEN_SENTINEL']).exists()
    assert not Path('/home/ubuntu/.pi').exists()
    assert not SOCKET.exists() and not list(STATE.rglob('*.sqlite'))
    assert sorted(p.name for p in (STATE / 'agent').iterdir()) == ['models.json','settings.json']
    assert json.loads((STATE/'agent/settings.json').read_text()) == {
        'defaultProvider':'bb0-offline','defaultModel':'boot-only','packages':[],'extensions':[]}
    profile = json.loads((STATE/'agent/models.json').read_text())
    assert list(profile['providers']) == ['bb0-offline']
    assert profile['providers']['bb0-offline']['baseUrl'] == 'http://127.0.0.1:9/never-call'
    assert profile['providers']['bb0-offline']['apiKey'] == 'synthetic-offline-not-a-secret'
    report['effectiveConfiguration'] = []
    configurations = [
        ('host-source', HOST/'packages/coding-agent/src/config.ts',
         HOST/'packages/coding-agent/src/core/settings-manager.ts', ['--import',str(HOST/'global-runtime.mjs')]),
        ('provider-sdk', HOST.parent/'provider/node_modules/@earendil-works/pi-coding-agent/dist/config.js',
         HOST.parent/'provider/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js', []),
    ]
    for label, config_path, settings_path, preload in configurations:
        code = f'''
import * as config from {json.dumps(config_path.as_uri())};
import {{ SettingsManager }} from {json.dumps(settings_path.as_uri())};
import assert from 'node:assert/strict';
import {{ readFileSync }} from 'node:fs';
assert.equal(config.getAgentDir(), '/bb0-state/agent');
assert.equal(config.getSettingsPath(), '/bb0-state/agent/settings.json');
assert.equal(config.getModelsPath(), '/bb0-state/agent/models.json');
assert.equal(config.getAuthPath(), '/bb0-state/agent/auth.json');
const settings = SettingsManager.create(process.cwd());
assert.equal(settings.getDefaultProvider(), 'bb0-offline');
assert.equal(settings.getDefaultModel(), 'boot-only');
const models = JSON.parse(readFileSync(config.getModelsPath(),'utf8'));
assert.deepEqual(Object.keys(models.providers), ['bb0-offline']);
assert.equal(models.providers['bb0-offline'].models[0].id, 'boot-only');
assert.equal(models.providers['bb0-offline'].baseUrl, 'http://127.0.0.1:9/never-call');
assert.equal(models.providers['bb0-offline'].apiKey, 'synthetic-offline-not-a-secret');
console.log(JSON.stringify({{lane:{json.dumps(label)},version:config.VERSION,node:process.versions.node,
    agentDir:config.getAgentDir(),settingsPath:config.getSettingsPath(),modelsPath:config.getModelsPath(),
    defaultProvider:settings.getDefaultProvider(),defaultModel:settings.getDefaultModel()}}));
'''
        checked = subprocess.run([NODE,*preload,'--input-type=module','--eval',code],capture_output=True,text=True,timeout=15)
        assert checked.returncode == 0, f'{label} effective config failed: {checked.stderr}'
        report['effectiveConfiguration'].append(json.loads(checked.stdout))
    report['checks']['effectiveHostAndProviderSdkConfiguration'] = 'PASS'
    report['checks']['freshPrivateConfiguration'] = 'PASS'
    report['checks']['isolatedNetworkNamespace'] = 'PASS'
    report['profileHashes'] = {name:hashlib.sha256((STATE/'agent'/name).read_bytes()).hexdigest()
        for name in ['settings.json','models.json']}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
    proc = subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
    os.close(slave)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and proc.poll() is None and not SOCKET.exists():
        drain()
    assert SOCKET.is_socket(), f'No ready socket; child exit={proc.poll()}'
    assert SOCKET.stat().st_mode & 0o777 == 0o600
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(3)
    client.connect(str(SOCKET))
    client.sendall((json.dumps({'type':'attach','id':'bb0-boot-attach','cwd':os.getcwd()})+'\n').encode())
    wire = bytearray()
    response = None
    while time.monotonic() < deadline and response is None:
        drain(0)
        wire.extend(client.recv(65536))
        while b'\n' in wire:
            line, _, rest = wire.partition(b'\n')
            wire = bytearray(rest)
            frame = json.loads(line)
            if frame.get('id') == 'bb0-boot-attach':
                response = frame
    assert response is not None and response.get('success') is True, response
    view = response['data']
    report['readyView'] = view
    assert view['session']['cwd'] == os.getcwd()
    assert view['session']['directory'].startswith('/bb0-state/agent/experimental/durable-sessions/')
    assert view['conversation']['docs']['pi.agent']['model'] == {'provider':'bb0-offline','modelId':'boot-only'}
    assert any(m['provider']=='bb0-offline' and m['modelId']=='boot-only' for m in view['models'])
    assert view['conversation']['entries'] == [], 'Unexpected conversation entries/model attempt'
    assert view['conversation']['docs']['pi.usage']['models'] == {}, 'Observed model usage; stop'
    report['checks']['approvedOfflineModelSelected'] = 'PASS'
    report['checks']['ownedSharedSocketAttach'] = 'PASS'
    # Require the real TUI to paint the selected synthetic model before exit.
    while time.monotonic() < deadline and proc.poll() is None and b'boot-only' not in output:
        drain()
    assert b'boot-only' in output, 'TUI did not paint configured boot-only model'
    report['checks']['actualTuiPainted'] = 'PASS'
    report['readySeconds'] = round(time.monotonic()-started,3)
    client.close()
    client = None
    os.write(master,b'\x04')  # Ctrl-D on an empty editor: owned normal exit.
    deadline = time.monotonic()+10
    while time.monotonic() < deadline and proc.poll() is None:
        drain()
    assert proc.poll() == 0, f'Ctrl-D did not finish cleanly; exit={proc.poll()}'
    drain(0)
    report['exitCode'] = proc.returncode
    report['checks']['ownedOrderlyShutdown'] = 'PASS'
    assert not SOCKET.exists(), 'Owned socket remained after normal close'
    stores = list((STATE/'agent').rglob('session.sqlite'))
    assert len(stores) == 1, stores
    store = stores[0]
    assert not Path(str(store.parent)+'.lock').exists(), 'Owned session-directory lock remained'
    assert not list(store.parent.glob('*.lock')), 'Unexpected store lock remained'
    with sqlite3.connect(f'file:{store}?mode=ro',uri=True) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    report['store'] = str(store)
    report['checks']['freshSqliteClosedAndIntegrity'] = 'PASS'
    report['status'] = 'PASS'
except Exception as error:
    report['error'] = f'{type(error).__name__}: {error}'
finally:
    if client is not None:
        client.close()
    if proc is not None and proc.poll() is None:
        report['forcedCleanup'] = True
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
    if master is not None:
        drain(0)
        os.close(master)
    report['childExitCode'] = None if proc is None else proc.returncode
    report['elapsedSeconds'] = round(time.monotonic()-started,3)
    (STATE/'terminal-output.txt').write_bytes(output)
    report['transcriptSha256'] = hashlib.sha256(output).hexdigest()
    (STATE/'boot-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)
raise SystemExit(0 if report['status']=='PASS' else 1)
