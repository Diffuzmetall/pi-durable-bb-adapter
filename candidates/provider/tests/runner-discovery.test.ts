import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getBbDataDir, resolveRunnerPath, resolveSessionDir } from "../src/host/paths.ts";
import { dataDirFromHostArtifact } from "../src/host/runner-lookup.ts";

describe("Runner Path Discovery & Portability (Issue #2)", () => {
	it("honors BB_PI_DURABLE_BRIDGE_COMMAND explicit override", () => {
		const temp = mkdtempSync(join(tmpdir(), "runner-test-env-"));
		const fakeRunner = join(temp, "custom-runner.js");
		writeFileSync(fakeRunner, "// custom runner");

		const saved = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		try {
			process.env.BB_PI_DURABLE_BRIDGE_COMMAND = fakeRunner;
			const resolved = resolveRunnerPath();
			assert.equal(resolved, fakeRunner);
		} finally {
			if (saved === undefined) delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
			else process.env.BB_PI_DURABLE_BRIDGE_COMMAND = saved;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("honors PI_DURABLE_RUNNER_PATH explicit override", () => {
		const temp = mkdtempSync(join(tmpdir(), "runner-test-env2-"));
		const fakeRunner = join(temp, "custom-runner2.js");
		writeFileSync(fakeRunner, "// custom runner 2");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		try {
			process.env.PI_DURABLE_RUNNER_PATH = fakeRunner;
			const resolved = resolveRunnerPath();
			assert.equal(resolved, fakeRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner === undefined) delete process.env.PI_DURABLE_RUNNER_PATH;
			else process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner via BB SQLite database plugins table", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-db-test-"));
		const fakePluginRoot = join(temp, "custom-plugin-workspace");
		mkdirSync(join(fakePluginRoot, "dist", "runner"), { recursive: true });
		const expectedRunner = join(fakePluginRoot, "dist", "runner", "index.js");
		writeFileSync(expectedRunner, "// runner from bb.db root_dir");

		const mockDbFile = join(temp, "test-bb.db");
		const db = new DatabaseSync(mockDbFile);
		db.exec(`
			CREATE TABLE plugins (
				id TEXT PRIMARY KEY,
				root_dir TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				updated_at INTEGER DEFAULT 0
			);
			INSERT INTO plugins (id, root_dir, enabled) VALUES ('provider-pi-durable', '${fakePluginRoot}', 1);
		`);
		db.close();

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			// Query passing custom bbDbPath
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "isolated-artifact"),
				bbDbPath: mockDbFile,
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner via BB git cache directory structure", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-git-cache-test-"));
		const gitCacheDir = join(temp, "cache", "git", "github.com", "org", "bb-plugin-provider-pi-durable", "dist", "runner");
		mkdirSync(gitCacheDir, { recursive: true });
		const expectedRunner = join(gitCacheDir, "index.js");
		writeFileSync(expectedRunner, "// git cache runner");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "random-dir"),
				cacheDir: join(temp, "cache"),
				bbDbPath: join(temp, "empty.db"),
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner via BB npm cache directory structure", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-npm-cache-test-"));
		const npmCacheDir = join(temp, "cache", "npm", "bb-plugin-provider-pi-durable", "1.0.0", "dist", "runner");
		mkdirSync(npmCacheDir, { recursive: true });
		const expectedRunner = join(npmCacheDir, "index.js");
		writeFileSync(expectedRunner, "// npm cache runner");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({
				fromDir: join(temp, "random-dir"),
				cacheDir: join(temp, "cache"),
				bbDbPath: join(temp, "empty.db"),
			});
			assert.equal(resolved, expectedRunner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it("resolves runner in paths containing spaces", () => {
		const root = mkdtempSync(join(tmpdir(), "bb test with spaces-"));
		const packageRoot = join(root, "plugin path with spaces");
		const cacheRoot = join(root, "host cache with spaces");
		mkdirSync(join(packageRoot, "dist", "runner"), { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });

		const runner = join(packageRoot, "dist", "runner", "index.js");
		writeFileSync(runner, "// test runner in space package");

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({ fromDir: packageRoot });
			assert.equal(resolved, runner);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("throws actionable error on genuinely missing runner without maintainer path", () => {
		const root = mkdtempSync(join(tmpdir(), "bb-empty-test-"));
		const cacheRoot = join(root, "host-cache");
		mkdirSync(cacheRoot, { recursive: true });

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			assert.throws(
				() => resolveRunnerPath({ fromDir: cacheRoot, bbDbPath: join(root, "missing.db"), cacheDir: join(root, "empty-cache") }),
				(err: Error) => {
					assert.ok(err.message.includes("internal runner bundle not found"));
					assert.ok(!err.message.includes("/Users/vanya/Projects/bb-plugin-provider-pi-durable"), "must not include author-specific repo path");
					return true;
				},
			);
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the data dir back out of bb's deployed host-artifact layout", () => {
		assert.equal(
			dataDirFromHostArtifact(join("/data", "plugin-host-artifacts", "provider-pi-durable", "d".repeat(64))),
			"/data",
		);
		assert.equal(dataDirFromHostArtifact(join("/data", "plugins", "provider-pi-durable")), null);
		assert.equal(dataDirFromHostArtifact("/tmp"), null);
	});

	it("prefers the data dir this host was deployed under over a foreign install (Issue #18)", () => {
		const root = mkdtempSync(join(tmpdir(), "bb-artifact-datadir-"));
		// What bb actually runs: <dataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs, alone in its dir.
		const dataDir = join(root, "bb-server");
		const artifactDir = join(dataDir, "plugin-host-artifacts", "provider-pi-durable", "d".repeat(64));
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "host.mjs"), "// deployed host bundle, nothing beside it");

		const activatedRoot = join(root, "activated-plugin");
		mkdirSync(join(activatedRoot, "dist", "runner"), { recursive: true });
		const expectedRunner = join(activatedRoot, "dist", "runner", "index.js");
		writeFileSync(expectedRunner, "// the plugin bb activated");
		const db = new DatabaseSync(join(dataDir, "bb.db"));
		db.exec(`
			CREATE TABLE plugins (
				id TEXT PRIMARY KEY,
				root_dir TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				updated_at INTEGER DEFAULT 0
			);
			INSERT INTO plugins (id, root_dir, enabled) VALUES ('provider-pi-durable', '${activatedRoot}', 1);
		`);
		db.close();

		// The stale clone that used to win: the bridge worker gets no BB_DATA_DIR, so the guess lands on whatever
		// ~/.bb happens to hold, and that fallback then answered for the plugin bb had actually activated.
		const foreignRoot = join(root, "foreign-bb", "plugins", "provider-pi-durable");
		mkdirSync(join(foreignRoot, "dist", "runner"), { recursive: true });
		writeFileSync(join(foreignRoot, "dist", "runner", "index.js"), "// a foreign install that must not answer");

		const savedDataDir = process.env.BB_DATA_DIR;
		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;
		try {
			process.env.BB_DATA_DIR = join(root, "foreign-bb");
			assert.equal(resolveRunnerPath({ fromDir: artifactDir }), expectedRunner);

			// With BB_DATA_DIR unset the guess is no better either, so the artifact path still has to decide.
			delete process.env.BB_DATA_DIR;
			assert.equal(resolveRunnerPath({ fromDir: artifactDir }), expectedRunner);
		} finally {
			if (savedDataDir === undefined) delete process.env.BB_DATA_DIR;
			else process.env.BB_DATA_DIR = savedDataDir;
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves runner on real BB host artifact path when present", () => {
		const realArtifactDir = join(homedir(), ".bb", "plugin-host-artifacts", "provider-pi-durable", "6e4db84ddf8cab895f7af2c6878d61d479ea2f6934bf804cc008797ce29b757c");
		if (!existsSync(realArtifactDir)) return;

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			const resolved = resolveRunnerPath({ fromDir: realArtifactDir });
			assert.ok(existsSync(resolved), `resolved runner path must exist on disk: ${resolved}`);
			assert.ok(resolved.endsWith("dist/runner/index.js") || resolved.endsWith("runner/index.js"));
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
		}
	});

	it("resolves getBbDataDir and honors BB_DATA_DIR environment variable (Issue #7)", () => {
		assert.equal(getBbDataDir({}), join(homedir(), ".bb"));
		assert.equal(getBbDataDir({ BB_DATA_DIR: "   " }), join(homedir(), ".bb"));
		assert.equal(getBbDataDir({ BB_DATA_DIR: "/custom/bb/dir" }), "/custom/bb/dir");
	});

	it("resolves runner via BB_DATA_DIR custom database and cache (Issue #7)", () => {
		const temp = mkdtempSync(join(tmpdir(), "bb-custom-datadir-"));
		const customDataDir = join(temp, "custom-data");
		const customPluginRoot = join(temp, "custom-plugin-pkg");
		mkdirSync(join(customPluginRoot, "dist", "runner"), { recursive: true });
		const expectedRunner = join(customPluginRoot, "dist", "runner", "index.js");
		writeFileSync(expectedRunner, "// runner in custom datadir");

		mkdirSync(customDataDir, { recursive: true });
		const mockDbFile = join(customDataDir, "bb.db");
		const db = new DatabaseSync(mockDbFile);
		db.exec(`
			CREATE TABLE plugins (
				id TEXT PRIMARY KEY,
				root_dir TEXT NOT NULL,
				enabled INTEGER DEFAULT 1,
				updated_at INTEGER DEFAULT 0
			);
			INSERT INTO plugins (id, root_dir, enabled) VALUES ('provider-pi-durable', '${customPluginRoot}', 1);
		`);
		db.close();

		const savedBridge = process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		const savedRunner = process.env.PI_DURABLE_RUNNER_PATH;
		const savedDataDir = process.env.BB_DATA_DIR;
		delete process.env.BB_PI_DURABLE_BRIDGE_COMMAND;
		delete process.env.PI_DURABLE_RUNNER_PATH;

		try {
			process.env.BB_DATA_DIR = customDataDir;
			const resolved = resolveRunnerPath({ fromDir: join(temp, "isolated-dir") });
			assert.equal(resolved, expectedRunner);

			// Also verify resolveSessionDir uses BB_DATA_DIR
			const sessionDir = resolveSessionDir(process.env);
			assert.equal(sessionDir, join(customDataDir, "pi-bridge-sessions"));
		} finally {
			if (savedBridge !== undefined) process.env.BB_PI_DURABLE_BRIDGE_COMMAND = savedBridge;
			if (savedRunner !== undefined) process.env.PI_DURABLE_RUNNER_PATH = savedRunner;
			if (savedDataDir !== undefined) process.env.BB_DATA_DIR = savedDataDir;
			else delete process.env.BB_DATA_DIR;
			rmSync(temp, { recursive: true, force: true });
		}
	});
});
