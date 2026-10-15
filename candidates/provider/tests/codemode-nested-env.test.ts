import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { adaptExtensionTool, installExtensionTools } from "../src/runner/tool-adapter.ts";
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createCodemodeExtension,
	ModelRuntime,
	type Extension,
} from "@earendil-works/pi-coding-agent";

test("Cycle 85: createNestedToolExecutor passes execution environment to CodingTools", async () => {
	const registry = createRegistry();
	registry.install(CodingTools);

	const tmpDir = os.tmpdir();
	const env = new NodeExecutionEnv({ cwd: tmpDir });

	const executor = createNestedToolExecutor(registry, undefined, () => env);

	const outcome = await executor("call-1", "bash", { command: "echo nested_success" });

	assert.equal(outcome.isError, false, `Expected bash execution to succeed, got error: ${JSON.stringify(outcome.result)}`);
	assert.ok(outcome.result.content.length > 0);
	assert.ok(
		outcome.result.content[0].text.includes("nested_success"),
		`Expected output to contain 'nested_success', got: ${outcome.result.content[0].text}`,
	);

	await env.cleanup(BACKGROUND_CONTEXT);
});

test("Cycle 85: codemode script successfully executes tools.bash and tools.read via nested executor", async () => {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-test-"));
	const testFile = path.join(tmpDir, "hello.txt");
	await fs.writeFile(testFile, "content_from_disk_test", "utf8");

	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const registry = createRegistry();
	registry.install(CodingTools);

	let runner: any;
	const executeToolFn = createNestedToolExecutor(registry, () => runner, () => env);

	const syncToolsToRegistry = () => {
		const createToolContext = (callId: string) => runner.createToolContext(callId, undefined);
		const adapted = runner.getAllRegisteredTools().map((t: any) =>
			adaptExtensionTool(t.definition, executeToolFn, createToolContext, () => runner),
		);
		installExtensionTools(registry, adapted);
	};

	const codemodeFactory = createCodemodeExtension({ mode: "on" });
	const codemodeExt: Extension = {
		name: "codemode",
		path: "inline:codemode",
		tools: new Map(),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	codemodeFactory({
		registerTool: (def: any) => {
			codemodeExt.tools.set(def.name, { definition: def, sourceInfo: { path: "codemode" } as any });
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerToolRenderer: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => ["codemode", "bash", "read"],
		getAllTools: () => runner?.getAllRegisteredTools().map((t: any) => ({
			name: t.definition.name,
			description: t.definition.description,
			parameters: t.definition.parameters,
			promptGuidelines: t.definition.promptGuidelines,
			exposure: t.definition.exposure,
			namespace: t.definition.namespace,
			annotations: t.definition.annotations,
			sourceInfo: t.sourceInfo,
		})) ?? [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => syncToolsToRegistry(),
	} as any);

	runner = await setupExtensionRunner({
		extensions: [codemodeExt],
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

	const codemodeTool = runner.getAllRegisteredTools().find((t: any) => t.definition.name === "codemode");
	assert.ok(codemodeTool, "codemode tool must be registered");

	const ctx = runner.createToolContext("test_call_id", undefined);

	// Test 1: Calling tools.bash from codemode
	const bashResult = await codemodeTool.definition.execute(
		"test_call_1",
		{ code: "const res = await tools.bash({ command: 'echo hello_bash_nested' }); text(res.stdout ?? JSON.stringify(res));" },
		undefined,
		() => {},
		ctx,
	);
	assert.ok(!bashResult.isError, `codemode bash failed: ${JSON.stringify(bashResult)}`);
	const bashText = bashResult.content?.map((c: any) => c.text).join("") ?? "";
	assert.ok(bashText.includes("hello_bash_nested"), `tools.bash should return echoed text: ${bashText}`);

	// Test 2: Calling tools.read from codemode
	const readResult = await codemodeTool.definition.execute(
		"test_call_2",
		{ code: "const res = await tools.read({ path: 'hello.txt' }); text(typeof res === 'string' ? res : (res.output ?? JSON.stringify(res)).map ? res.output.map((c) => c.text).join('') : JSON.stringify(res));" },
		undefined,
		() => {},
		ctx,
	);
	assert.ok(!readResult.isError, `codemode read failed: ${JSON.stringify(readResult)}`);
	const readText = readResult.content?.map((c: any) => c.text).join("") ?? "";
	assert.ok(readText.includes("content_from_disk_test"), `tools.read should return file contents: ${readText}`);

	await runner.emit({ type: "session_shutdown", reason: "quit" });
	await env.cleanup(BACKGROUND_CONTEXT);
	await fs.rm(tmpDir, { recursive: true, force: true });
});
