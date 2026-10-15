import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	ModelRuntime,
	type Extension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { adaptExtensionTool, installExtensionTools } from "../src/runner/tool-adapter.ts";

export interface CodemodeHarness {
	runner: any;
	codemodeTool: any;
	env: NodeExecutionEnv;
	tmpDir: string;
	ctx: any;
	execCode: (code: string, callId?: string) => Promise<{
		content: any[];
		text: string;
		isError: boolean;
		details: any;
		raw: any;
	}>;
	cleanup: () => Promise<void>;
}

export async function createCodemodeTestHarness(): Promise<CodemodeHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-coverage-"));
	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const registry = createRegistry();
	registry.install(CodingTools);

	const codemodeDurableExt = createCodemodeExtension({
		sandbox: new CodemodeSandbox(),
		namespaces: [{ name: "mcp__test", prefix: "mcp__test__", description: "Mock test service" }],
	});
	registry.install(codemodeDurableExt);

	let runner: any;
	const executeToolFn = createNestedToolExecutor(registry, () => runner, () => env);

	const syncToolsToRegistry = () => {
		const createToolContext = (callId: string) => runner.createToolContext(callId, undefined);
		const adapted = runner.getAllRegisteredTools().map((t: any) =>
			adaptExtensionTool(t.definition, executeToolFn, createToolContext, () => runner),
		);
		installExtensionTools(registry, adapted);
	};

	const mockMcpToolDef: ToolDefinition = {
		name: "mcp__test__greet",
		description: "Greet a user by name",
		parameters: Type.Object({ name: Type.String() }),
		exposure: "codemode",
		namespace: { name: "mcp__test", description: "Mock test service" },
		execute: async (_callId, params: any) => ({
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
		}),
	};

	const mockMcpExt: Extension = {
		name: "mock-mcp-service",
		path: "inline:mock-mcp-service",
		tools: new Map([["mcp__test__greet", { definition: mockMcpToolDef, sourceInfo: { path: "mock" } as any }]]),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	runner = await setupExtensionRunner({
		extensions: [mockMcpExt],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
		cwd: tmpDir,
		modelRuntime: await ModelRuntime.create(),
		executeToolFn,
		getCallableTools: () => {
			const map = new Map<string, any>();
			for (const t of registry.snapshot().tools()) {
				map.set(t.tool.name, {
					name: t.tool.name,
					description: (t.tool as any).description ?? "",
					parameters: t.tool.parameters,
				});
			}
			for (const t of runner?.getAllRegisteredTools() ?? []) {
				map.set(t.definition.name, { ...t.definition, sourceInfo: t.sourceInfo });
			}
			return Array.from(map.values());
		},
		onToolsChanged: syncToolsToRegistry,
	});

	syncToolsToRegistry();

	const codemodeTool = registry.snapshot().tools().find((t: any) => t.tool.name === "codemode")?.tool;
	const ctx = runner.createToolContext("harness-call-id", undefined);
	const docs = new Map<string, any>();
	let callCounter = 0;

	const createToolExecutionApi = (taskId: string) => ({
		taskId,
		conversationId: "harness-session-1",
		env,
		async agent(_agentCtx: any) {
			return {
				callable: registry.snapshot().tools().map((t: any) => t.tool),
			};
		},
		async commit(fn: any, _commitCtx: any) {
			const tx = {
				async doc(token: any, id: string) {
					const key = `${token.definition.kind}:${id}`;
					if (!docs.has(key)) docs.set(key, token.definition.initial ? token.definition.initial() : {});
					return docs.get(key);
				},
			};
			return await fn(tx);
		},
		async executeTool(name: string, args: unknown, toolCtx: any, _options?: any) {
			const target = registry.snapshot().tools().find((t: any) => t.tool.name === name)?.tool;
			if (!target) {
				return {
					isError: true,
					diagnostics: [{ severity: "error" as const, message: `Tool ${name} not found` }],
				};
			}
			let toolOutput = "";
			const toolApi = {
				callId: `nested-${name}-${++callCounter}`,
				env,
				output: (t: string) => { toolOutput += t; },
				retainedOutput: () => ({ text: toolOutput, truncated: false }),
			};
			try {
				const res = await target.execute(args, toolApi, toolCtx);
				const isError = res.isError ?? false;
				const structuredOutput =
					isError
						? undefined
						: (res.structuredOutput !== undefined ? res.structuredOutput : (res.output ?? toolOutput));
				const diagnostics =
					res.diagnostics ??
					(isError
						? [{ severity: "error" as const, message: String(res.output?.[0]?.text ?? "Command exited with code 42") }]
						: []);
				return {
					structuredOutput,
					isError,
					diagnostics,
				};
			} catch (err: any) {
				return {
					isError: true,
					diagnostics: [{ severity: "error" as const, message: err?.message || String(err) }],
				};
			}
		},
	});

	const execCode = async (code: string, callId?: string) => {
		const id = callId ?? `exec-${++callCounter}`;
		const api = createToolExecutionApi(id);
		const raw = await codemodeTool.execute({ code }, api, BACKGROUND_CONTEXT);
		const content = (raw.output ?? []) as any[];
		const text = content.map((c: any) => c.text ?? "").join("\n");
		return {
			content,
			text,
			isError: !!raw.isError,
			details: raw.details,
			raw,
		};
	};

	const cleanup = async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await env.cleanup(BACKGROUND_CONTEXT);
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return { runner, codemodeTool, env, tmpDir, ctx, execCode, cleanup };
}
