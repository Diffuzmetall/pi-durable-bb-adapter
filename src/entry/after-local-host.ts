import { composeBBExtension } from "../extension/entry.ts";
import { withNativeReady } from "../local-host/native-ready.ts";

declare const __BB_ENTRY_REVISION__: string;

// The CLI loads the admitted native local-host first; this adapter must not install it again.
const installBridge = composeBBExtension({
  installNativeGlobal: registry => registry,
  grantPath: process.env.PI_DURABLE_BB_OWNER_GRANT,
  revision: __BB_ENTRY_REVISION__,
});
export default async function installNativeBBBridge(registry: Parameters<typeof installBridge>[0]) {
  return withNativeReady(await installBridge(registry));
}
