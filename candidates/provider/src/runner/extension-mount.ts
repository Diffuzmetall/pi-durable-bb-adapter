import { type DefaultResourceLoader, type ModelRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { Registry } from "@earendil-works/pi-durable";
import { adaptExtensionTool, installExtensionTools, type NestedToolExecutor } from "./tool-adapter.ts";
import { setupExtensionRunner } from "./extension-bridge.ts";
import type { SessionLocation } from "./session-storage.ts";
import { runtimeContext } from "./runtime-types.ts";
import type { DynamicSectionsHolder } from "./prompt.ts";

export interface MountedExtensionBridge {
	readonly extensionRunner?: ExtensionRunner;
	readonly cleanup: () => Promise<void>;
}

export function createNestedToolExecutor(
	registry: Registry,
	getExtensionRunner?: () => ExtensionRunner | undefined,
	getEnv?: () => import("@earendil-works/pi-durable/env").ExecutionEnv | undefined,
): NestedToolExecutor {
	return async (callerId, name, args, options) => {
		const runner = getExtensionRunner?.();
		let target = registry.snapshot().tools().find((t) => t.tool.name === name);

		if (!target && runner) {
			const toolDef = runner.getAllRegisteredTools().find((t) => t.definition.name === name);
			if (toolDef) {
				const ctx = (callId: string) => runner.createToolContext(callId, options?.signal);
				const adapted = adaptExtensionTool(toolDef.definition, createNestedToolExecutor(registry, getExtensionRunner, getEnv), ctx, () => runner);
				installExtensionTools(registry, [adapted]);
				target = registry.snapshot().tools().find((t) => t.tool.name === name);
			}
		}

		if (!target) {
			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} },
				isError: true,
			};
		}

		if (runner?.hasHandlers("tool_call")) {
			const hook = await runner.emitToolCall({
				type: "tool_call",
				toolName: name,
				toolCallId: `${callerId}/nested`,
				parentToolCallId: callerId,
				input: (args ?? {}) as Record<string, unknown>,
			});
			if (hook?.block) {
				return {
					toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
					result: { content: [{ type: "text", text: `Tool execution blocked: ${hook.reason ?? "policy"}` }], details: {} },
					isError: true,
				};
			}
		}

		try {
			const executor = target.tool.execute as (
				args: unknown,
				api: unknown,
				ctx: unknown,
			) => Promise<{ output?: unknown; details?: unknown; isError?: boolean }>;
			let outputText = "";
			const api = {
				callId: `${callerId}/nested`,
				output: (chunk: string | Uint8Array) => {
					outputText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				},
				retainedOutput: () => ({ text: outputText, truncated: false }),
				outputWindow: undefined,
				env: getEnv?.(),
				diagnostic: () => {},
			};
			const res = await executor(args, api, runtimeContext);
			const rawBlocks = res?.output;
			const content = Array.isArray(rawBlocks)
				? (rawBlocks as Array<{ type: "text"; text: string }>)
				: rawBlocks !== undefined
					? [{ type: "text" as const, text: String(rawBlocks) }]
					: [{ type: "text" as const, text: outputText }];

			if (runner?.hasHandlers("tool_result")) {
				await runner.emitToolResult({
					type: "tool_result",
					toolName: name,
					toolCallId: `${callerId}/nested`,
					parentToolCallId: callerId,
					input: (args ?? {}) as Record<string, unknown>,
					content,
					details: res?.details,
					isError: !!res?.isError,
				});
			}

			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content, details: res?.details },
				isError: !!res?.isError,
			};
		} catch (err: unknown) {
			const errorContent = [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }];
			if (runner?.hasHandlers("tool_result")) {
				await runner.emitToolResult({
					type: "tool_result",
					toolName: name,
					toolCallId: `${callerId}/nested`,
					parentToolCallId: callerId,
					input: (args ?? {}) as Record<string, unknown>,
					content: errorContent,
					details: {},
					isError: true,
				});
			}
			return {
				toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args },
				result: { content: errorContent, details: {} },
				isError: true,
			};
		}
	};
}

export async function mountExtensionBridge(
	location: SessionLocation,
	modelRuntime: ModelRuntime,
	extensionsResult: ReturnType<DefaultResourceLoader["getExtensions"]>,
	registry: Registry,
	executeToolFn: NestedToolExecutor,
	report: (err: unknown) => void,
	dynamicSections?: DynamicSectionsHolder,
	onNotice?: (level: "info" | "warning" | "error", message: string) => void,
	settingsManager?: import("@earendil-works/pi-coding-agent").SettingsManager,
): Promise<MountedExtensionBridge> {
	let extensionRunner: ExtensionRunner | undefined;
	try {
		const syncToolsToRegistry = () => {
			if (!extensionRunner) return;
			const adapted = extensionRunner.getAllRegisteredTools().map((t) =>
				adaptExtensionTool(t.definition, executeToolFn, (callId) => extensionRunner!.createToolContext(callId, undefined), () => extensionRunner),
			);
			installExtensionTools(registry, adapted);
		};

		extensionRunner = await setupExtensionRunner({
			extensions: extensionsResult.extensions,
			runtime: extensionsResult.runtime,
			cwd: location.cwd,
			modelRuntime,
			executeToolFn,
			getCallableTools: () => {
				const map = new Map<string, unknown>();
				for (const t of registry.snapshot().tools()) {
					map.set(t.tool.name, { name: t.tool.name, description: (t.tool as { description?: string }).description ?? "", parameters: t.tool.parameters });
				}
				for (const t of extensionRunner?.getAllRegisteredTools() ?? []) {
					map.set(t.definition.name, { ...t.definition, sourceInfo: t.sourceInfo });
				}
				return Array.from(map.values()) as Array<{ name: string; description: string; parameters: unknown }>;
			},
			onToolsChanged: syncToolsToRegistry,
			onNotice,
			settingsManager,
		});

		if (extensionRunner) {
			extensionRunner.onError((err) => {
				report(err);
				onNotice?.("error", `[Extension Error] ${err.extensionPath} (${err.event}): ${err.error}`);
			});
			try {
				const currentTools = registry.snapshot().tools().map((t) => t.tool.name);
				const beforeStart = await extensionRunner.emitBeforeAgentStart(
					{ messageType: "user", prompt: "", images: undefined },
					{ cwd: location.cwd, selectedTools: currentTools, sections: dynamicSections?.getSections() ?? {} },
				);
				if (beforeStart?.systemPromptOptions?.sections && dynamicSections) {
					dynamicSections.updateSections(beforeStart.systemPromptOptions.sections);
				}
			} catch (err) {
				report(err);
			}
		}
		syncToolsToRegistry();
	} catch (error) {
		report(error);
	}

	return {
		extensionRunner,
		cleanup: async () => {
			await extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }).catch((err) => console.warn("[ExtensionBridge] Cleanup session_shutdown:", err));
		},
	};
}
