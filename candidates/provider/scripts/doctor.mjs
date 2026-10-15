#!/usr/bin/env node

import { inspectPiEnvironment } from "../src/runner/diagnostics.ts";

async function main() {
	console.log("\n========================================================");
	console.log("       Pi Durable Doctor & Environment Inspector        ");
	console.log("========================================================\n");

	try {
		const report = await inspectPiEnvironment({ cwd: process.cwd() });

		console.log(`Plugin Version:  v${report.version}`);
		console.log(`Durable Version: v${report.durableVersion}`);
		console.log(`Health Status:   ${report.status.toUpperCase()}`);
		console.log(`Summary:         ${report.summary}\n`);

		console.log("--- 1. Pi Environment & Paths ---");
		console.log(`  agentDir: ${report.agentDir} (${report.paths.agentDir.exists ? "FOUND" : "MISSING"})`);
		for (const [name, p] of Object.entries(report.paths)) {
			if (name === "agentDir") continue;
			console.log(`  ${name.padEnd(18)}: ${p.exists ? "FOUND" : "optional missing"} (${p.path})`);
		}

		console.log("\n--- 2. Models & Settings Parity ---");
		console.log(`  Default Provider:  ${report.settings.defaultProvider ?? "none"}`);
		console.log(`  Default Model:     ${report.settings.defaultModel ?? "none"} (available: ${report.models.defaultModelAvailable})`);
		console.log(`  Default Thinking:  ${report.settings.thinkingLevel ?? "none"}`);
		console.log(`  Active Packages:   ${report.settings.packages.join(", ") || "none"}`);
		console.log(`  Available Models:  ${report.models.total}`);

		console.log(`\n--- 3. Extensions & Compatibility Matrix (${report.extensions.total} loaded) ---`);
		if (report.extensions.errors.length > 0) {
			console.log("  ⚠️ Extension Load Errors:");
			for (const err of report.extensions.errors) {
				console.log(`    - ${err.path}: ${err.error}`);
			}
		}

		for (const ext of report.extensions.items) {
			console.log(`\n  • Extension: ${ext.path}`);
			if (ext.tools.length > 0) console.log(`    Tools:    ${ext.tools.join(", ")}`);
			if (ext.commands.length > 0) console.log(`    Commands: ${ext.commands.join(", ")}`);
			if (ext.supportedHooks.length > 0) {
				console.log(`    ✅ Supported Hooks in Durable:   ${ext.supportedHooks.join(", ")}`);
			}
			if (ext.unsupportedHooks.length > 0) {
				console.log(`    ⚠️  UNSUPPORTED Hooks in Durable: ${ext.unsupportedHooks.join(", ")}`);
			}
		}

		console.log(`\n--- 4. Tools & Skills ---`);
		console.log(`  System Tools (${report.tools.system.length}):    ${report.tools.system.join(", ")}`);
		console.log(`  MCP Tools (${report.tools.mcp.length}):       ${report.tools.mcp.slice(0, 10).join(", ")}${report.tools.mcp.length > 10 ? "..." : ""}`);
		console.log(`  Extension Tools (${report.tools.custom.length}): ${report.tools.custom.join(", ") || "none"}`);
		console.log(`  Skills Discovered:           ${report.skills.total}`);

		console.log("\n========================================================");
		console.log(`Verdict: ${report.status === "healthy" ? "PASSED (Healthy)" : report.status === "warning" ? "WARNINGS DETECTED" : "FAILED (Errors)"}`);
		console.log("========================================================\n");
	} catch (err) {
		console.error("\n❌ Doctor failed with critical exception:", err);
		process.exit(1);
	}
}

main();
