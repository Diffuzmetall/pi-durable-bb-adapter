import type { Context, JsonValue } from "@earendil-works/chord";
import { type ToolCall, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { type McpClient, type Tool as McpTool, toLlmContent } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { Extension, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";

/** A connected MCP client is owned and closed by the host, not by the extension. */
export interface McpCodemodeOptions {
	readonly client: Pick<McpClient, "listTools" | "callTool">;
	readonly server: string;
	/** Exact MCP tool names approved for exposure. All others remain inaccessible. */
	readonly allowedTools: readonly string[];
	/** Called for every invocation, including each nested script call. Reject by throwing. */
	readonly authorize: (
		tool: McpTool,
		args: Record<string, unknown>,
		api: ToolExecutionApi,
		context: Context,
	) => void | Promise<void>;
	/** Names exposed directly to the model; omitted means all. Others are callable only by tools. */
	readonly directTools?: readonly string[];
	readonly timeoutMs?: number;
}

export async function createMcpCodemodeExtension(options: McpCodemodeOptions): Promise<Extension> {
	return createMultiMcpCodemodeExtension([options], `mcp-codemode-${options.server}`);
}

/** Use Durable's native executor/discovery; retain the admission and identity gate on every MCP tool. */
export async function createMultiMcpCodemodeExtension(
	sources: readonly McpCodemodeOptions[],
	extensionName = "mcp-codemode",
): Promise<Extension> {
	const timeoutMs = sources[0]?.timeoutMs ?? 120_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
		throw new Error("Invalid CodeMode timeoutMs");
	const names = new Set<string>();
	const registrations: ToolRegistration[] = [];
	for (const source of sources) {
		if (!/^[A-Za-z0-9_-]+$/.test(source.server)) throw new Error("Invalid MCP server name");
		if (source.allowedTools.length === 0) throw new Error("At least one MCP tool must be allowed");
		const byName = new Map((await source.client.listTools()).map((tool) => [tool.name, tool]));
		for (const allowedName of source.allowedTools) {
			const tool = byName.get(allowedName);
			if (!tool) throw new Error(`MCP tool ${allowedName} not found`);
			const name = `mcp__${source.server}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_");
			const direct = source.directTools === undefined || source.directTools.includes(tool.name);
			if ((direct && name.length > 64) || names.has(name)) throw new Error(`Invalid or colliding MCP tool name: ${name}`);
			names.add(name);
			const parameters = Type.Unsafe<Record<string, unknown>>({
				...tool.inputSchema, type: "object", properties: tool.inputSchema.properties ?? {},
			});
			registrations.push(defineTool({
				name, description: tool.description ?? `MCP tool ${tool.name}`, parameters,
				structuredOutputSchema: Type.Unsafe(tool.outputSchema ?? {}),
				...(direct ? {} : { callers: ["tools"] as const, deferred: true as const }),
				// Even a read-only server may have acted before a crash; never replay its call automatically.
				replay: "unsafe",
				execute: async (args, api, context) => {
					const validated = validateToolArguments({ name, description: tool.description ?? name, parameters }, {
						type: "toolCall", id: api.callId, name, arguments: args,
					} as ToolCall) as Record<string, unknown>;
					await source.authorize(tool, validated, api, context);
					context.abortSignal?.throwIfAborted();
					const result = await source.client.callTool(tool.name, validated, { signal: context.abortSignal });
					const output = toLlmContent(result);
					return {
						output, isError: result.isError === true,
						// MCP results are JSON-RPC values; native Durable validates the advertised schema.
						...(result.isError ? { diagnostics: [{ severity: "error" as const,
							message: output.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") || `MCP tool ${name} failed` }] }
							: { structuredOutput: (result.structuredContent ?? result) as JsonValue }),
					};
				},
			}));
		}
	}
	const codemode = createCodemodeExtension({
		sandbox: new CodemodeSandbox(),
		// This adapter admits tools, not new paid model/image operations.
		models: false,
	});
	const nativeTools: ToolRegistration[] = (codemode.tools ?? []).map((tool) => ({
		...tool,
		execute: (args, api, context) => {
			// The Harness validated the native tool's code schema before this wrapper.
			const { code, options } = parseCodemodeSource((args as { code: string }).code);
			// The native journal must record a finite deadline, also across recovery.
			const bounded = { timeout_ms: Math.min(options.timeoutMs ?? timeoutMs, timeoutMs),
				...(options.maxOutputTokens === undefined ? {} : { max_output_tokens: options.maxOutputTokens }) };
			return tool.execute({ code: `// @options: ${JSON.stringify(bounded)}\n${code}` }, api, context);
		},
	}));
	return defineExtension({
		name: extensionName,
		tools: [...registrations, ...nativeTools],
		sections: codemode.sections,
	});
}
