import { rpcContract } from "./src/rpc/contract.ts";
import { inspectPiEnvironment } from "./src/runner/diagnostics.ts";

export { rpcContract };

export default function plugin(bb: any) {
  bb.settings?.define?.({
    hideThinking: {
      type: "boolean",
      label: "Hide thoughts",
      description: "Hide reasoning thought blocks from the timeline entirely.",
      default: false,
    },
  });

  bb.rpc?.register?.(rpcContract, {
    diagnostics_get: async () => {
      const report = await inspectPiEnvironment();
      return { report };
    },
  });

  const provider = bb.providers.register({
    id: "pi-durable",
    displayName: "Pi Durable",
    icon: "./icons/pi-durable.svg",
    deriveProviderOptions(ctx: any) {
      return {
        hideThinking: Boolean(ctx?.settings?.hideThinking ?? false),
      };
    },
    strings: {
      signInHint: "Run `pi` on the machine to sign in.",
      expiredHint: "Your Pi session expired. Run `pi`, then reload.",
      installUrl: "https://pi.dev",
      iconTint: { light: "#10B981", dark: "#10B981" },
    },
    maintenance: { health: true, usage: false, installation: true },
    env: { passthrough: ["BB_PI_DURABLE_BRIDGE_COMMAND", "BB_PI_DURABLE_BRIDGE_ARGS"] },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
    experimental_nativeSkillRoots: {
      user: [".pi/agent/skills", ".agents/skills"],
      project: [".pi/skills", ".agents/skills"],
    },
    experimental_resolvesNativeRoots: true,
    composerActions: [],
  });

  bb.onDispose?.(() => {
    provider.dispose?.();
  });
}
