import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeChildRegistrationServer} from '../../src/projection/host/native-child-registration-server.ts';
import {registerNativeChildOverSocket} from '../../src/protocol/native-child-rpc.ts';
import {nativeChildTitle} from '../../src/native/child-title.ts';

test('title uses actual native name, role and optional model without control characters',()=>{
 assert.equal(nativeChildTitle('observe-acceptance','reviewer',{provider:'openai-codex',modelId:'gpt-6-luna'}),'observe-acceptance · reviewer · openai-codex/gpt-6-luna');
 assert.equal(nativeChildTitle('smoke','worker'),'smoke · worker');
 const title=nativeChildTitle('🙂\u202e\n'.repeat(500),'reviewer',{provider:'provider',modelId:'x'.repeat(200)});
 assert.ok(title.length<=500);assert.doesNotMatch(title,/[\u202e\n]|\p{Surrogate}/u);
 assert.ok(title.includes(' · reviewer · '));
});

test('pairer publishes one native label, then reuses the durable binding without replaying a title',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'bb-pair-title-')),owner={providerId:'pi-durable',sessionId:'session',parentThreadId:'parent'};
 const state={binding:null,byIdentity:{}},binding={parent:1,key:'key',anchor:10};let calls=0,agentReads=0,seen,forged=false;
 const server=new NativeChildRegistrationServer(scratch,async request=>{calls++;seen=request;return {requestId:request.requestId,conversationId:47,...owner,threadId:'child'};});
 try{
  await server.ready;
  const grant=join(scratch,'owner.json'),handoff=grant+'.registration.json';
  await writeFile(handoff,JSON.stringify({protocol:'bb-durable-registration-handoff/v1',ownerScope:owner,socketPath:server.socketPath,nativeSession:{id:'native',directory:scratch,cwd:scratch}}),{mode:0o600});
  const result=await build({entryPoints:['src/native/native-pair.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'test-native-docs',setup(b){
   b.onResolve({filter:/^@bb-durable\/native-subagents$/},()=>({path:'docs',namespace:'test-native-docs'}));
   b.onLoad({filter:/.*/,namespace:'test-native-docs'},()=>({contents:'export const ChildBindingDoc="child", SubagentsDoc="agents", TeamDoc="team";',loader:'js'}));
   b.onResolve({filter:/^@earendil-works\//},args=>({path:fileURLToPath(import.meta.resolve(args.path)),external:true}));
  }}]});
  const modulePath=join(scratch,'pair.mjs');await writeFile(modulePath,result.outputFiles[0].contents);
  const {bindNativePairer}=await import(pathToFileURL(modulePath).href);
  const session={snapshot:async doc=>doc==='child'?{binding}:doc==='agents'?{agents:{key:{name:'review',role:'reviewer',conversationId:47,ownerTaskId:10,requestId:'request'}}}:doc==='team'?{executions:{run:{child:47,key:'key',requestId:'request'}}}:state,
   commit:async fn=>fn({conversation:async()=>({owner:{conversationId:1,taskId:forged?99:10}}),doc:async()=>state}),
   conversation:async()=>({agent:async()=>{agentReads++;return {model:{provider:'provider',modelId:'model'}};}})};
  const context={abortSignal:new AbortController().signal},pair=await bindNativePairer(session,scratch,{grantPath:grant,ownerScope:owner},context);
  const first=await pair(47,context);assert.equal(seen.title,'review · reviewer · provider/model');assert.equal(calls,1);
  await rename(handoff,handoff+'.saved'); // Existing bindings must not depend on a stale NCR handoff after reopen.
  assert.deepEqual(await pair(47,context),first);assert.equal(calls,1);assert.equal(agentReads,1);
  const foreign=await bindNativePairer(session,scratch,{grantPath:grant,ownerScope:{...owner,sessionId:'foreign'}},context);
  await assert.rejects(foreign(47,context),/PAIR_REFUSED/);
  forged=true;await assert.rejects(pair(47,context),/PAIR_REFUSED/);assert.equal(calls,1);
 }finally{await server.close();}
});

test('native title reaches real registration IPC without becoming receipt identity', async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'bb-title-'));let seen;
 const server=new NativeChildRegistrationServer(scratch,async request=>{
  seen=request;return {requestId:request.requestId,conversationId:request.conversationId,providerId:'pi-durable',sessionId:'session',parentThreadId:'parent',threadId:'child'};
 });
 try{
  await server.ready;
  const receipt=await registerNativeChildOverSocket(server.socketPath,{requestId:'stable',conversationId:47,title:'review · reviewer · gpt-6-luna'});
  assert.equal(seen.title,'review · reviewer · gpt-6-luna');
  assert.equal(receipt.threadId,'child');assert.equal(receipt.title,undefined);
  await assert.rejects(registerNativeChildOverSocket(server.socketPath,{requestId:'bad',conversationId:47,title:123}),TypeError);
 }finally{await server.close();}
});
