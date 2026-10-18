import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),{values}=parseArgs({options:{stage:{type:'string'},'data-dir':{type:'string'},'server-port':{type:'string'},'host-daemon-port':{type:'string'}}});
if(!values.stage||!values['data-dir']||!values['server-port']||!values['host-daemon-port'])throw Error('Usage: node scripts/start-bb.mjs --stage PRIVATE_STAGE_RECEIPT --data-dir ABSOLUTE_BB_DATA --server-port PORT --host-daemon-port PORT. Stop the original BB and its daemon normally when idle first.');
assert.ok(process.platform==='linux'&&process.arch==='x64','BB compatibility launcher is accepted only on Linux x64');
const data=resolve(values['data-dir']);assert.equal(data,values['data-dir'],'Use an absolute canonical BB data directory');
const runtimePath=join(data,'bb-app-runtime.json');
if(existsSync(runtimePath)){
 const runtime=JSON.parse(readFileSync(runtimePath));assert.ok(Number.isInteger(runtime.pid)&&runtime.pid>0,'Cannot verify existing BB ownership');
 let alive=true;try{process.kill(runtime.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}assert.equal(alive,false,'BB is still running; do not create a second owner');
}else if(existsSync(join(data,'bb.db'))){assert.ok(existsSync(join(data,'auth.json')),'Existing database is not a recognized BB data root');}
else if(existsSync(data))assert.deepEqual(readdirSync(data),[],'New BB data directory must be empty');
if(existsSync(join(data,'bb.db')))try{const holders=execFileSync('lsof',['-t','--',join(data,'bb.db')],{encoding:'utf8'}).trim();assert.equal(holders,'','BB database still has an owner');}catch(error){if(error.status!==1)throw error;}
const manifest=JSON.parse(readFileSync(join(root,'compat/manifest.json'))),stage=JSON.parse(readFileSync(values.stage));assert.equal(stage.archiveSHA256,manifest.archiveSHA256);assert.equal(stage.entry,join(stage.app,'node_modules/bb-app/dist/bb-app.js'));
const bb=join(stage.app,'node_modules/bb-app'),sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');assert.equal(sha(stage.entry),manifest.basePins['dist/bb-app.js']);
for(const[from,to]of Object.entries(manifest.stagingTargets))assert.equal(sha(join(bb,to)),manifest.outputs[from],'Compatibility stage changed: '+to);
const ports=[values['server-port'],values['host-daemon-port']].map(value=>{assert.match(value,/^\d+$/);const p=Number(value);assert.ok(p>=1024&&p<=65535,'Use unprivileged ports');return p;});assert.notEqual(ports[0],ports[1]);
for(const port of ports)await new Promise((yes,no)=>{const server=createServer();server.once('error',()=>no(Error('BB/server daemon port is occupied; stop its owner normally before switching')));server.listen(port,'127.0.0.1',()=>server.close(yes));});
mkdirSync(data,{recursive:true,mode:0o700});
const child=spawn(process.execPath,[stage.entry,'--data-dir',data,'--server-bind-host','127.0.0.1','--server-port',String(ports[0]),'--host-daemon-port',String(ports[1])],{stdio:'inherit',env:{...process.env,BB_DATA_DIR:data,BB_SERVER_URL:'http://127.0.0.1:'+ports[0],BB_HOST_DAEMON_PORT:String(ports[1])}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(child.exitCode===null)child.kill(signal);});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
