import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RegistryReader, Harness } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { assertPrivateOwnerParent } from '../bootstrap/owner-grant.ts';

/** Observe the existing native handoff; never open another Harness or execute a task. */
export function withNativeReady(registry: RegistryReader): RegistryReader {
  const path = process.env.PI_DURABLE_BB_READY;
  if (!path) return registry;
  const extension = registry.snapshot().extension('hindsight');
  const controller = extension && Reflect.get(extension, Symbol.for('pi.durable.hindsight.controller'));
  if (!controller || typeof controller.bind !== 'function') throw Error('NATIVE_READY_LIFECYCLE_REQUIRED');
  const original = controller.bind.bind(controller);
  controller.bind = async (host: { session: Harness; directory: string; context: Context }) => {
    const result = await original(host);
    await assertPrivateOwnerParent(path);
    if (dirname(path) !== dirname(process.env.PI_DURABLE_BB_OWNER_GRANT ?? '')) throw Error('NATIVE_READY_SCOPE_REQUIRED');
    const sdk = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@earendil-works/pi-durable')), 'utf8')).version;
    if (sdk !== '1.3.0') throw Error('NATIVE_READY_SDK_13_REQUIRED');
    const root = await host.session.root(host.context), agent = await root.agent(host.context);
    const tools = [...new Set([...agent.tools, ...agent.callable, ...agent.deferred].map(tool => tool.name))];
    await writeFile(path, JSON.stringify({ protocol: 'bb-native-ready/v1', pid: process.pid, sdk,
      directory: host.directory, rootConversationId: root.id, extensions: agent.extensions.map(e => e.name), tools }) + '\n',
      { flag: 'wx', mode: 0o600 });
    return result;
  };
  return registry;
}
