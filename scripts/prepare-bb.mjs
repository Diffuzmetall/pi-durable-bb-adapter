import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync,lstatSync,statfsSync,realpathSync,cpSync,copyFileSync,renameSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const root=resolve(import.meta.dirname,'..'),manifest=JSON.parse(readFileSync(join(root,'compat/manifest.json')));
const {values}=parseArgs({options:{'bb-app':{type:'string'},out:{type:'string'}}});
if(!values['bb-app'])throw Error('Usage: node scripts/prepare-bb.mjs --bb-app NORMAL_BB_APPLICATION_DIRECTORY [--out PRIVATE_CACHE]. Stages code only; does not restart BB.');
assert.ok(process.platform==='linux'&&process.arch==='x64','BB compatibility archive is accepted only on Linux x64');
const source=realpathSync(values['bb-app']),oldBB=join(source,'node_modules/bb-app'),archive=join(root,'compat',manifest.archive);
assert.ok(existsSync(join(source,'node_modules/.bin/bb-app')),'Expected a normal standalone BB application directory, not a BB data directory');
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(JSON.parse(readFileSync(join(oldBB,'package.json'))).version,manifest.bbVersion,'Unsupported BB version');
assert.equal(sha(archive),manifest.archiveSHA256,'Compatibility archive checksum mismatch');
const before={};for(const[path,pin]of Object.entries(manifest.basePins)){const actual=sha(join(oldBB,path));const overlay=Object.entries(manifest.stagingTargets).find(([,to])=>to===path)?.[0];const prior=manifest.acceptedOverlayInputs?.[path]??[];assert.ok(Array.isArray(prior)&&prior.every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)),'Invalid admitted overlay fingerprints');assert.ok(actual===pin||(overlay&&actual===manifest.outputs[overlay])||prior.includes(actual),'Unsupported BB build: '+path);before[path]=actual;}
const key=createHash('sha256').update(JSON.stringify({archive:manifest.archiveSHA256,source,before})).digest('hex').slice(0,24),cache=resolve(values.out??join(homedir(),'.cache/bb-pi-durable/bb')),directory=join(cache,key),app=join(directory,'app');
function files(dir,prefix=''){const rows={};for(const name of readdirSync(join(dir,prefix)).sort()){const path=prefix?prefix+'/'+name:name;const stat=lstatSync(join(dir,path));if(stat.isDirectory())Object.assign(rows,files(dir,path));else{assert.ok(stat.isFile(),'No symlink in compatibility metadata tree');rows[path]=sha(join(dir,path));}}return rows;}
function validate(){const bb=join(app,'node_modules/bb-app');for(const[from,to]of Object.entries(manifest.stagingTargets))assert.equal(sha(join(bb,to)),manifest.outputs[from],to);assert.deepEqual(files(join(bb,'server/dist/drizzle')),files(join(oldBB,'server/dist/drizzle')),'Migrations differ');}
if(existsSync(join(directory,'receipt.json'))){validate();console.log(readFileSync(join(directory,'receipt.json'),'utf8'));process.exit(0);}
assert.ok(!existsSync(directory),'An incomplete prior stage is retained; choose a fresh --out directory');
const space=statfsSync(dirname(source));assert.ok(space.bavail*space.bsize>1_000_000_000,'At least 1 GB free space required for staging');
mkdirSync(directory,{recursive:true,mode:0o700});const unpack=join(directory,'compat');mkdirSync(unpack,{mode:0o700});
const names=execFileSync('tar',['-tzf',archive],{encoding:'utf8',maxBuffer:2_000_000}).trim().split('\n');for(const name of names)assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'),'Unsafe archive path');
const listing=execFileSync('tar',['-tvzf',archive],{encoding:'utf8',maxBuffer:4_000_000});for(const line of listing.trim().split('\n'))assert.ok(['-','d'].includes(line[0]),'Archive links and special entries are refused');
execFileSync('tar',['-xzf',archive,'-C',unpack]);for(const[path,pin]of Object.entries(manifest.outputs))assert.equal(sha(join(unpack,path)),pin,path);
assert.deepEqual(files(join(unpack,'drizzle')),files(join(oldBB,'server/dist/drizzle')),'No migration is authorized by compatibility staging');
mkdirSync(app,{mode:0o700});for(const name of ['node_modules','package.json','package-lock.json'])if(existsSync(join(source,name)))cpSync(join(source,name),join(app,name),{recursive:true,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});
const bb=join(app,'node_modules/bb-app');for(const[from,to]of Object.entries(manifest.stagingTargets)){mkdirSync(dirname(join(bb,to)),{recursive:true});copyFileSync(join(unpack,from),join(bb,to));}
for(const location of ['server/dist','host-daemon/dist'])cpSync(join(unpack,'node_modules'),join(bb,location,'node_modules'),{recursive:true});
for(const name of ['drizzle','assets'])cpSync(join(unpack,name),join(bb,'server/dist',name),{recursive:true});
for(const[path,pin]of Object.entries(before))assert.equal(sha(join(oldBB,path)),pin,'Original BB application changed during staging');validate();
for(const path of ['server/dist/builtin-skills','app/dist/assets'])assert.ok(existsSync(join(bb,path)),'Normal BB assets missing: '+path);
const receipt={status:'staged',app,entry:join(bb,'dist/bb-app.js'),bbVersion:manifest.bbVersion,archiveSHA256:manifest.archiveSHA256,overlays:Object.keys(manifest.stagingTargets).length,migrationsUnchanged:true,originalApplicationUnchanged:true,liveDataRead:false,hostRestarted:false};
writeFileSync(join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
