import assert from 'node:assert/strict';
import {lstat,realpath,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {assertPrivateOwnerParent,readPrivateOwnerJson} from './owner-grant.ts';

async function selectCurrentSession(){
 const {values}=parseArgs({options:{socket:{type:'string'},cwd:{type:'string'},out:{type:'string'}}});
 if(!values.socket||!values.cwd||!values.out)throw Error('BB_SELECT_ARGUMENTS_REQUIRED');
 const socket=resolve(values.socket),cwd=await realpath(values.cwd),out=resolve(values.out);
 await assertPrivateOwnerParent(socket);await assertPrivateOwnerParent(out);
 const info=await lstat(socket);assert.ok(info.isSocket()&&info.uid===process.getuid?.()&&(info.mode&0o7777)===0o600,'BB_SELECT_PRIVATE_SOCKET_REQUIRED');
 assert.equal(await realpath(socket),socket,'BB_SELECT_CANONICAL_SOCKET_REQUIRED');
 const id=randomUUID(),connection=createConnection(socket);let buffer='';
 const session=await new Promise<unknown>((yes,no)=>{
  const timer=setTimeout(()=>{connection.destroy();no(Error('BB_SELECT_TIMEOUT'));},10000);
  const fail=(error:Error)=>{clearTimeout(timer);connection.destroy();no(error);};
  connection.on('error',fail);connection.on('connect',()=>connection.write(JSON.stringify({id,type:'attach',cwd})+'\n'));
  connection.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536){fail(Error('BB_SELECT_RESPONSE_TOO_LARGE'));return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let response;try{response=JSON.parse(line);}catch{fail(Error('BB_SELECT_RESPONSE_INVALID'));return;}if(response.id!==id)continue;if(response.type!=='response'||response.success!==true||!response.data?.session||typeof response.data.session!=='object'||Array.isArray(response.data.session)){fail(Error('BB_SELECT_RESPONSE_INVALID'));return;}clearTimeout(timer);connection.destroy();yes(response.data.session);return;}});
 });
 const descriptor={protocol:'bb-durable-selected-session/v1',socket,session};
 try{await writeFile(out,JSON.stringify(descriptor)+'\n',{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;assert.deepEqual(await readPrivateOwnerJson(out),descriptor,'BB_SELECT_EXISTING_IDENTITY_CHANGED');}
 console.log(JSON.stringify({status:'selected',descriptor:out,scope:'Existing native session only; no prompt, model or control command sent'}));
}
if(import.meta.main)try{await selectCurrentSession();}catch(error){console.error(JSON.stringify({status:'blocked',error:error instanceof Error&&/^BB_SELECT_[A-Z_]+$/.test(error.message)?error.message:'BB_SELECT_FAILED',action:'Check the selected native socket/CWD and private owned directories. Existing files are not replaced; no host or model was started.'}));process.exitCode=1;}
