import {
	createMcpExtension,
	type ExtensionFactory,
	type ExtensionRunner,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	defineExtension,
	defineTool,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { sanitizeToolResultForAnthropic } from "./bridge/tool-result-extractor.ts";

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export type NestedToolExecutor = (
	callerId: string,
	name: string,
	args: unknown,
	options?: { signal?: AbortSignal },
) => Promise<{
	toolCall: { type: "toolCall"; id: string; name: string; arguments: unknown };
	result: { content: Array<{ type: "text"; text: string }>; details: unknown };
	isError: boolean;
}>;

/** Safe type guard checking whether an object has an output stream function. */
export function hasOutput(api: unknown): api is { output(text: string): void } {
	return (
		typeof api === "object" &&
		api !== null &&
		"output" in api &&
		typeof (api as { output: unknown }).output === "function"
	);
}

/** Returns the standard built-in extension factories provided by Pi. */
export function createStandardExtensionFactories(): ExtensionFactory[] {
	return [createMcpExtension()];
}

/** Adapts an extension ToolDefinition to a Durable ToolRegistration without type escape hatches. */
export function adaptExtensionTool(
	toolDef: ToolDefinition,
	executeToolFn: NestedToolExecutor,
	createToolContext?: (callId: string) => ExtensionToolContext,
	getExtensionRunner?: () => ExtensionRunner | undefined,
): ToolRegistration {
	const exposure = toolDef.exposure as string | undefined;
	const isDeferred = exposure === "deferred" || exposure === "codemode-deferred";
	const callers =
		exposure === "model-only"
			? (["model"] as const)
			: exposure === "codemode" || exposure === "codemode-deferred"
				? (["tools"] as const)
				: exposure === "hidden"
					? ([] as const)
					: (["model", "tools"] as const);

	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		callers,
		...(isDeferred ? { deferred: true } : {}),
		...(toolDef.outputSchema
			? {
					outputSchema: toolDef.outputSchema as import("typebox").TSchema,
					structuredOutputSchema: toolDef.outputSchema as import("typebox").TSchema,
				}
			: {}),
		async execute(args, api) {
			const runner = getExtensionRunner?.();
			if (runner?.hasHandlers("tool_call")) {
				const hookResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolDef.name,
					toolCallId: api.callId,
					input: (args ?? {}) as Record<string, unknown>,
				});
				if (hookResult?.block) {
					const blockContent = [{ type: "text" as const, text: `Tool execution blocked: ${hookResult.reason ?? "policy"}` }];
					return {
						output: blockContent,
						isError: true,
					};
				}
			}

			const ctx = createToolContext
				? createToolContext(api.callId)
				: ({
						tools: [],
						executeTool: async (name: string, nestedArgs: unknown, options?: { signal?: AbortSignal }) =>
							executeToolFn(api.callId, name, nestedArgs, options),
					} as unknown as ExtensionToolContext);

			try {
				const result = await toolDef.execute(
					api.callId,
					args,
					undefined,
					(update) => {
						if (update?.content && hasOutput(api)) {
							const textChunks = update.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
							if (textChunks.length > 0) api.output(textChunks);
						}
					},
					ctx,
				);

				if (runner?.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: toolDef.name,
						toolCallId: api.callId,
						input: (args ?? {}) as Record<string, unknown>,
						content: result.content,
						details: (result.details ?? undefined) as JsonValue | undefined,
						isError: result.isError ?? false,
					});
				}

				const sanitizedOutput = sanitizeToolResultForAnthropic(
					result.content as Array<import("@earendil-works/pi-ai").TextContent | import("@earendil-works/pi-ai").ImageContent>,
					result.isError,
				);
				return {
					output: sanitizedOutput,
					isError: result.isError,
					details: (result.details ?? undefined) as JsonValue | undefined,
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				const errorContent = [{ type: "text" as const, text: message }];
				if (runner?.hasHandlers("tool_result")) {
					await runner.emitToolResult({
						type: "tool_result",
						toolName: toolDef.name,
						toolCallId: api.callId,
						input: (args ?? {}) as Record<string, unknown>,
						content: errorContent,
						details: undefined,
						isError: true,
					});
				}
				return {
					output: errorContent,
					isError: true,
				};
			}
		},
	});
}

/** Installs adapted tools as a dynamic extension into the Durable Registry. */
export function installExtensionTools(registry: Registry, tools: ToolRegistration[]): void {
	if (tools.length === 0) return;
	registry.install(defineExtension({ name: "extension-tools", tools }));
}
