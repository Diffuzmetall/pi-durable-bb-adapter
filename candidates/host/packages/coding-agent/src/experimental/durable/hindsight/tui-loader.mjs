// node --import ./hindsight/tui-loader.mjs coding-agent-durable/main.ts
// Explicit upstream-source target, matching the operator's existing Durable
// windows. Installed pi-tui 1.0.0 lacks setImageTranscoder required by current
// upstream support code. Never mix source Harness with installed definitions.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const copiedHost = fileURLToPath(new URL('../coding-agent-durable/', import.meta.url));
const upstreamHost = resolve(copiedHost, '../../pi-upstream/packages/coding-agent/src/experimental/durable');
await import(pathToFileURL(resolve(upstreamHost, '../source-resolver.ts')).href);
const upstreamSource = resolve(upstreamHost, '../..');
const prefix = `${upstreamSource}${sep}`;
const copiedPrefix = pathToFileURL(`${copiedHost}${sep}`).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.startsWith(copiedPrefix) || !specifier.startsWith('../../')) return nextResolve(specifier, context);
    const target = resolve(upstreamHost, specifier);
    if (!target.startsWith(prefix) || !existsSync(target)) throw new Error(`Unsupported copied-host import: ${specifier}`);
    return { url: pathToFileURL(target).href, shortCircuit: true };
  },
});
