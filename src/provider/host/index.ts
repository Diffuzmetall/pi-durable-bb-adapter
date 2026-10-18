import {
	experimental_defineHostEntry,
	experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { ProviderBridge } from "../../projection/host/bridge.ts";
import { sdkOperatorDirectory } from "../../bootstrap/operator-profile.ts";

let bridge: ProviderBridge | undefined;

let isShuttingDown = false;
export async function teardown(exitCode = 0): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	try {
		await bridge?.shutdown();
	} catch (err) {
		console.error("[HostWorker] Error during bridge shutdown:", err);
	} finally {
		process.exit(exitCode);
	}
}

process.on("disconnect", () => {
	void teardown(0);
});

process.on("SIGTERM", () => {
	void teardown(0);
});

process.on("SIGINT", () => {
	void teardown(0);
});

export const experimental_providerBridge = experimental_defineProviderBridge({
	start(context) {
		if (bridge) throw new Error("BB_OPERATOR_SDK_START_ONCE");
		const operatorDataDir = sdkOperatorDirectory(context); // Immutable normal worker context, never a wire option.
		bridge = new ProviderBridge(line => process.stdout.write(line), undefined, operatorDataDir);
	},
	handleLine: (line: string) => {
		if (!bridge) throw new Error("BB_OPERATOR_SDK_START_REQUIRED");
		void bridge.handleLine(line);
	},
	onClose: () => {
		void teardown(0);
	},
	onSigterm: () => {
		void teardown(0);
	},
	onSigint: () => {
		void teardown(0);
	},
});

export default experimental_defineHostEntry({
	contract: experimental_nativeRootsHostContract,
	handlers: {
		resolveNativeRoots: () => {
			return { skills: [] };
		},
	},
});
