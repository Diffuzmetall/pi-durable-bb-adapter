import {
	experimental_defineHostEntry,
	experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { ProviderBridge } from "./bridge.ts";

const bridge = new ProviderBridge((line) => {
	process.stdout.write(line);
});

let isShuttingDown = false;
export async function teardown(exitCode = 0): Promise<void> {
	if (isShuttingDown) return;
	isShuttingDown = true;
	try {
		await bridge.shutdown();
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
	handleLine: (line: string) => {
		bridge.handleLine(line);
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
