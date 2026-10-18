import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
	type ExecutionEnvs,
	type ModelThinkingLevel,
} from "./harness-setup.ts";
import { getAgentDir, type SessionLocation } from "./session-storage.ts";
import { Harness, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type OpenDurableOptions, runtimeContext } from "./runtime-types.ts";
import { DynamicPromptSections } from "./prompt.ts";

export interface LoadedHarnessEnvironment {
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	harness: Harness;
	initialModelRef?: ModelRef;
	initialThinkingLevel?: ModelThinkingLevel;
	fallbackMessage?: string;
	pendingReports: unknown[];
	getActiveModel: () => ModelRef | undefined;
	setActiveModelRef: (ref: ModelRef | undefined) => void;
	cleanup?: () => Promise<void>;
	extensionRunner?: import("@earendil-works/pi-coding-agent").ExtensionRunner;
	dynamicSections?: DynamicPromptSections;
	setNoticeForwarder?: (forwarder: (level: "info" | "warning" | "error", message: string) => void) => void;
}

export async function loadHarnessEnvironment(
	location: SessionLocation,
	options: OpenDurableOptions,
	envs: ExecutionEnvs,
): Promise<LoadedHarnessEnvironment> {
	try {
		initTheme();
	} catch (err) {
		console.warn(`[RuntimeLoader] Theme initialization warning: ${err instanceof Error ? err.message : String(err)}`);
	}
	const modelRuntime = await ModelRuntime.create();
	const settingsManager = SettingsManager.create(location.cwd, getAgentDir());
	const resourceLoader = new DefaultResourceLoader({
		cwd: location.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		// BB must not initialize classic Pi extensions or a second MCP/tool owner.
		noExtensions: true,
	});
	await resourceLoader.reload();
	configureHarnessHttp(settingsManager);

	let activeModelRef: ModelRef | undefined;
	const getActiveModel = () => {
		if (activeModelRef) return activeModelRef;
		const p = settingsManager.getDefaultProvider();
		const m = settingsManager.getDefaultModel();
		return p && m ? { provider: p, modelId: m } : undefined;
	};

	const dynamicSections = new DynamicPromptSections();
	const settings = createHarnessSettings(settingsManager, getActiveModel);
	const registry = await createCodingRegistry(settingsManager, location.cwd, {
		...options.prompt,
		resourceLoader,
		dynamicSections,
	});

	const pendingReports: unknown[] = [];
	const report = (error: unknown) => pendingReports.push(error);

	const harness = await Harness.open(
		await openNodeSqliteStorage(location.database),
		{ models: modelRuntime, registry, settings, env: envs.env, onReport: report },
		runtimeContext,
	);

	const initial = location.created
		? await findInitialAgentModel(settingsManager, modelRuntime, options.cli)
		: undefined;
	if (initial?.model) activeModelRef = initial.model;

	return {
		modelRuntime,
		settingsManager,
		harness,
		initialModelRef: initial?.model,
		initialThinkingLevel: initial?.thinkingLevel,
		fallbackMessage: initial?.fallbackMessage,
		pendingReports,
		getActiveModel,
		setActiveModelRef: (ref) => { activeModelRef = ref; },
		dynamicSections,
	};
}
