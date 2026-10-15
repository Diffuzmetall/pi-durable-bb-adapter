import {
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	type Extension,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionRuntime,
	type ExtensionUIContext,
	type ModelRuntime,
	type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { NestedToolExecutor } from "./tool-adapter.ts";

export {
	adaptExtensionTool,
	createStandardExtensionFactories,
	hasOutput,
	installExtensionTools,
	type NestedToolExecutor,
} from "./tool-adapter.ts";

export interface SetupExtensionRunnerOptions {
	extensions: Extension[];
	runtime: ExtensionRuntime;
	cwd: string;
	modelRuntime: ModelRuntime;
	executeToolFn: NestedToolExecutor;
	getCallableTools?: () => Array<{ name: string; description: string; parameters: unknown }>;
	onToolsChanged?: () => void;
	onNotice?: (level: "info" | "warning" | "error", message: string) => void;
	settingsManager?: SettingsManager;
}

export function createExtensionUIContext(
	onNotice?: (type: "info" | "warning" | "error", message: string) => void,
): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message: string, type: "info" | "warning" | "error" = "info") => {
			onNotice?.(type, message);
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as any,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {} as any,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: true }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

/** Initializes ExtensionRunner and binds actions and nested tool execution. */
export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	const sessionManager = SessionManager.create(options.cwd);
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	runner.setUIContext(createExtensionUIContext(options.onNotice));

	let activeToolNames: string[] = options.getCallableTools ? options.getCallableTools().map((t) => t.name) : [];
	let sessionName: string | undefined;

	const actions: ExtensionActions = {
		getActiveTools: () => activeToolNames,
		getAllTools: () =>
			runner.getAllRegisteredTools().map((t) => ({
				name: t.definition.name,
				description: t.definition.description,
				parameters: t.definition.parameters,
				promptGuidelines: t.definition.promptGuidelines,
				exposure: t.definition.exposure ?? "direct",
				namespace: t.definition.namespace,
				annotations: t.definition.annotations,
				sourceInfo: t.sourceInfo,
			})),
		getSettings: () => ({
			...(options.settingsManager?.getGlobalSettings() ?? {}),
			...(options.settingsManager?.getProjectSettings() ?? {}),
		}),
		setActiveTools: (toolNames: string[]) => {
			activeToolNames = [...toolNames];
		},
		refreshTools: () => {
			options.onToolsChanged?.();
		},
		getThinkingLevel: () => (options.settingsManager?.getDefaultThinkingLevel?.() ?? "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
		setThinkingLevel: () => {},
		setModel: async () => false,
		getCommands: () => [],
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: (customType: string, data?: unknown) => {
			sessionManager.appendCustomEntry(customType, data);
		},
		setSessionName: (name: string) => {
			sessionName = name;
		},
		getSessionName: () => sessionName,
		setLabel: () => {},
	};

	const contextActions: ExtensionContextActions = {
		getModel: () => {
			const active = options.settingsManager?.getDefaultModel?.();
			const provider = options.settingsManager?.getDefaultProvider?.();
			if (active && provider) {
				const found = options.modelRuntime.getModel(provider, active);
				if (found) return found;
			}
			return options.modelRuntime.getAvailableSnapshot()[0];
		},
		getScopedModels: () => options.modelRuntime.getAvailableSnapshot().map((model) => ({ model })),
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd: options.cwd }),
		executeTool: (callerId: string, name: string, args: unknown, opts?: { signal?: AbortSignal }) =>
			options.executeToolFn(callerId, name, args, opts) as any,
		getCallableTools: () =>
			options.getCallableTools
				? (options.getCallableTools() as any)
				: (runner.getAllRegisteredTools().map((t) => ({
						name: t.definition.name,
						description: t.definition.description,
						parameters: t.definition.parameters,
						promptGuidelines: t.definition.promptGuidelines,
						exposure: t.definition.exposure,
						namespace: t.definition.namespace,
						annotations: t.definition.annotations,
						sourceInfo: t.sourceInfo,
					})) as any),
	};

	runner.bindCore(actions, contextActions);

	await runner.emit({ type: "session_start", reason: "startup" });
	return runner;
}
