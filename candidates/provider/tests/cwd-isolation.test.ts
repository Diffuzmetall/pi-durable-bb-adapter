import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiThreadSession } from "../src/host/session.ts";
import { parseCliArgs } from "../src/runner/cli-args.ts";
import { resolveSessionFilePath } from "../src/host/paths.ts";
import { selectSession } from "../src/runner/session-storage.ts";

describe("CWD Isolation and CLI Argument Parsing (Issue #1)", () => {
	it("PiThreadSession does not pass unsupported --session-dir to runner", () => {
		const projectDir = process.cwd();
		const session = new PiThreadSession(
			{
				cwd: projectDir,
				sessionFilePath: "/tmp/thread-1",
				sessionDir: "/tmp",
				extensionPath: "/tmp/ext.mjs",
				threadId: "thr_test1",
			},
			() => {},
		);

		try {
			const args = session.runner.options.args;
			assert.equal(args.includes("--session-dir"), false, "args should not include --session-dir");
			assert.equal(session.runner.options.cwd, projectDir);

			const parsed = parseCliArgs(args);
			const effectiveCwd = parsed.cwd ?? session.runner.options.cwd;
			assert.equal(effectiveCwd, projectDir, "effective cwd must remain the project directory");
		} finally {
			session.runner.kill();
		}
	});

	it("parseCliArgs parses --session-dir without overriding cwd", () => {
		const parsed = parseCliArgs(["--session", "/sessions/s1", "--session-dir", "/sessions/dir", "--mode", "rpc"]);
		assert.equal(parsed.sessionDir, "/sessions/dir");
		assert.equal(parsed.cwd, undefined, "cwd must not be populated by --session-dir value");
	});

	it("parseCliArgs parses explicit --cwd flag", () => {
		const parsed = parseCliArgs(["--mode", "rpc", "--cwd", "/workspace/target-project", "--no-session"]);
		assert.equal(parsed.cwd, "/workspace/target-project");
		assert.equal(parsed.noSession, true);
	});

	it("parseCliArgs does not let boolean flag --no-session consume positional cwd", () => {
		const parsed = parseCliArgs(["--mode", "rpc", "--no-session", "/workspace/target-project"]);
		assert.equal(parsed.noSession, true);
		assert.equal(parsed.cwd, "/workspace/target-project");
	});

	it("parseCliArgs does not let unknown options with values become positional cwd", () => {
		const parsed = parseCliArgs(["--unknown-flag", "some-value", "--another-flag", "123"]);
		assert.equal(parsed.cwd, undefined, "unknown flag value must not become positional cwd");
	});

	it("parseCliArgs honors deliberate positional cwd", () => {
		const parsed = parseCliArgs(["--mode", "rpc", "--session", "/sessions/s1", "/workspace/target-project"]);
		assert.equal(parsed.cwd, "/workspace/target-project");
	});

	it("parseCliArgs supports paths with spaces", () => {
		const parsed = parseCliArgs([
			"--session",
			"/sessions with spaces/s1",
			"--session-dir",
			"/sessions with spaces",
			"/workspace with spaces/my project",
		]);
		assert.equal(parsed.sessionDir, "/sessions with spaces");
		assert.equal(parsed.session, "/sessions with spaces/s1");
		assert.equal(parsed.cwd, "/workspace with spaces/my project");
	});

	it("resolveSessionFilePath does not append false .jsonl suffix for directory sessions", () => {
		const path = resolveSessionFilePath("thr_abc123");
		assert.equal(path.endsWith(".jsonl"), false, "session path must not end with .jsonl");
		assert.ok(path.endsWith("thr_abc123"), "session path must end with thread id");
	});

	it("selectSession resolves target directory and strips .sqlite file suffix from target session path", async () => {
		const temp = mkdtempSync(join(tmpdir(), "pi-session-d2-"));
		try {
			const targetWithSqlite = join(temp, "custom-thread", "session.sqlite");
			const location = await selectSession(temp, false, targetWithSqlite);
			try {
				assert.equal(location.directory.endsWith("custom-thread"), true);
				assert.equal(location.database, join(temp, "custom-thread", "session.sqlite"));
			} finally {
				await location.release();
			}
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
