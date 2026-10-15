import test from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHarnessSettings } from "../src/runner/harness-setup.ts";

test("createHarnessSettings resolves model-specific compaction override for 300k max window from settings", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
			modelOverrides: {
				"antigravity/gemini-3.8-flash": {
					reserveTokens: 748576,
					keepRecentTokens: 30000,
				},
			},
		},
		defaultProvider: "antigravity",
		defaultModel: "gemini-3.8-flash",
	});

	const getActiveModel = () => ({ provider: "antigravity", modelId: "gemini-3.8-flash" });

	const settings = createHarnessSettings(settingsManager, getActiveModel);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	assert.equal(compaction?.reserveTokens, 748576);
	assert.equal(compaction?.keepRecentTokens, 30000);
	// Effective threshold: 1,048,576 - 748,576 = 300,000
	assert.equal(1048576 - (compaction?.reserveTokens ?? 0), 300000);
});

test("createHarnessSettings uses standard settings when model has no explicit override", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
		},
	});

	const getActiveModel = () => ({ provider: "antigravity", modelId: "claude-sonnet-4-6" });

	const settings = createHarnessSettings(settingsManager, getActiveModel);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	assert.equal(compaction?.reserveTokens, 16384);
	assert.equal(compaction?.keepRecentTokens, 30000);
});

test("createHarnessSettings uses default model from settingsManager when no active model provided", () => {
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 30000,
			modelOverrides: {
				"antigravity/gemini-3.8-flash": {
					reserveTokens: 748576,
					keepRecentTokens: 30000,
				},
			},
		},
		defaultProvider: "antigravity",
		defaultModel: "gemini-3.8-flash",
	});

	const settings = createHarnessSettings(settingsManager);
	const compaction = settings.compaction;

	assert.equal(compaction?.enabled, true);
	assert.equal(compaction?.reserveTokens, 748576);
	assert.equal(compaction?.keepRecentTokens, 30000);
});
