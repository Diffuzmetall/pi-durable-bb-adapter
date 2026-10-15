// PI_DURABLE_GLOBAL_ROOT=$(npm root -g) node --import ~/.local/share/pi-durable/global-runtime.mjs --test <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager } from '../../../core/settings-manager.ts';
import { loadPiResources } from './loader.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-extension-parity-'));
  const cwd = join(root, 'workspace'), agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true }); await mkdir(agentDir);
  return { root, cwd, agentDir, settings: SettingsManager.inMemory({ packages: [] }) };
}
const source = (name) => `export default function(pi) { pi.registerTool({name:${JSON.stringify(name)},label:'Fixture',description:'Isolated fixture',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'FIXTURE_OK'}],details:{}})}); }`;

test('loads ordinary user and project Pi factories into the same discovery result', async () => {
  const f = await fixture();
  await mkdir(join(f.agentDir, 'extensions'));
  await mkdir(join(f.cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(f.agentDir, 'extensions', 'user.ts'), source('parity_user'));
  await writeFile(join(f.cwd, '.pi', 'extensions', 'project.ts'), source('parity_project'));
  const result = await loadPiResources(f.cwd, f.settings, { agentDir: f.agentDir });
  const names = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.deepEqual(names.sort(), ['parity_project', 'parity_user']);
  assert.ok(!names.includes('codemode') && !names.includes('tool_search'), 'native CodeMode ownership stays separate');
});

test('does not silently publish a partial extension set after a factory error', async () => {
  const f = await fixture();
  const broken = join(f.root, 'broken.ts');
  await writeFile(broken, 'export default function() { throw new Error("fixture failure"); }');
  await assert.rejects(loadPiResources(f.cwd, f.settings, { agentDir: f.agentDir, extensionPaths: [broken] }), /Pi extension loading failed/);
});
