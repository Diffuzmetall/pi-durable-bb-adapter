import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createCodingRegistry } from "../src/runner/harness-setup.ts";

test("createCodingRegistry installs native Subagent tool", async () => {
	const settings = SettingsManager.create(process.cwd());
	const registry = await createCodingRegistry(settings, process.cwd());
	const snapshot = registry.snapshot();
	const subagentTool = snapshot.tools().find((t) => t.tool.name === "subagent");

	assert.ok(subagentTool, "subagent tool must be registered in CodingRegistry");
	assert.equal(subagentTool?.extension.name, "subagent");
});
