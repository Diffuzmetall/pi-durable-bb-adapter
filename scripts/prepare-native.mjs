import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { build, version } from 'esbuild';
import { selectedNativeOwner } from './native-owner.mjs';
const root=resolve(import.meta.dirname,'..');
const {values}=parseArgs({options:{global:{type:'string'},'sdk-root':{type:'string'},out:{type:'string'}}});
if(!values.global||!values['sdk-root'])throw Error('Usage: node scripts/prepare-native.mjs --global CURRENT_NATIVE_GLOBAL --sdk-root CURRENT_NATIVE_NODE_MODULES [--out PRIVATE_CACHE]');
const global=await realpath(values.global),sdk=await realpath(values['sdk-root']),owner=await selectedNativeOwner(global);
const sha=b=>createHash('sha256').update(b).digest('hex'),prerequisites={};
for(const file of [global,owner.entrypoint])prerequisites[file]=sha(await readFile(file));
for(const name of ['pi-durable','pi-ai','chord']){const file=join(sdk,'@earendil-works',name,'package.json'),bytes=await readFile(file);assert.equal(JSON.parse(bytes).version,'1.3.0','Native bridge requires the admitted SDK 1.3.0');prerequisites[file]=sha(bytes);}
let revision='revision-preflight';
const compile=()=>build({absWorkingDir:root,entryPoints:['src/entry/after-local-host.ts'],outfile:'after-local-host.mjs',bundle:true,write:false,metafile:true,format:'esm',platform:'node',target:'node24',define:{__BB_ENTRY_REVISION__:JSON.stringify(revision)},plugins:[{name:'preserve-native-owner',setup(b){b.onResolve({filter:/^@bb-durable\/native-subagents$/},()=>({path:owner.entrypoint,external:true}));b.onResolve({filter:/^@earendil-works\//},a=>({path:a.path,external:true}));}}]});
const first=await compile(),inputs={};for(const path of Object.keys(first.metafile.inputs)){assert.ok(!path.includes('/packages/durable-subagents/')&&!path.includes('/packages/coding-agent/'),'Do not bundle a second native owner');inputs[path]=sha(await readFile(resolve(root,path)));}
for(const path of ['scripts/prepare-native.mjs','scripts/native-owner.mjs','package.json','package-lock.json'])inputs[path]=sha(await readFile(join(root,path)));
revision='bb-native/v1:'+sha(Buffer.from(JSON.stringify({prerequisites,inputs,toolchain:{node:process.version,esbuild:version}})));
const result=await compile();assert.deepEqual(Object.keys(result.metafile.inputs),Object.keys(first.metafile.inputs));
for(const[path,digest]of Object.entries(inputs))assert.equal(sha(await readFile(resolve(root,path))),digest,'Build input changed');for(const[path,digest]of Object.entries(prerequisites))assert.equal(sha(await readFile(path)),digest,'Native prerequisite changed');
const output=result.outputFiles[0].contents,cache=resolve(values.out??join(homedir(),'.cache/bb-pi-durable/native')),directory=join(cache,revision.split(':').at(-1));
await mkdir(directory,{recursive:true,mode:0o700});
async function immutable(path,bytes){try{await writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(sha(await readFile(path)),sha(bytes),'Refuse to replace an existing native artifact');}}
await immutable(join(directory,'after-local-host.mjs'),output);
await mkdir(join(directory,'node_modules/@earendil-works'),{recursive:true,mode:0o700});for(const name of ['pi-durable','pi-ai','chord']){const target=await realpath(join(sdk,'@earendil-works',name)),link=join(directory,'node_modules/@earendil-works',name);try{await symlink(target,link);}catch(e){if(e.code!=='EEXIST')throw e;assert.equal(await realpath(link),target,'Do not replace SDK dependencies');}}
const manifest={revision,global,sdkRoot:sdk,nativeOwner:owner,prerequisites,inputs,toolchain:{node:process.version,esbuild:version},outputSHA256:sha(output),scope:'After-local-host adapter only; native global and SDK are unchanged; no host/model started'};
await immutable(join(directory,'manifest.json'),Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
console.log(JSON.stringify({status:'prepared',extension:join(directory,'after-local-host.mjs'),manifest:join(directory,'manifest.json'),launchOrder:[global,join(directory,'after-local-host.mjs')],nativeGlobalUnchanged:true}));
