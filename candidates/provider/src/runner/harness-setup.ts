import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
export type { ModelThinkingLevel };
import {
	createRegistry,
	type EnvTarget,
	type HarnessSettings,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools, CodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { Subagent } from "./subagent.ts";
import {
	type ModelRuntime,
	type SettingsManager,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { createPiPrompt, type PromptOptions } from "./prompt.ts";

export function configureHarnessHttp(settingsManager: SettingsManager): void {
	const proxy = settingsManager.getGlobalSettings()?.httpProxy?.trim();
	if (proxy) {
		process.env.HTTP_PROXY ??= proxy;
		process.env.HTTPS_PROXY ??= proxy;
	}
}

export function createHarnessSettings(
	settingsManager: SettingsManager,
	getActiveModel?: () => { provider: string; modelId: string } | undefined,
): HarnessSettings {
	return {
		get stream() {
			const provider = settingsManager.getProviderRetrySettings?.() ?? {};
			const idle = settingsManager.getHttpIdleTimeoutMs?.() ?? 300_000;
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get compaction() {
			const active = getActiveModel?.();
			const model = active
				? { provider: active.provider, id: active.modelId }
				: (() => {
						const p = settingsManager.getDefaultProvider();
						const m = settingsManager.getDefaultModel();
						return p && m ? { provider: p, id: m } : undefined;
					})();
			return settingsManager.getCompactionSettings?.(model) ?? {};
		},
		get retry() {
			return settingsManager.getRetrySettings?.() ?? {};
		},
		get steeringMode() {
			return settingsManager.getSteeringMode?.() ?? "immediate";
		},
		get followUpMode() {
			return settingsManager.getFollowUpMode?.() ?? "queue";
		},
	};
}

export async function createCodingRegistry(
	settingsManager: SettingsManager,
	cwd: string,
	promptOptions?: PromptOptions,
): Promise<Registry> {
	const registry = createRegistry();
	let codingTools = CodingTools;
	try {
		const images = await createNodePhotonImages();
		codingTools = createCodingTools({ images });
	} catch (err) {
		console.warn("[HarnessSetup] Photon image processor fallback to basic tools:", err);
	}
	registry.install(codingTools);
	registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
	registry.install(createToolSearchExtension());
	registry.install(Subagent);
	registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
	return registry;
}

export class ExecutionEnvs {
	readonly #defaultCwd: string;
	readonly #envs = new Map<string, NodeExecutionEnv>();

	constructor(defaultCwd: string) {
		this.#defaultCwd = defaultCwd;
	}

	readonly env = ({ cwd = this.#defaultCwd }: EnvTarget): NodeExecutionEnv => {
		let env = this.#envs.get(cwd);
		if (env === undefined) {
			env = new NodeExecutionEnv({ cwd });
			this.#envs.set(cwd, env);
		}
		return env;
	};

	async cleanup(context: Context): Promise<void> {
		const envs = [...this.#envs.values()];
		this.#envs.clear();
		for (const env of envs) await env.cleanup(context);
	}
}

export interface InitialModel {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly fallbackMessage?: string;
}

export async function findInitialAgentModel(
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	cli?: { readonly provider?: string; readonly model: string; readonly thinking?: ModelThinkingLevel },
): Promise<InitialModel> {
	if (cli !== undefined) {
		const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
		if (resolved.error !== undefined || resolved.model === undefined) {
			throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
		}
		return {
			model: { provider: resolved.model.provider, modelId: resolved.model.id },
			thinkingLevel: cli.thinking ?? resolved.thinkingLevel ?? "off",
		};
	}

	const defaultProvider = settingsManager.getDefaultProvider?.();
	const defaultModelId = settingsManager.getDefaultModel?.();
	const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel?.() as ModelThinkingLevel;

	if (defaultProvider && defaultModelId) {
		const models = modelRuntime.getAvailableSnapshot();
		const matched = models.find((m) => m.provider === defaultProvider && m.id === defaultModelId);
		if (matched) {
			return {
				model: { provider: matched.provider, modelId: matched.id },
				thinkingLevel: defaultThinkingLevel ?? "off",
			};
		}
	}

	const available = modelRuntime.getAvailableSnapshot();
	if (available.length > 0) {
		return {
			model: { provider: available[0].provider, modelId: available[0].id },
			thinkingLevel: "off",
		};
	}

	return {};
}
