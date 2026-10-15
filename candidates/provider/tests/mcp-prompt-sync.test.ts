import test from "node:test";
import assert from "node:assert/strict";
import { createPiPrompt, DynamicPromptSections } from "../src/runner/prompt.ts";
import { mountExtensionBridge } from "../src/runner/extension-mount.ts";
import { SettingsManager, ModelRuntime, type Extension } from "@earendil-works/pi-coding-agent";
import { createRegistry } from "@earendil-works/pi-durable";

test("D-17: Dynamic System Prompt renders mcp_servers and dynamic sections from before_agent_start", () => {
	const settings = SettingsManager.inMemory();
	const dynamicSections = new DynamicPromptSections();

	const extension = createPiPrompt(settings, "/test/cwd", { dynamicSections });
	const mcpSection = extension.sections?.find((s) => s.key === "mcp_servers");
	assert.ok(mcpSection, "mcp_servers section must be registered");

	const mockInput = {
		conversationId: "conv_1",
		agent: { cwd: "/test/cwd", tools: [{ name: "read" }] },
	} as any;

	assert.equal(mcpSection.render(mockInput, {} as any), undefined);

	dynamicSections.updateSections({
		mcp_servers: "- gbrain (tool_search): Knowledge engine\n- telegram (direct): Messaging",
		ambient_recall: "User prefers concise answers",
	});

	const renderedMcp = mcpSection.render(mockInput, {} as any) as string;
	assert.ok(renderedMcp.includes("<mcp_servers>"));
	assert.ok(renderedMcp.includes("- gbrain (tool_search)"));
	assert.ok(renderedMcp.includes("</mcp_servers>"));

	const dynamicSection = extension.sections?.find((s) => s.key === "dynamic_sections");
	assert.ok(dynamicSection, "dynamic_sections must be registered");
	const renderedDynamic = dynamicSection.render(mockInput, {} as any) as string;
	assert.ok(renderedDynamic.includes("<ambient_recall>"));
	assert.ok(renderedDynamic.includes("User prefers concise answers"));
	assert.ok(renderedDynamic.includes("</ambient_recall>"));
});

test("D-16: mountExtensionBridge synchronizes direct MCP servers and dynamic sections at boot", async () => {
	let beforeStartCalled = false;
	const dynamicSections = new DynamicPromptSections();
	const registry = createRegistry();

	const mockExtension: Extension = {
		name: "mcp-ext",
		handlers: new Map([
			[
				"before_agent_start",
				[
					async (evt: any) => {
						beforeStartCalled = true;
						evt.systemPromptOptions.sections["mcp_servers"] = "- direct-server (direct)";
					},
				],
			],
		]),
		tools: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	const extensionsResult = {
		extensions: [mockExtension],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
	};

	const reports: unknown[] = [];
	const mounted = await mountExtensionBridge(
		{ cwd: process.cwd(), database: ":memory:", created: true } as any,
		await ModelRuntime.create(),
		extensionsResult as any,
		registry,
		async () => ({ toolCall: {} as any, result: { content: [], details: {} }, isError: false }),
		(err) => reports.push(err),
		dynamicSections,
	);

	assert.equal(beforeStartCalled, true, "before_agent_start must be invoked on boot for direct server sync");
	assert.equal(dynamicSections.getSections().mcp_servers, "- direct-server (direct)");

	await mounted.cleanup();
});
