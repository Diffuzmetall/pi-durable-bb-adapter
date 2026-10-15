import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	getAgentDir,
	resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import { findInitialAgentModel, type ModelThinkingLevel } from "./harness-setup.ts";
import type { CliArgs } from "./cli-args.ts";

export interface RunnerModelSetupResult {
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	scopedModelList: ReturnType<ModelRuntime["getAvailableSnapshot"]>;
	defaultModel: ReturnType<ModelRuntime["getModel"]> | undefined;
	defaultThinkingLevel: ModelThinkingLevel;
	modelScope: {
		scopedModelIds: string[];
		defaultModelId: string | undefined;
	};
}

export async function setupRunnerModels(cwd: string, args: CliArgs): Promise<RunnerModelSetupResult> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const modelRuntime = await ModelRuntime.create();

	// Load extensions and providers (Antigravity, OpenRouter, etc.)
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await resourceLoader.reload();
	const extensionsResult = resourceLoader.getExtensions();

	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
			if (!msg.includes("already registered") && !msg.includes("duplicate")) {
				console.warn(`[ModelSetup] Failed to register provider ${name}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
			if (!msg.includes("already registered") && !msg.includes("duplicate")) {
				console.warn(`[ModelSetup] Failed to register native provider ${provider?.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
		try {
			modelRuntime.registerVirtualModel(definition);
		} catch (err) {
			const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
			if (!msg.includes("already registered") && !msg.includes("duplicate")) {
				console.warn(`[ModelSetup] Failed to register virtual model ${definition?.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	const availableModels = modelRuntime.getAvailableSnapshot();
	const enabledPatterns = settingsManager.getEnabledModels();
	const scopedScope = enabledPatterns && enabledPatterns.length > 0
		? await resolveModelScopeWithDiagnostics(enabledPatterns, modelRuntime)
		: undefined;
	const scopedModelList = scopedScope && scopedScope.scopedModels.length > 0
		? scopedScope.scopedModels.map((sm) => sm.model)
		: availableModels;
	const scopedModelIds = scopedModelList.map((m) => `${m.provider}/${m.id}`);

	const initialAgent = await findInitialAgentModel(
		settingsManager,
		modelRuntime,
		args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : undefined,
	);

	const defaultModel = initialAgent.model
		? modelRuntime.getModel(initialAgent.model.provider, initialAgent.model.modelId) ?? scopedModelList[0]
		: scopedModelList[0];
	const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : undefined;
	const defaultThinkingLevel = (initialAgent.thinkingLevel ?? "off") as ModelThinkingLevel;

	const modelScope = {
		scopedModelIds,
		defaultModelId,
	};

	return {
		settingsManager,
		modelRuntime,
		scopedModelList,
		defaultModel,
		defaultThinkingLevel,
		modelScope,
	};
}
