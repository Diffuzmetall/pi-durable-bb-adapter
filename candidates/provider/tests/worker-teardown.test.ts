import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerProcess } from "../src/host/runner-process.ts";

describe("Worker Teardown and Graceful Termination (Cycle 71, AP-027)", () => {
	it("sends SIGTERM upon RunnerProcess.kill() allowing graceful exit", async () => {
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;

		const runner = new RunnerProcess({
			cwd: process.cwd(),
			args: ["--no-session"],
			onExit: (code, signal) => {
				exited = true;
				exitCode = code;
				exitSignal = signal;
			},
		});

		const child = (runner as any).child;
		assert.ok(child.pid);

		// Wait briefly for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 200));

		runner.kill();

		// Wait for exit
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && !exited) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.equal(exited, true, "runner must exit after kill()");
		assert.equal(runner.exited, true, "runner.exited must be true");
		assert.ok(
			child.signalCode === "SIGTERM" || child.exitCode === 0 || exitSignal === "SIGTERM" || exitCode === 0,
			`process must terminate by SIGTERM or exit code 0, got signal=${child.signalCode ?? exitSignal}, code=${child.exitCode ?? exitCode}`,
		);
	});

	it("escalates to SIGKILL if child process does not exit on SIGTERM within 500ms", async () => {
		const temp = mkdtempSync(join(tmpdir(), "stubborn-runner-"));
		const fakeRunner = join(temp, "stubborn-script.js");
		writeFileSync(fakeRunner, "process.on('SIGTERM', () => {}); console.log(JSON.stringify({ type: 'ready' })); setInterval(() => {}, 1000);");

		const savedRunnerPath = process.env.PI_DURABLE_RUNNER_PATH;
		process.env.PI_DURABLE_RUNNER_PATH = fakeRunner;

		let exited = false;
		let exitSignal: NodeJS.Signals | null = null;

		try {
			const runner = new RunnerProcess({
				cwd: temp,
				args: [],
				onExit: (_code, signal) => {
					exited = true;
					exitSignal = signal;
				},
			});

			const child = (runner as any).child;
			assert.ok(child.pid);

			// Ensure stubborn script has booted and installed SIGTERM handler
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 1000);
				child.stdout?.once("data", () => {
					clearTimeout(timer);
					resolve();
				});
			});

			const killStart = Date.now();
			runner.kill();

			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && !exited) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			const duration = Date.now() - killStart;
			assert.equal(exited, true, "stubborn runner must eventually be killed");
			assert.ok(duration >= 450, `SIGKILL escalation must take at least ~500ms, took ${duration}ms`);
			assert.equal(child.signalCode ?? exitSignal, "SIGKILL", "stubborn runner must be terminated via SIGKILL");
		} finally {
			if (savedRunnerPath !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunnerPath;
			else delete process.env.PI_DURABLE_RUNNER_PATH;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("RunnerProcess.kill() is idempotent and does not throw on multiple calls", async () => {
		const runner = new RunnerProcess({
			cwd: process.cwd(),
			args: ["--no-session"],
		});

		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.doesNotThrow(() => {
			runner.kill();
			runner.kill();
			runner.kill();
		});
		assert.equal(runner.exited, true);
	});
});
