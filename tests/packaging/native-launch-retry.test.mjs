import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {nativeRootFor} from '../../src/bootstrap/native-runtime.ts';
import {digest} from '../../src/bootstrap/native-runtime-config.ts';
import {stableRootProviderId} from '../../src/bootstrap/provider-grant.ts';

test('a failed CLI launch cannot poison a subsequent launch with stale diagnostics', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-native-launch-test-'));
 const save=async(path,value,mode=0o600)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value),{mode});
 const cli=join(dir,'cli.mjs'),extension=join(dir,'after-local-host.mjs'),manifest=join(dir,'manifest.json');
 const helper=resolve('scripts/native-pty.py');
 await save(extension,'// no native SDK or Harness is executed by this transport fixture\n');
 await save(cli,`#!/usr/bin/env node
import{createServer}from'node:net';import{appendFileSync,existsSync,writeFileSync,mkdirSync,chmodSync}from'node:fs';import{join}from'node:path';
appendFileSync(join(process.cwd(),'pids'),process.pid+'\\n');
if(!existsSync('attempted')){writeFileSync('attempted','1');console.error('intentional first launch failure');process.exit(1);}
const socket=process.argv[process.argv.indexOf('--listen')+1],directory=join(process.cwd(),'fake-native-session');mkdirSync(directory,{mode:0o700});
const server=createServer(c=>{let b='';c.on('data',x=>{b+=x;let i;while((i=b.indexOf('\\n'))>=0){const f=JSON.parse(b.slice(0,i));b=b.slice(i+1);c.write(JSON.stringify({type:'response',id:f.id,success:true,data:{session:{id:'fake-native',directory,cwd:process.cwd()}}})+'\\n');}});});
server.listen(socket,()=>{chmodSync(socket,0o600);writeFileSync(process.env.PI_DURABLE_BB_READY,JSON.stringify({protocol:'bb-native-ready/v1',sdk:'1.3.0',pid:process.pid,directory,tools:[],extensions:[]}),{mode:0o600});});
`,0o700);
 for(const name of ['pi-durable','pi-ai','chord']){
  const p=join(dir,'node_modules/@earendil-works',name);await mkdir(p,{recursive:true,mode:0o700});await save(join(p,'package.json'),{name:'@earendil-works/'+name,version:'1.3.0'});
 }
 await save(manifest,{global:extension,sdkRoot:join(dir,'node_modules'),outputSHA256:digest(await readFile(extension)),prerequisites:{}});
 await mkdir(join(dir,'native-runtime'),{mode:0o700});
 await save(join(dir,'native-runtime/runtime.json'),{protocol:'bb-native-runtime/v1',cli,cliSHA256:digest(await readFile(cli)),manifest,manifestSHA256:digest(await readFile(manifest)),helper,helperSHA256:digest(await readFile(helper)),env:{}});
 const id=stableRootProviderId('thr_fixture_retry'),proof={providerId:'pi-durable',threadId:'thr_fixture_retry',providerThreadId:id,parentThreadId:null};
 try{
  await assert.rejects(nativeRootFor(dir,proof,id,dir),/NATIVE_ROOT_START_FAILED/);
  const result=await nativeRootFor(dir,proof,id,dir);
  assert.equal(result.selected.session.id,'fake-native');
  const record=JSON.parse(await readFile(join(dir,'native-roots/thr_fixture_retry/root.json'),'utf8'));
  const diagnostics=(await readdir(record.privateDir)).filter(p=>p.includes('startup-failure'));
  assert.equal(diagnostics.length,1,'Prior failed-start diagnostics are preserved, not reused');
 }finally{
  // Catch a late fixture start even on the pre-fix red path; only this test's recorded CLIs.
  await new Promise(r=>setTimeout(r,300));
  const pids=(await readFile(join(dir,'pids'),'utf8')).trim().split('\n').map(Number);
  for(const pid of pids)try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
});
