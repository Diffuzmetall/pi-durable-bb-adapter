import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {findPackageJSON} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),[major,minor]=process.versions.node.split('.').map(Number);
assert.ok(major===24&&minor>=19,'Supported/tested runtime family: Node 24.19+ (24.x)');
assert.ok(process.platform==='linux'&&process.arch==='x64','This beta has only been accepted on Linux x64');
const pkg=JSON.parse(readFileSync(join(root,'package.json'))),sdk={};
const resolutionBases=[import.meta.url,...Object.keys(pkg.dependencies).map(name=>pathToFileURL(join(root,'node_modules',name,'package.json')))];
for(const name of ['chord','pi-agent-core','pi-ai','pi-codemode','pi-coding-agent','pi-durable','pi-mcp','pi-telemetry','pi-tui']){
 const fullName='@earendil-works/'+name;
 let manifest;
 for(const base of resolutionBases){try{manifest=findPackageJSON(fullName,base);if(manifest)break;}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}}
 assert.ok(manifest,'Cannot locate resolved package: '+fullName);
 const p=JSON.parse(readFileSync(manifest));assert.equal(p.name,fullName);assert.equal(p.version,'1.2.0');sdk[name]=p.version;
}
for(const entry of [pkg.bb.server,pkg.bb.host,'dist/runner/index.js','scripts/configure-native.mjs','scripts/native-pty.py'])assert.ok(existsSync(resolve(root,entry)),'Run npm run build: '+entry);
const m=JSON.parse(readFileSync(join(root,'compat/manifest.json'))),actual=createHash('sha256').update(readFileSync(join(root,'compat',m.archive))).digest('hex');assert.equal(actual,m.archiveSHA256,'Compatibility archive changed');
console.log(JSON.stringify({status:'pass',node:process.version,platform:process.platform,providerSdk:sdk,bb:m.bbVersion,compatibilityArchiveVerified:true,scope:'Offline code/dependency check only; no user configuration, credentials, database, host or model accessed'}));
