import {parseArgs,isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,realpath,chmod,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {nativeConfigPath,digest,checkedNativeRuntime,verifyNativeRuntime} from '../src/bootstrap/native-runtime-config.ts';
import {provisionPrivateOperatorFile} from '../src/bootstrap/operator-profile.ts';
import {readPrivateOwnerJson} from '../src/bootstrap/owner-grant.ts';
const {values}=parseArgs({options:{'operator-dir':{type:'string'},cli:{type:'string'},prepared:{type:'string'},'agent-dir':{type:'string'}}});
if(!values['operator-dir']||!values.cli||!values.prepared)throw Error('Usage: node scripts/configure-native.mjs --operator-dir SDK_BRIDGE_DATA_DIR --cli ADMITTED_NATIVE_CLI --prepared PRIVATE_NATIVE_MANIFEST [--agent-dir PRIVATE_AGENT_DIR]');
const dir=resolve(values['operator-dir']),cli=await realpath(values.cli),manifest=await realpath(values.prepared),helper=await realpath(join(import.meta.dirname,'native-pty.py'));
const path=nativeConfigPath(dir),configDir=dirname(path);
if(await mkdir(configDir,{recursive:true,mode:0o700}))await chmod(configDir,0o700);
const env=values['agent-dir']?{PI_CODING_AGENT_DIR:await realpath(values['agent-dir']),PI_AGENT_DIR:await realpath(values['agent-dir'])}:{};
const next={protocol:'bb-native-runtime/v1',cli,cliSHA256:digest(await readFile(cli)),manifest,manifestSHA256:digest(await readFile(manifest)),helper,helperSHA256:digest(await readFile(helper)),env};
await verifyNativeRuntime(next); // Invalid input must never replace the working selection.
let previous;
try{previous=await readPrivateOwnerJson(path);}catch(e){if(e.code!=='ENOENT')throw e;}
if(!previous)await provisionPrivateOperatorFile(path,next);
else if(!isDeepStrictEqual(previous,next)){
 const bytes=Buffer.from(JSON.stringify(previous)+'\n'),backup=path+'.previous-'+digest(bytes);
 try{await writeFile(backup,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||digest(await readFile(backup))!==digest(bytes))throw e;}
 const temporary=path+'.'+randomUUID();await writeFile(temporary,JSON.stringify(next)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);
}
await checkedNativeRuntime(dir);
console.log(JSON.stringify({status:'configured',runtime:'native-cli',sdk:'1.3.0',managedFallback:false,startedHost:false}));
