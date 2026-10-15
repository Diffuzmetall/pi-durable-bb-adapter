import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExtensionUIContext } from "../src/runner/extension-bridge.ts";

describe("Extension UI Context Safety (Issue #14 Defect 1)", () => {
	it("provides a full SDK-shaped no-op context that prevents TypeError when extensions access ui members", async () => {
		const notices: Array<{ type: string; msg: string }> = [];
		const ui = createExtensionUIContext((type, msg) => {
			notices.push({ type, msg });
		});

		// Standard UI methods that extensions touch (e.g., herdr calling setStatus on session_start)
		assert.doesNotThrow(() => ui.setStatus("git", "main"));
		assert.doesNotThrow(() => ui.setWorkingMessage("Thinking..."));
		assert.doesNotThrow(() => ui.setWorkingVisible(true));
		assert.doesNotThrow(() => ui.setWorkingIndicator());
		assert.doesNotThrow(() => ui.setHiddenThinkingLabel("thought"));
		assert.doesNotThrow(() => ui.setWidget("my_widget", ["line 1", "line 2"]));
		assert.doesNotThrow(() => ui.setFooter(() => undefined));
		assert.doesNotThrow(() => ui.setHeader(() => undefined));
		assert.doesNotThrow(() => ui.setTitle("My Title"));

		const unsubscribe = ui.onTerminalInput(() => {});
		assert.strictEqual(typeof unsubscribe, "function");
		assert.doesNotThrow(() => unsubscribe());

		// Async prompt dialogs
		const selectRes = await ui.select("Choose", ["a", "b"]);
		assert.strictEqual(selectRes, undefined);

		const confirmRes = await ui.confirm("Confirm", "Are you sure?");
		assert.strictEqual(confirmRes, false);

		const inputRes = await ui.input("Enter name");
		assert.strictEqual(inputRes, undefined);

		// Notify forwarding
		ui.notify("Test notice", "warning");
		assert.deepStrictEqual(notices, [{ type: "warning", msg: "Test notice" }]);
	});
});
