import test from "node:test";
import assert from "node:assert/strict";
import { createCodemodeTestHarness, type CodemodeHarness } from "./codemode-fixture.ts";

test("Codemode Full Coverage: end-to-end capabilities suite", async (t) => {
	let harness: CodemodeHarness;

	t.before(async () => {
		harness = await createCodemodeTestHarness();
	});

	t.after(async () => {
		await harness?.cleanup();
	});

	await t.test("a. Pure JS execution: loops, math, promises, return values", async () => {
		const res = await harness.execCode(`
			let sum = 0;
			for (let i = 1; i <= 10; i++) sum += i;
			const sqrtVal = Math.sqrt(sum + 9);
			const delayed = await Promise.resolve(sqrtVal * 2);
			return { sum, sqrtVal, delayed };
		`);
		assert.equal(res.isError, false, `Expected success, got: ${res.text}`);
		assert.ok(res.text.includes('"sum":55'), "Should compute sum 55");
		assert.ok(res.text.includes('"sqrtVal":8'), "Should compute sqrt 8");
		assert.ok(res.text.includes('"delayed":16'), "Should resolve promise to 16");
	});

	await t.test("b. text() global and multiple formatted text entries", async () => {
		const res = await harness.execCode(`
			text("First paragraph entry");
			text("Second paragraph entry");
			return "Final returned value";
		`);
		assert.equal(res.isError, false);
		assert.ok(res.text.includes("==> text 1/3 <==\nFirst paragraph entry"));
		assert.ok(res.text.includes("==> text 2/3 <==\nSecond paragraph entry"));
		assert.ok(res.text.includes("==> text 3/3 <==\nFinal returned value"));
	});

	await t.test("c. console.log, console.warn, and console.error output capture", async () => {
		const res = await harness.execCode(`
			console.log("diagnostic log message");
			console.warn("diagnostic warning message");
			console.error("diagnostic error message");
			return "console test complete";
		`);
		assert.equal(res.isError, false);
		assert.ok(res.text.includes("<console_output>"));
		assert.ok(res.text.includes("diagnostic log message"));
		assert.ok(res.text.includes("diagnostic warning message"));
		assert.ok(res.text.includes("diagnostic error message"));
		assert.ok(res.text.includes("</console_output>"));
	});

	await t.test("d. store(key, value) and load(key) cross-script persistence", async () => {
		const storeRes = await harness.execCode(`
			store("sessionNum", 777);
			store("sessionObj", { role: "admin", tags: ["durable", "pi"] });
			return "stored";
		`);
		assert.equal(storeRes.isError, false);

		const loadRes = await harness.execCode(`
			const num = load("sessionNum");
			const obj = load("sessionObj");
			return { num, obj };
		`);
		assert.equal(loadRes.isError, false);
		assert.ok(loadRes.text.includes('"num":777'));
		assert.ok(loadRes.text.includes('"role":"admin"'));
		assert.ok(loadRes.text.includes('"tags":["durable","pi"]'));
	});

	await t.test("e. searchTools() by keyword and namespace", async () => {
		const res = await harness.execCode(`
			const allGreet = await searchTools("greet");
			const nsGreet = await searchTools("greet", { namespace: "mcp__test" });
			const nsMissing = await searchTools("greet", { namespace: "unknown_ns" });
			return {
				allNames: allGreet.map(t => t.name),
				nsNames: nsGreet.map(t => t.name),
				nsMissingCount: nsMissing.length,
			};
		`);
		assert.equal(res.isError, false);
		assert.ok(res.text.includes('"mcp__test__greet"'));
		assert.ok(res.text.includes('"nsMissingCount":0'));
	});

	await t.test("f. describeTool() and describeNamespace() reflections", async () => {
		const res = await harness.execCode(`
			const toolDesc = await describeTool("mcp__test__greet");
			const nsDesc = await describeNamespace("mcp__test");
			return { toolDesc, nsDesc };
		`);
		assert.equal(res.isError, false);
		assert.ok(res.text.includes("Greet a user by name"));
		assert.ok(res.text.includes("mcp__test__greet(args: { name: string; })"));
		assert.ok(res.text.includes('"name":"mcp__test"'));
		assert.ok(res.text.includes('"tools":["mcp__test__greet"]'));
	});

	await t.test("g. Calling MCP tools via tools.mcp__*", async () => {
		const res = await harness.execCode(`
			const greeting = await tools.mcp__test__greet({ name: "Earendil" });
			return greeting;
		`);
		assert.equal(res.isError, false);
		assert.ok(res.text.includes("Hello, Earendil!"));
	});

	await t.test("h. Calling local system tools via nested executor (bash, write, read, edit)", async () => {
		const res = await harness.execCode(`
			await tools.bash({ command: "echo nested_shell_init > init.txt" });
			const initText = await tools.read({ path: "init.txt" });

			await tools.write({
				path: "doc.txt",
				content: "first line\\nsecond line target\\nthird line",
			});

			await tools.edit({
				path: "doc.txt",
				edits: [{ oldText: "second line target", newText: "second line edited" }],
			});

			const finalText = await tools.read({ path: "doc.txt" });
			return { initText: initText.trim(), finalText };
		`);
		assert.equal(res.isError, false, `Tool execution failed: ${res.text}`);
		assert.ok(res.text.includes('"initText":"nested_shell_init"'));
		assert.ok(res.text.includes('"finalText":"first line\\nsecond line edited\\nthird line"'));
	});

	await t.test("i. Error handling: syntax errors, thrown errors, and tool failures", async () => {
		// 1. Script syntax error
		const resSyntax = await harness.execCode("const invalid_var = ;");
		assert.equal(resSyntax.isError, true);
		assert.ok(resSyntax.text.includes("Script failed"));
		assert.ok(resSyntax.text.includes("SyntaxError"));

		// 2. Thrown error in script
		const resThrow = await harness.execCode('throw new Error("deliberate script failure");');
		assert.equal(resThrow.isError, true);
		assert.ok(resThrow.text.includes("Script failed"));
		assert.ok(resThrow.text.includes("Error: deliberate script failure"));

		// 3. Caught tool error (reading missing file)
		const resCaughtRead = await harness.execCode(`
			try {
				await tools.read({ path: "nonexistent_file.txt" });
				return "unexpected";
			} catch (err) {
				return "caught_read: " + err.message;
			}
		`);
		assert.equal(resCaughtRead.isError, false);
		assert.ok(resCaughtRead.text.includes("caught_read: ENOENT"));

		// 4. Caught tool error (bash non-zero exit code)
		const resCaughtBash = await harness.execCode(`
			try {
				await tools.bash({ command: "exit 42" });
				return "unexpected";
			} catch (err) {
				return "caught_bash: " + (err.message || String(err));
			}
		`);
		assert.equal(resCaughtBash.isError, false);
		assert.ok(
			resCaughtBash.text.includes("caught_bash:") &&
				(resCaughtBash.text.includes('Tool "bash" failed') || resCaughtBash.text.includes("Command exited with code 42")),
		);

		// 5. Uncaught tool error produces failed script result
		const resUncaught = await harness.execCode('await tools.read({ path: "another_missing_file.txt" });');
		assert.equal(resUncaught.isError, true);
		assert.ok(resUncaught.text.includes("Script failed"));
		assert.ok(resUncaught.text.includes("ENOENT"));
	});
});
