// Keep the existing local TUI/addons, but use the installed npm runtime.
import './packages/coding-agent/src/experimental/source-resolver.ts';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.env.PI_DURABLE_GLOBAL_ROOT;
if (!root) throw new Error('Start through pi-durable: global npm root is required');
const paths = new Map();
for (const name of ['pi-durable', 'pi-ai', 'chord', 'pi-codemode']) {
  const directory = name === 'pi-codemode'
    ? `${root}/@earendil-works/pi-durable/node_modules/@earendil-works/${name}`
    : `${root}/@earendil-works/${name}`;
  const pkg = JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'));
  for (const [key, value] of Object.entries(pkg.exports)) {
    let target = value;
    while (typeof target === 'object' && target !== null) target = target.import ?? target.default;
    if (typeof target !== 'string') throw new Error(`Unsupported export: ${pkg.name}${key}`);
    paths.set(pkg.name + (key === '.' ? '' : key.slice(1)), pathToFileURL(`${directory}/${target}`).href);
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = paths.get(specifier);
    if (url) return { url, shortCircuit: true };
    for (const [pattern, target] of paths) {
      if (!pattern.includes('*')) continue;
      const [prefix, suffix] = pattern.split('*');
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        const match = specifier.slice(prefix.length, suffix ? -suffix.length : undefined);
        return { url: target.replace('*', match), shortCircuit: true };
      }
    }
    // This local MCP adapter is not published in pi-durable 1.2.0.
    if (specifier === '@earendil-works/pi-durable/mcp-codemode') return nextResolve(specifier, context);
    if (['pi-durable', 'pi-ai', 'chord', 'pi-codemode'].some(name =>
      specifier === `@earendil-works/${name}` || specifier.startsWith(`@earendil-works/${name}/`))) {
      throw new Error(`Global runtime does not export ${specifier}; refusing a source-runtime fallback`);
    }
    return nextResolve(specifier, context);
  },
});
