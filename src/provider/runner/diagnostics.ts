import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createStandardExtensionFactories, setupExtensionRunner } from "./extension-bridge.ts";
import { getAgentDir } from "./session-storage.ts";
import { resolvePluginVersion } from "../host/installation-manager.ts";
import { getPiDurableVersion } from "./version.ts";
import {
	SUPPORTED_EXTENSION_HOOKS,
	type ExtensionDiagnostic,
	type PiDiagnosticsReport,
	type PiPathStatus,
} from "./diagnostics-types.ts";

export * from "./diagnostics-types.ts";

function checkPath(fullPath: string, type: "file" | "directory", required: boolean): PiPathStatus {
	const exists = existsSync(fullPath);
	let actualType = type;
	if (exists) {
		try {
			const stat = statSync(fullPath);
			actualType = stat.isDirectory() ? "directory" : "file";
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") {
				console.warn(`[Diagnostics] statSync warning for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	return { path: fullPath, exists, type: actualType, required };
}

export async function inspectPiEnvironment(options: { cwd?: string; agentDir?: string } = {}): Promise<PiDiagnosticsReport> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const version = resolvePluginVersion();
	const durableVersion = getPiDurableVersion();

	const paths: Record<string, PiPathStatus> = {
		agentDir: checkPath(agentDir, "directory", true),
		"settings.json": checkPath(join(agentDir, "settings.json"), "file", false),
		"mcp.json": checkPath(join(agentDir, "mcp.json"), "file", false),
		"auth.json": checkPath(join(agentDir, "auth.json"), "file", false),
		"models-store.json": checkPath(join(agentDir, "models-store.json"), "file", false),
		extensions: checkPath(join(agentDir, "extensions"), "directory", false),
		skills: checkPath(join(agentDir, "skills"), "directory", false),
	};

	const settingsManager = SettingsManager.create(cwd, agentDir);
	await settingsManager.reload();
	const globalSettings = settingsManager.getGlobalSettings() ?? {};

	const modelRuntime = await ModelRuntime.create();
	const allModels = modelRuntime.getModels();
	const providers = modelRuntime.getProviders().map((p) => p.id);
	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModel = settingsManager.getDefaultModel();
	const defaultModelAvailable = Boolean(defaultProvider && defaultModel && modelRuntime.getModel(defaultProvider, defaultModel));

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: createStandardExtensionFactories(),
	});
	await resourceLoader.reload();
	const extResult = resourceLoader.getExtensions();

	const extensionItems: ExtensionDiagnostic[] = extResult.extensions.map((ext) => {
		const hooks = Array.from(ext.handlers.keys());
		return {
			path: ext.path,
			resolvedPath: ext.resolvedPath,
			tools: Array.from(ext.tools.keys()),
			commands: Array.from(ext.commands.keys()),
			supportedHooks: hooks.filter((h) => SUPPORTED_EXTENSION_HOOKS.has(h)),
			unsupportedHooks: hooks.filter((h) => !SUPPORTED_EXTENSION_HOOKS.has(h)),
		};
	});

	const skillsRes = resourceLoader.getSkills();
	const skillsList = skillsRes?.skills ?? [];

	let mcpTools: string[] = [];
	let customTools: string[] = [];
	try {
		const runner = await setupExtensionRunner({
			extensions: extResult.extensions,
			runtime: extResult.runtime,
			cwd,
			modelRuntime,
			executeToolFn: async () => ({
				toolCall: { type: "toolCall", id: "probe", name: "probe", arguments: {} },
				result: { content: [], details: {} },
				isError: false,
			}),
		});
		const allTools = runner.getAllRegisteredTools();
		mcpTools = allTools.filter((t) => t.definition.name.startsWith("mcp__")).map((t) => t.definition.name);
		customTools = allTools.filter((t) => !t.definition.name.startsWith("mcp__")).map((t) => t.definition.name);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
	} catch (err) {
		console.warn(`[Diagnostics] Probe runner inspection notice: ${err instanceof Error ? err.message : String(err)}`);
	}

	const systemTools = ["read", "write", "edit", "bash", "subagent", "codemode", "tool_search"];
	const totalTools = systemTools.length + mcpTools.length + customTools.length;

	let status: "healthy" | "warning" | "error" = "healthy";
	const warnings: string[] = [];
	if (!paths.agentDir.exists) {
		status = "error";
		warnings.push("Pi agent directory missing");
	}
	if (!defaultModelAvailable) {
		status = status === "error" ? "error" : "warning";
		warnings.push(defaultModel ? `Configured default model ${defaultModel} is unavailable` : "No default model configured");
	}
	if (extResult.errors.length > 0) {
		status = status === "error" ? "error" : "warning";
		warnings.push(`${extResult.errors.length} extension loading errors`);
	}
	const hasUnsupportedHooks = extensionItems.some((e) => e.unsupportedHooks.length > 0);
	if (hasUnsupportedHooks && status === "healthy") {
		warnings.push("Some extensions use lifecycle hooks not wired in Durable Harness");
	}

	const summary =
		warnings.length === 0
			? `Pi environment operational: ${allModels.length} models, ${extResult.extensions.length} extensions, ${totalTools} tools.`
			: `Pi environment ready with warnings: ${warnings.join("; ")}.`;

	return {
		version,
		durableVersion,
		agentDir,
		paths,
		settings: {
			defaultProvider,
			defaultModel,
			thinkingLevel: settingsManager.getDefaultThinkingLevel(),
			packages: (globalSettings.packages as string[]) ?? [],
			extensions: (globalSettings.extensions as string[]) ?? [],
		},
		models: {
			total: allModels.length,
			providers,
			defaultModelAvailable,
		},
		extensions: {
			total: extResult.extensions.length,
			errors: extResult.errors,
			warnings: extResult.warnings ?? [],
			items: extensionItems,
		},
		skills: {
			total: skillsList.length,
			sample: skillsList.slice(0, 5).map((s) => s.name),
		},
		tools: {
			total: totalTools,
			system: systemTools,
			custom: customTools,
			mcp: mcpTools,
		},
		status,
		summary,
	};
}
