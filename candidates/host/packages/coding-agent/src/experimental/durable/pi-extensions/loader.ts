import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { getAgentDir } from "../../../config.ts";

/** Discover ordinary Pi factories without starting another MCP connector or session. */
export async function loadPiResources(
	cwd: string,
	settingsManager: SettingsManager,
	options: { agentDir?: string; extensionPaths?: string[]; noExtensions?: boolean } = {},
) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: options.agentDir ?? getAgentDir(),
		settingsManager,
		additionalExtensionPaths: options.extensionPaths,
		noExtensions: options.noExtensions,
		extensionFactories: [],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	if (loaded.errors.length) {
		throw new Error(`Pi extension loading failed: ${loaded.errors.map(({ path }) => path).join(", ")}`);
	}
	return { loader, ...loaded };
}
