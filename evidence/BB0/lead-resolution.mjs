import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = resolve(root, 'candidate-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath));
const names = ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord/context', '@earendil-works/pi-codemode', '@earendil-works/pi-coding-agent', '@earendil-works/pi-durable/mcp-codemode'];
const code = `const names=${JSON.stringify(names)}; console.log('BB0_RESOLUTION='+JSON.stringify(names.map(name=>{try{return {name,url:import.meta.resolve(name)}}catch(e){return {name,error:e.message}}})))`;
manifest.resolution = [];
for (const [label, cwdKey, cwd, loader] of [
  ['managedProvider', 'managed-provider', manifest.sources.provider.donor],
  ['candidateProvider', 'provider', manifest.sources.provider.candidate],
  ['managedHost', 'managed-host', manifest.sources.host.donor, '/home/ubuntu/.local/share/pi-durable/global-runtime.mjs'],
  ['candidateHost', 'host', manifest.sources.host.candidate, manifest.hostLoader.candidate],
]) {
  const args = [resolve(root, 'evidence/BB0/lead-sandbox.py'), '--cwd', cwdKey, '--', process.execPath,
    ...(loader ? ['--import', loader] : []), '--input-type=module', '-e', code];
  const run = spawnSync('/usr/bin/python3', args, { encoding: 'utf8', env: {PATH:'/usr/bin:/bin', LANG:'C.UTF-8'}, maxBuffer: 4 * 1024 * 1024 });
  const log = `evidence/BB0/lead-resolution-${label}.log`;
  writeFileSync(resolve(root, log), run.stdout + run.stderr);
  if (run.status !== 0) throw new Error(`${label}: ${run.stderr}`);
  const resultLine = run.stdout.split('\n').find(line => line.startsWith('BB0_RESOLUTION='));
  if (!resultLine) throw new Error(`${label}: missing sandboxed resolution output`);
  const modules = JSON.parse(resultLine.slice('BB0_RESOLUTION='.length)).map(row => {
    if (!row.url?.startsWith('file:')) return row;
    const path = realpathSync(fileURLToPath(row.url));
    return {...row, realpath: path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex')};
  });
  manifest.resolution.push({label, cwd, loader, command: ['/usr/bin/python3', ...args], exitCode:run.status, log, isolation:'lead-sandbox.py clearenv + read-only donor mounts', modules});
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.resolution, null, 2));
