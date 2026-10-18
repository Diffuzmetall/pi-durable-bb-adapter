import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'), outputs={}, sources={};
for(const [entry,outfile,external]of [
 ['src/provider/host/index.ts','host/index.mjs',[]],
 ['src/server.ts','server.mjs',[]],
 ['src/provider/runner/index.ts','dist/runner/index.js',['@earendil-works/*','proper-lockfile']],
 ['src/bootstrap/operator-profile-cli.ts','operator/attach-existing-root.mjs',[]],
 ['src/bootstrap/select-session-cli.ts','operator/select-session.mjs',[]],
]){
 const result=await build({absWorkingDir:root,entryPoints:[entry],outfile,bundle:true,write:false,metafile:true,platform:'node',format:'esm',target:'node24',external,banner:{js:'import {createRequire as __packageRequire} from "node:module";const require=__packageRequire(import.meta.url);'}});
 for(const output of result.outputFiles){await mkdir(dirname(output.path),{recursive:true});await writeFile(output.path,output.contents);outputs[relative(root,output.path)]=createHash('sha256').update(output.contents).digest('hex');}
 for(const path of Object.keys(result.metafile.inputs))if(!path.includes('node_modules/'))sources[path]=createHash('sha256').update(await readFile(resolve(root,path))).digest('hex');
}
await mkdir(resolve(root,'dist'),{recursive:true});await writeFile(resolve(root,'dist/build-manifest.json'),JSON.stringify({node:process.version,sources,outputs},null,2)+'\n');
console.log('Built provider, catalog runner, server and existing-root operator');
