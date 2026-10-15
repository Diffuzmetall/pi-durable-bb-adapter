import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cacheRootsFor,
	dataDirsToSearch,
	findRunnerBesideSiblings,
	findRunnerFromDb,
	findRunnerInCache,
	pluginDirCandidates,
} from "./runner-lookup.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ResolveRunnerOptions {
	fromDir?: string;
	/** The data dir this host runs against, when the caller knows it; suppresses the guesses below. */
	dataDir?: string;
	bbDbPath?: string;
	cacheDir?: string;
	env?: NodeJS.ProcessEnv;
}

export function getBbDataDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.BB_DATA_DIR?.trim();
	if (custom) return resolve(custom);
	return join(homedir(), ".bb");
}

export function resolveRunnerPath(options?: ResolveRunnerOptions): string {
	const env = options?.env ?? process.env;
	const envCmd = env.BB_PI_DURABLE_BRIDGE_COMMAND?.trim() || env.PI_DURABLE_RUNNER_PATH?.trim();
	if (envCmd) {
		const custom = resolve(envCmd);
		if (existsSync(custom)) return custom;
	}

	const baseDir = options?.fromDir ? resolve(options.fromDir) : __dirname;
	const directCandidates = [
		resolve(baseDir, "dist", "runner", "index.js"),
		resolve(baseDir, "runner", "index.js"),
		resolve(baseDir, "..", "runner", "index.js"),
		resolve(baseDir, "..", "dist", "runner", "index.js"),
		resolve(baseDir, "..", "..", "dist", "runner", "index.js"),
	];

	for (const candidate of directCandidates) {
		if (existsSync(candidate)) return candidate;
	}

	const searched: string[] = [...directCandidates];

	// A caller that named its own paths is taken at its word; a caller that did not gets the guesses, in the order
	// `runner-lookup.ts` explains. Guessing here is what let a foreign ~/.bb install answer for this plugin (#18).
	if (options?.bbDbPath !== undefined) {
		const found = findRunnerFromDb(options.bbDbPath);
		if (found) return found;
		searched.push(`bb.db: ${options.bbDbPath}`);
	}
	if (options?.cacheDir !== undefined) {
		const roots = cacheRootsFor(baseDir, options.cacheDir);
		for (const root of roots) {
			const found = findRunnerInCache(root);
			if (found) return found;
		}
		searched.push(...roots);
	}

	const dataDirs = dataDirsToSearch({
		fromDir: baseDir,
		guessedDataDir: getBbDataDir(env),
		explicitDataDir: options?.dataDir,
		explicitPaths: options?.bbDbPath !== undefined || options?.cacheDir !== undefined,
	});
	for (const dataDir of dataDirs) {
		const dbPath = join(dataDir, "bb.db");
		const fromDb = findRunnerFromDb(dbPath);
		if (fromDb) return fromDb;
		searched.push(`bb.db: ${dbPath}`);

		const roots = cacheRootsFor(dataDir);
		for (const root of roots) {
			const found = findRunnerInCache(root);
			if (found) return found;
		}
		searched.push(...roots);

		const pluginDirs = pluginDirCandidates(dataDir);
		for (const candidate of pluginDirs) {
			if (existsSync(candidate)) return candidate;
		}
		searched.push(...pluginDirs);
	}

	const sibling = findRunnerBesideSiblings(dirname(baseDir));
	if (sibling) return sibling;

	throw new Error(
		`Pi Durable internal runner bundle not found. Searched in: ${searched.join(", ")}. Please build the plugin using "npm run build" or set PI_DURABLE_RUNNER_PATH.`,
	);
}

export function resolveSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const custom = env.BB_PI_BRIDGE_SESSION_DIR?.trim();
	if (custom) return resolve(custom);
	return join(getBbDataDir(env), "pi-bridge-sessions");
}

export function resolveSessionFilePath(threadId: string, env: NodeJS.ProcessEnv = process.env): string {
	const sanitized = threadId.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(resolveSessionDir(env), sanitized);
}

let activeScratchDir: string | null = null;
export function requireScratchDir(): string {
	if (!activeScratchDir) {
		activeScratchDir = join(tmpdir(), `bb-pi-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(activeScratchDir, { recursive: true });
	}
	return activeScratchDir;
}

let activeExtensionPath: string | null = null;
export function requireExtensionPath(): string {
	if (!activeExtensionPath) {
		const scratch = requireScratchDir();
		const extFile = join(scratch, "bb-pi-extension.mjs");
		writeFileSync(
			extFile,
			`// Pi Durable BB Bridge stub extension
export default function (pi) {
  // Bridge side channel active
}
`,
			"utf8",
		);
		activeExtensionPath = extFile;
	}
	return activeExtensionPath;
}
