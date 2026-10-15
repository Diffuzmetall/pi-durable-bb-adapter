// Import-only smoke. No Harness/store/model/settings construction.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const kind = process.argv.at(-1);
assert(['provider', 'host'].includes(kind));
const specs = [
  ['@earendil-works/pi-durable', {'Harness.open':'function', createRegistry:'function'}],
  ['@earendil-works/pi-ai/providers/faux', {fauxProvider:'function'}],
  ['@earendil-works/chord/context', {BACKGROUND_CONTEXT:'object'}],
  ['@earendil-works/pi-codemode', {CodemodeSandbox:'function'}],
  ...(kind === 'host' ? [
    [pathToFileURL(resolve('./packages/coding-agent/src/experimental/durable/shared-server.ts')).href, {listenSharedHost:'function'}],
    [pathToFileURL(resolve('./packages/durable/src/mcp-codemode.ts')).href, {createMcpCodemodeExtension:'function'}],
  ] : [[pathToFileURL(resolve('./src/runner/shared-host.ts')).href, {runSharedHost:'function'}]]),
  ['@earendil-works/pi-coding-agent', {ModelRuntime:'function', SettingsManager:'function', DefaultResourceLoader:'function'}],
];
const results = [];
for (const [specifier, exports] of specs) {
  try {
    const module = await import(specifier);
    for (const [name, type] of Object.entries(exports)) {
      const value = name.split('.').reduce((value, key) => value?.[key], module);
      assert.equal(typeof value, type, name);
    }
    results.push({specifier, exports, result:'PASS'});
  } catch(error) {
    results.push({specifier, result:'FAIL', error:error.stack});
  }
}
const packageVersion = JSON.parse(readFileSync(kind === 'host' ? './packages/coding-agent/package.json' : './package.json', 'utf8')).version;
const passed = results.every(row => row.result === 'PASS');
console.log('BB0_COMPATIBILITY=' + JSON.stringify({kind, packageVersion, result:passed?'PASS':'FAIL', results,
  boundary:'Import/binding availability only. No runtime construction, SQLite, model invocation, settings load, socket, or behavior parity assertion.',
  limitation:kind === 'host' ? 'Local coding-agent support source 1.0.2 with global SDK1.2.0 overlay remains a mixed baseline. Not SDK-aligned or behavior-certified.' : 'Provider uses installed SDK1.2.0 dependency graph; behavior tests remain pending.'}));
process.exitCode = passed ? 0 : 1;
