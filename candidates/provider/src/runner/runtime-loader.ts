import {
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	initTheme,
	type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
	configureHarnessHttp,
	createCodingRegistry,
	createHarnessSettings,
	findInitialAgentModel,
	type ExecutionEnvs,
	type ModelThinkingLevel,
} from "./harness-setup.ts";
import { createStandardExtensionFactories } from "./extension-bridge.ts";
import { createNestedToolExecutor, mountExtensionBridge } from "./extension-mount.ts";
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

function logRegError(kind: string, identifier: string, err: unknown): void {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	if (!msg.includes("already registered") && !msg.includes("duplicate")) {
		console.warn(`[RuntimeLoader] Failed to register ${kind} '${identifier}': ${err instanceof Error ? err.message : String(err)}`);
	}
}

function registerPendingProviders(modelRuntime: ModelRuntime, runtime: ExtensionRuntime): void {
	for (const { name, config } of runtime.pendingProviderRegistrations) {
		try { modelRuntime.registerProvider(name, config); } catch (err) { logRegError("provider", name, err); }
	}
	for (const { provider } of runtime.pendingNativeProviderRegistrations) {
		try { modelRuntime.registerNativeProvider(provider); } catch (err) { logRegError("native provider", provider?.id ?? "unknown", err); }
	}
	for (const { definition } of runtime.pendingVirtualModelRegistrations) {
		try { modelRuntime.registerVirtualModel(definition); } catch (err) { logRegError("virtual model", definition?.id ?? "unknown", err); }
	}
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
	const settingsManager = SettingsManager.create(location.cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd: location.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		extensionFactories: createStandardExtensionFactories(),
	});
	await resourceLoader.reload();
	const extensionsResult = resourceLoader.getExtensions();

	registerPendingProviders(modelRuntime, extensionsResult.runtime);
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

	let liveNoticeForwarder: ((level: "info" | "warning" | "error", message: string) => void) | undefined;
	let runnerRef: import("@earendil-works/pi-coding-agent").ExtensionRunner | undefined;
	const executeToolFn = createNestedToolExecutor(
		registry,
		() => runnerRef,
		() => envs.env({ cwd: location.cwd } as unknown as import("@earendil-works/pi-durable").EnvTarget),
	);
	const mounted = await mountExtensionBridge(
		location,
		modelRuntime,
		extensionsResult,
		registry,
		executeToolFn,
		report,
		dynamicSections,
		(level, message) => {
			if (liveNoticeForwarder) {
				liveNoticeForwarder(level, message);
			} else {
				pendingReports.push({ kind: "notice", level, message });
			}
		},
		settingsManager,
	);
	runnerRef = mounted.extensionRunner;

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
		cleanup: mounted.cleanup,
		extensionRunner: mounted.extensionRunner,
		dynamicSections,
		setNoticeForwarder: (forwarder) => {
			liveNoticeForwarder = forwarder;
		},
	};
}
