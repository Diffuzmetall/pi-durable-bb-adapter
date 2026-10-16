#!/usr/bin/env python3
"""Actual managed-reference/candidate main, deterministic local SSE, paired raw timings."""
import fcntl
import hashlib
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pty
import select
import signal
import socket
import sqlite3
import statistics
import struct
import subprocess
import termios
import threading
import time

ROOT=Path('/home/ubuntu/Projects/pi-durable-bb-adapter')
STATE=Path('/bb0-state')
NODE='/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node'
KEY='synthetic-offline-not-a-secret'
PROMPT='BB0_SYNTHETIC_TRACE'
report={'status':'FAIL','claim':'Actual native renderer/shared protocol; incremental text observed before tail release, not browser paint',
    'samples':[],'requests':[],'errors':[],'checks':{},'hosts':{},'coldDefinition':'Fresh process and session; OS page cache not flushed',
    'warmRecipe':'After one cold generation each, 30 paired warm samples per side in strict reference/candidate alternating order; identical growing message histories'}
lock=threading.Lock()
counts={'reference':0,'candidate':0}
holds={}
hosts=[]

class Fixture(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        side=self.path.split('/')[1]
        try:
            assert side in counts and self.path==f'/{side}/v1/chat/completions',self.path
            assert self.headers.get('Authorization')=='Bearer '+KEY
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert body['model']=='boot-only' and body['stream'] is True
            assert PROMPT in json.dumps(body['messages'][-1]),'Unexpected model workload'
            with lock:
                index=counts[side]
                counts[side]+=1
                record={'side':side,'index':index,'model':body['model'],'path':self.path,'receivedAtMonotonic':time.monotonic(),
                    'messageCount':len(body['messages']),
                    'messagesSha256':hashlib.sha256(json.dumps(body['messages'],sort_keys=True).encode()).hexdigest()}
                report['requests'].append(record)
            marker=f'BB0_{index:03d}_ALPHA'
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.send_header('Cache-Control','no-cache')
            self.send_header('Connection','close')
            self.end_headers()
            def chunk(delta,finish=None,usage=None):
                packet={'id':'bb0-local-fixture','object':'chat.completion.chunk','created':0,'model':'boot-only',
                    'choices':[{'index':0,'delta':delta,'finish_reason':finish}]}
                if usage is not None: packet['usage']=usage
                self.wfile.write(('data: '+json.dumps(packet)+'\n\n').encode())
                self.wfile.flush()
            chunk({'role':'assistant','content':marker})
            record['firstChunkFlushedAtMonotonic']=time.monotonic()
            assert holds[side,index].wait(10),'First-text hold was not released'
            record['tailReleaseObservedAtMonotonic']=time.monotonic()
            chunk({'content':'_OMEGA'})
            chunk({},'stop',{'prompt_tokens':17,'completion_tokens':2,'total_tokens':19})
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
            record['lastChunkFlushedAtMonotonic']=time.monotonic()
            self.close_connection=True
        except Exception as error:
            with lock: report['errors'].append(f'HTTP fixture: {type(error).__name__}: {error}')
            self.close_connection=True

class Host:
    def __init__(self,side,source,loader,port,reopen=None):
        self.side=side
        self.agent=reopen.agent if reopen else STATE/(side+'-agent')
        if reopen is None: self.agent.mkdir(mode=0o700)
        settings={'defaultProvider':'bb0-offline','defaultModel':'boot-only','packages':[],'extensions':[]}
        model={'providers':{'bb0-offline':{'api':'openai-completions','baseUrl':f'http://127.0.0.1:{port}/{side}/v1',
            'apiKey':KEY,'models':[{'id':'boot-only','name':'BB0 offline synthetic','reasoning':False,'input':['text'],
            'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':32768,'maxTokens':128}]}}}
        if reopen is None:
            for name,value in [('settings.json',settings),('models.json',model)]:
                (self.agent/name).write_text(json.dumps(value)+'\n')
        env=dict(os.environ,PI_AGENT_DIR=str(self.agent),PI_CODING_AGENT_DIR=str(self.agent))
        self.env=env
        self.path=STATE/(side+'.sock')
        assert not self.path.exists()
        if reopen is None: assert not list(self.agent.rglob('*.sqlite'))
        else: assert not Path(reopen.session['directory']+'.lock').exists()
        self.master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',36,140,0,0))
        self.command=[NODE,'--import',str(loader),str(source/'packages/coding-agent/src/experimental/durable/main.ts'),
            '--no-mcp','--listen',str(self.path)]
        if reopen is not None: self.command+=['--session',reopen.session['directory']]
        self.proc=subprocess.Popen(self.command,cwd=STATE/'work',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        self.clients=[]
        self.output=bytearray()
        self.clients_serial=0
        self.frame_log=(STATE/(side+'-frames.jsonl')).open('w')
        hosts.append(self)
        self.wait(lambda:self.path.is_socket(),30)
        assert self.path.stat().st_mode&0o777==0o600
        self.controller,elapsed,view=self.attach()
        assert view['conversation']['docs']['pi.agent']['model']=={'provider':'bb0-offline','modelId':'boot-only'}
        assert view['session']['directory'].startswith(str(self.agent)+'/experimental/durable-sessions/')
        assert view['conversation']['conversation']['id']==1
        self.session=view['session']
        report['hosts'][side]={'command':self.command,'session':view['session'],'coldAttachMs':elapsed,
            'selectedModel':view['conversation']['docs']['pi.agent']['model']}
        self.cold_attach_ms=elapsed
        self.wait(lambda:b'boot-only' in self.output,15)
    def pump(self,timeout=0.02):
        readers=[self.master]+[c['socket'] for c in self.clients]
        ready=select.select(readers,[],[],timeout)[0]
        for fd in ready:
            if fd==self.master:
                try: data=os.read(self.master,65536)
                except OSError: data=b''
                self.output.extend(data)
                if b'\x1b[c' in data: os.write(self.master,b'\x1b[?1;2c')
                continue
            client=next(c for c in self.clients if c['socket']==fd)
            data=fd.recv(1024*1024)
            assert data,'Unexpected shared client EOF'
            client['buffer']+=data
            while b'\n' in client['buffer']:
                line,client['buffer']=client['buffer'].split(b'\n',1)
                frame=json.loads(line)
                client['frames'].append(frame)
                self.frame_log.write(json.dumps({'client':client['serial'],'frame':frame})+'\n')
        assert not report['errors'],report['errors']
    def wait(self,predicate,timeout=15):
        deadline=time.monotonic()+timeout
        while not predicate():
            assert self.proc.poll() is None,f'{self.side} child exited {self.proc.returncode}'
            assert time.monotonic()<deadline,f'{self.side} readiness/event timeout'
            self.pump()
    def send(self,client,command):
        client['socket'].sendall((json.dumps(command)+'\n').encode())
    def attach(self,cwd='/bb0-state/work',expect=True):
        started=time.monotonic()
        conn=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        conn.connect(str(self.path))
        self.clients_serial+=1
        client={'socket':conn,'buffer':b'','frames':[],'serial':self.clients_serial}
        self.clients.append(client)
        self.send(client,{'type':'attach','id':'attach','cwd':cwd})
        self.wait(lambda:any(f.get('id')=='attach' for f in client['frames']))
        response=next(f for f in client['frames'] if f.get('id')=='attach')
        assert response['success'] is expect,response
        return client,(time.monotonic()-started)*1000,response.get('data',response)
    def detach(self,client):
        self.clients.remove(client)
        client['socket'].close()
    def start_turn(self,index):
        client=self.controller
        client['frames'].clear()
        self.turn_started=time.monotonic()
        self.turn_output_start=len(self.output)
        holds[self.side,index]=threading.Event()
        self.send(client,{'type':'prompt','id':'prompt-'+str(index),'message':PROMPT})
        self.turn_index=index
    def finish_turn(self,client=None):
        client=client or self.controller
        marker=f'BB0_{self.turn_index:03d}_ALPHA'
        wire_ms=None
        tui_ms=None
        ended=False
        wire_evidence=None
        first_text_released=False
        position=0
        deadline=time.monotonic()+20
        while not (ended and wire_ms is not None and tui_ms is not None):
            assert time.monotonic()<deadline,f'{self.side} generation timeout; wire={wire_ms} tui={tui_ms} end={ended}'
            self.pump()
            for frame in client['frames'][position:]:
                if frame.get('type')=='response' and frame.get('command')=='prompt': assert frame['success'],frame
                if wire_ms is None and marker in json.dumps(frame):
                    assert marker+'_OMEGA' not in json.dumps(frame),'First text coalesced with completed answer'
                    wire_ms=(time.monotonic()-self.turn_started)*1000
                    wire_evidence={'frameType':frame['type'],'eventTypes':[e['type'] for e in frame.get('events',[])]}
                for event in frame.get('events',[]):
                    if event.get('type')=='run_end' and wire_ms is not None: ended=True
            position=len(client['frames'])
            if marker.encode() in self.output[self.turn_output_start:] and tui_ms is None:
                assert (marker+'_OMEGA').encode() not in self.output[self.turn_output_start:],'First renderer text coalesced with completed answer'
                tui_ms=(time.monotonic()-self.turn_started)*1000
            if wire_ms is not None and tui_ms is not None and not first_text_released:
                assert not holds[self.side,self.turn_index].is_set(),'Tail released before first-text observations'
                holds[self.side,self.turn_index].set()
                first_text_released=True
        assert first_text_released
        assert counts[self.side]==self.turn_index+1,'Unexpected extra/missing HTTP model invocation'
        request=next(r for r in report['requests'] if r['side']==self.side and r['index']==self.turn_index)
        self.wait(lambda:'lastChunkFlushedAtMonotonic' in request)
        first_ms=(request['firstChunkFlushedAtMonotonic']-self.turn_started)*1000
        assert self.turn_started+max(wire_ms,tui_ms)/1000 <= request['tailReleaseObservedAtMonotonic']
        return {'wireFirstIncrementalTextObservedMs':wire_ms,'terminalFirstIncrementalTextBytesObservedMs':tui_ms,
            'firstTextObservedBeforeTailRelease':True,'wireVisibilityEvidence':wire_evidence,
            'completedTurnObservedMs':(time.monotonic()-self.turn_started)*1000,
            'submitToFixtureRequestMs':(request['receivedAtMonotonic']-self.turn_started)*1000,
            'fixtureTraceDurationMs':(request['lastChunkFlushedAtMonotonic']-request['firstChunkFlushedAtMonotonic'])*1000,
            'fixtureFirstChunkToWireMs':wire_ms-first_ms,'fixtureFirstChunkToTerminalMs':tui_ms-first_ms}
    def close(self):
        for client in self.clients[:]: self.detach(client)
        os.write(self.master,b'\x04')
        deadline=time.monotonic()+10
        while self.proc.poll() is None and time.monotonic()<deadline:
            self.pump()
        assert self.proc.poll()==0,f'{self.side} normal Ctrl-D exit failed: {self.proc.poll()}'
        assert not self.path.exists()
        stores=list(self.agent.rglob('session.sqlite'))
        assert len(stores)==1
        assert not Path(str(stores[0].parent)+'.lock').exists()
        with sqlite3.connect(f'file:{stores[0]}?mode=ro',uri=True) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        report['hosts'][self.side].update({'childExitCode':0,'sqliteIntegrity':'ok','store':str(stores[0]),
            'terminalTranscriptSha256':hashlib.sha256(self.output).hexdigest()})
        (STATE/(self.side+'-terminal.txt')).write_bytes(self.output)
        self.frame_log.close()
        os.close(self.master)

server=None
try:
    assert os.readlink('/proc/self/ns/net')!=os.environ['BB0_HOST_NET_NS']
    manifest=json.loads(Path('/bb0-candidate-manifest.json').read_text())
    overlay_path='packages/coding-agent/src/extensions/codemode/tool.ts'
    overlay_before=(17692,'67216b67186567278527edc5c6544cbb7e52a515a4887b4cf433299f8d1e9113')
    overlay_after=(16804,'f9495350672382574ee8f1e8b3e4c8e46ceb9ef3dd521b28cf2ffbeed900004f')
    overlay_seen=0
    for row in manifest['sources']['host']['files']:
        expected=(row['bytes'],row['sha256'])
        if row['path']==overlay_path:
            assert expected==overlay_before,'Original host overlay entry differs from frozen inventory'
            expected=overlay_after
            overlay_seen+=1
        raw=(ROOT/'candidates/host'/row['path']).read_bytes()
        assert (len(raw),hashlib.sha256(raw).hexdigest())==expected,('Host source mismatch',row['path'])
    assert overlay_seen==1,'Exactly one inventoried host overlay entry required'
    report['hostSourceOverlay']={'path':overlay_path,'originalBytes':overlay_before[0],
        'originalSha256':overlay_before[1],'candidateBytes':overlay_after[0],'candidateSha256':overlay_after[1],
        'scope':'Production CodeMode caller uses public SDK1.2 schema rendering; every inventoried host file checked'}
    assert (ROOT/'candidates/global-runtime.mjs').read_bytes()==Path('/bb0-managed-global-runtime.mjs').read_bytes()
    report['referenceSource']='Inventoried host plus ONE explicit byte/hash-checked SDK1.2 CodeMode caller correction, identical readonly source paths on both sides. Reference uses original managed parent loader, candidate adjusted-location loader; identical documentation paths preserve model messages. Not unchanged donor-source parity or dist recertification.'
    server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    port=server.server_port
    report['measurementWindowUTC']={'start':datetime.now(timezone.utc).isoformat()}
    report['hostEnvironment']={'loadAvgBefore':list(os.getloadavg()),'logicalCPUs':os.cpu_count(),'architecture':os.uname().machine}
    for side,source,loader in [('reference',ROOT/'candidates/host',ROOT/'candidates/global-runtime.mjs'),
                               ('candidate',ROOT/'candidates/host',ROOT/'candidates/host/global-runtime.mjs')]:
        host=Host(side,source,loader,port)
        host.start_turn(0)
        metrics=host.finish_turn()
        report['samples'].append({'phase':'cold','side':side,'index':0,'attachMs':host.cold_attach_ms,**metrics})
    for index in range(1,31):
        for host in hosts:  # Reference FIRST, then candidate on every warm pair.
            observer,attach_ms,view=host.attach()
            assert view['session']==host.session
            before=counts[host.side]
            host.detach(observer)
            assert counts[host.side]==before,'Attach generated work'
            host.start_turn(index)
            report['samples'].append({'phase':'warm','side':host.side,'index':index,'attachMs':attach_ms,**host.finish_turn()})
    report['measurementWindowUTC']['end']=datetime.now(timezone.utc).isoformat()
    report['hostEnvironment']['loadAvgAfter']=list(os.getloadavg())
    for index in range(31):
        pair=[r for r in report['requests'] if r['index']==index]
        assert len(pair)==2 and pair[0]['side']=='reference' and pair[1]['side']=='candidate'
        assert pair[0]['messagesSha256']==pair[1]['messagesSha256'],f'Nonidentical message histories at pair {index}'
    report['checks']['identicalTraceAndPairedThirtyWarmSamples']='PASS'
    host=hosts[1]
    wrong=STATE/'wrong-cwd'
    wrong.mkdir()
    rejected,_,response=host.attach(str(wrong),expect=False)
    assert 'different working directory' in response['error']
    assert not any('view' in f or f.get('type')=='agent_events' for f in rejected['frames'])
    host.detach(rejected)
    report['checks']['wrongCwdAttachDeniedBeforeHistory']='PASS'
    host.start_turn(31)
    host.wait(lambda:any('BB0_031_ALPHA' in json.dumps(f) for f in host.controller['frames']))
    late,_,late_view=host.attach()
    assert late_view['session']==host.session
    assert 'BB0_031_ALPHA' in json.dumps(late['frames']),'Late attach omitted in-flight text'
    assert counts['candidate']==32
    host.detach(host.controller)
    host.finish_turn(late)
    assert any('BB0_031_ALPHA_OMEGA' in json.dumps(f) for f in late['frames']),'Surviving observer missed final text'
    assert host.proc.poll() is None
    assert counts['candidate']==32,'Detach/late attach duplicated generation'
    host.controller=late
    report['checks']['lateAttachSnapshotNoResubmit']='PASS'
    report['checks']['detachDoesNotAbortOtherObserverOrRuntime']='PASS'
    report['checks']['nativeConversationIdentityStable']='PASS'
    for host in hosts:
        host.send(host.controller,{'type':'get_state','id':'state-check'})
        host.wait(lambda:any(f.get('id')=='state-check' for f in host.controller['frames']))
        state=next(f for f in host.controller['frames'] if f.get('id')=='state-check')
        assert state['success'] and state['data']['sessionId']==host.session['id']
        assert state['data']['model']['provider']=='bb0-offline' and state['data']['model']['modelId']=='boot-only'
        report['hosts'][host.side]['getState']=state['data']
    owner=hosts[1]
    denied_socket=STATE/'second-owner-denied.sock'
    command=list(owner.command)
    command[command.index('--listen')+1]=str(denied_socket)
    command+=['--session',owner.session['directory']]
    denied=subprocess.run(command,cwd=STATE/'work',env=owner.env,stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=25)
    (STATE/'second-owner-denied.log').write_text(denied.stdout)
    assert denied.returncode!=0 and 'Session is already open in another process' in denied.stdout
    assert owner.proc.poll() is None and not denied_socket.exists()
    report['checks']['secondNativeOwnerDeniedByExistingSessionLock']='PASS'
    report['secondOwnerProbe']={'exitCode':denied.returncode,'command':command,'logSha256':hashlib.sha256(denied.stdout.encode()).hexdigest()}
    for host in hosts: host.close()
    reference=hosts[0]
    reopened=Host('reopened',ROOT/'candidates/host',ROOT/'candidates/host/global-runtime.mjs',port,reopen=reference)
    assert reopened.session==reference.session,'Candidate reopen changed the baseline session identity'
    assert any('BB0_030_ALPHA_OMEGA' in json.dumps(frame) for frame in reopened.controller['frames'])
    assert counts=={'reference':31,'candidate':32},'Reopen generated unexpected model work'
    reopened.close()
    report['checks']['candidateReopensExactBaselineSyntheticSessionAndHistory']='PASS'
    report['checks']['normalTerminalExitAndPrivateSqliteIntegrity']='PASS'
    def node_probe(name,code):
        probe_command=[NODE,'--import',str(ROOT/'candidates/host/global-runtime.mjs'),'--input-type=module','-e',code]
        result=subprocess.run(probe_command,cwd=ROOT/'candidates/provider',
            env=os.environ,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=20)
        (STATE/(name+'.log')).write_text(result.stdout)
        assert result.returncode==0,(name,result.returncode,result.stdout)
        report.setdefault('nodeProbes',{})[name]={'command':probe_command,
            'exitCode':0,'logSha256':hashlib.sha256(result.stdout.encode()).hexdigest(),'result':json.loads(result.stdout)}
    stores_before=sorted(str(p) for p in STATE.rglob('*.sqlite'))
    node_probe('missing-socket',f'''
import assert from 'node:assert/strict';
import {{PassThrough}} from 'node:stream';
import {{runSharedHost}} from '{ROOT}/candidates/provider/src/runner/shared-host.ts';
let emitted=0;
await assert.rejects(runSharedHost('/bb0-state/not-present.sock','/bb0-state/work',new PassThrough(),()=>emitted++,()=>emitted++),/ENOENT/);
assert.equal(emitted,0);
console.log(JSON.stringify({{error:'ENOENT',emittedFrames:emitted}}));
''')
    assert sorted(str(p) for p in STATE.rglob('*.sqlite'))==stores_before,'Missing socket created a fallback SQLite'
    report['checks']['candidateMissingSocketFailsExplicitlyWithoutLocalHarness']='PASS'
    node_probe('synthetic-mcp-guard',f'''
import assert from 'node:assert/strict';
import {{Type}} from 'typebox';
import {{adaptExtensionTool}} from '{ROOT}/candidates/provider/src/runner/tool-adapter.ts';
let effects=0,guardCalls=0;
const fixture={{name:'mcp_bb0_synthetic_fixture',description:'Private guard probe',parameters:Type.Object({{deny:Type.Boolean()}}),
 execute:async()=>{{effects++;return {{content:[{{type:'text',text:'allowed-control'}}]}}}}}};
const policy={{hasHandlers:type=>type==='tool_call',emitToolCall:async event=>{{guardCalls++;return event.input.deny?{{block:true,reason:'bb0-synthetic-denied'}}:undefined}}}};
const adapted=adaptExtensionTool(fixture,async()=>{{throw Error('Unexpected nested execution')}},undefined,()=>policy);
const blocked=await adapted.execute({{deny:true}},{{callId:'bb0-denied',output:()=>{{}}}},{{}});
assert.equal(blocked.isError,true);assert.match(blocked.output[0].text,/bb0-synthetic-denied/);assert.equal(effects,0);
const deniedEffects=effects;
const allowed=await adapted.execute({{deny:false}},{{callId:'bb0-allowed',output:()=>{{}}}},{{}});
assert.equal(effects,1);assert.equal(guardCalls,2);assert.equal(allowed.isError,undefined);
console.log(JSON.stringify({{guardCalls,deniedSideEffects:deniedEffects,allowedControlSideEffects:effects,
 scope:'Existing candidate MCP/extension tool-call guard bridge with synthetic policy; not live MCP service or Agent Mail authorization'}}));
''')
    report['checks']['adapterSyntheticPolicyBlocksCounter_NOT_Authorization']='PASS'
    node_probe('existing-agent-mail-authorization',f'''
import assert from 'node:assert/strict';
import {{authorizeAgentMail}} from '{ROOT}/candidates/host/packages/coding-agent/src/experimental/durable/mcp.ts';
let effects=0;
const project='/bb0-state/work',actor='BB0Synthetic';
function invoke(name,args) {{authorizeAgentMail(name,args,project,actor);effects++;}}
assert.throws(()=>invoke('send_message',{{project_key:'/bb0-state/foreign',sender_name:actor}}),/project mismatch/);
assert.throws(()=>invoke('send_message',{{project_key:project,sender_name:'ForeignActor'}}),/identity mismatch/);
assert.throws(()=>invoke('force_release_file_reservation',{{project_key:project,agent_name:actor}}),/separate operator approval/);
assert.equal(effects,0);
invoke('send_message',{{project_key:project,sender_name:actor}});
assert.equal(effects,1);
console.log(JSON.stringify({{denials:3,deniedSideEffects:0,allowedControlSideEffects:effects,
 scope:'Existing candidate authorizeAgentMail invoked with synthetic arguments before counter; no real MCP server/network/credential call'}}));
''')
    report['checks']['existingAgentMailAuthorizationDeniesBeforeSyntheticSideEffect']='PASS'
    assert counts=={'reference':31,'candidate':32} and not report['errors'],report['errors']
    report['httpInvocationCounters']=dict(counts)
    report['metricSeparation']='No external model/network inference. Both sides use identical two-chunk local SSE trace: first ALPHA chunk is held until actual shared-wire and native-renderer PTY text bytes are observed, then OMEGA/completion is released. Raw flush/submit/observation timings retained; PTY bytes are not browser/terminal paint. Same host implementation with reference/candidate loaders, no optimization or speedup claim.'
    report['metricSummary']={}
    for side in counts:
        report['metricSummary'][side]={}
        for key in ['attachMs','wireFirstIncrementalTextObservedMs','terminalFirstIncrementalTextBytesObservedMs']:
            values=[row[key] for row in report['samples'] if row['side']==side and row['phase']=='warm']
            ordered=sorted(values)
            report['metricSummary'][side][key]={'count':len(values),'median':statistics.median(values),
                'min':min(values),'max':max(values),'p95NearestRank':ordered[28]}
    report['status']='PASS'
except Exception as error:
    report['error']=f'{type(error).__name__}: {error}'
finally:
    report['finishedUTC']=datetime.now(timezone.utc).isoformat()
    for event in holds.values(): event.set()
    for host in hosts:
        if host.proc.poll() is None:
            report.setdefault('forcedCleanup',[]).append(host.side)
            os.killpg(host.proc.pid,signal.SIGTERM)
            try: host.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(host.proc.pid,signal.SIGKILL)
                host.proc.wait(timeout=5)
            (STATE/(host.side+'-terminal.txt')).write_bytes(host.output)
    if server is not None:
        server.shutdown()
        server.server_close()
    (STATE/'baseline-live-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2),flush=True)
raise SystemExit(0 if report['status']=='PASS' else 1)
