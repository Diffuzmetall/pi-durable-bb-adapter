import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * bb runs this plugin's host bundle from `<dataDir>/plugin-host-artifacts/<pluginId>/<digest>/host.mjs`, with no
 * runner and no package.json beside it, and it does not pass `BB_DATA_DIR` to the bridge worker. That path is
 * therefore the only reliable statement of which data dir this plugin is installed in (issue #18).
 */
export function dataDirFromHostArtifact(fromDir: string): string | null {
	const artifactsDir = dirname(dirname(fromDir));
	return basename(artifactsDir) === "plugin-host-artifacts" ? dirname(artifactsDir) : null;
}

export interface DataDirInput {
	fromDir: string;
	guessedDataDir: string;
	explicitDataDir?: string;
	explicitPaths?: boolean;
}

/**
 * Data dirs to search, best first: the one this bundle was deployed under, then what `BB_DATA_DIR` and the default
 * point at (a guess), then the legacy `~/.bb`. A caller that named its own db or cache paths gets only what it
 * named, so a test cannot pick up a runner this machine happens to have installed somewhere else.
 */
export function dataDirsToSearch(input: DataDirInput): string[] {
	if (input.explicitDataDir !== undefined) return [resolve(input.explicitDataDir)];
	if (input.explicitPaths) return [];
	const dirs = [dataDirFromHostArtifact(input.fromDir), input.guessedDataDir, join(homedir(), ".bb")];
	return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))];
}

/** A plugin checkout carries its runner at one of two shapes: built (`dist`) or shipped beside the source. */
function runnerInPluginRoot(rootDir: string): string | null {
	for (const candidate of [join(rootDir, "dist", "runner", "index.js"), join(rootDir, "runner", "index.js")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** The plugin row bb itself uses, so the activated installation wins over anything else on the machine. */
export function findRunnerFromDb(dbPath: string): string | null {
	if (!existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const query = `
				SELECT root_dir FROM plugins
				WHERE (id = 'provider-pi-durable' OR id = 'bb-plugin-provider-pi-durable')
				ORDER BY enabled DESC, updated_at DESC
				LIMIT 1
			`;
			const row = db.prepare(query).get() as { root_dir?: string } | undefined;
			return row?.root_dir ? runnerInPluginRoot(resolve(row.root_dir)) : null;
		} finally {
			db.close();
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT" && code !== "SQLITE_CANTOPEN") {
			console.warn(`[Paths] SQLite inspection warning for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return null;
}

export function findRunnerInCache(cacheRoot: string, maxDepth = 5): string | null {
	if (!existsSync(cacheRoot)) return null;
	const queue: { dir: string; depth: number }[] = [{ dir: cacheRoot, depth: 0 }];
	while (queue.length > 0) {
		const { dir, depth } = queue.shift()!;
		if (depth > maxDepth) continue;
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const full = join(dir, entry.name);
				const found = runnerInPluginRoot(full);
				if (found) return found;
				queue.push({ dir: full, depth: depth + 1 });
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") {
				console.warn(`[Paths] Directory traversal warning for ${dir}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	return null;
}

/** An explicit cache dir is bb's whole cache; the automatic form points straight at its git and npm subdirs. */
export function cacheRootsFor(dataDir: string, explicitCacheDir?: string): string[] {
	if (explicitCacheDir !== undefined) return [join(explicitCacheDir, "git"), join(explicitCacheDir, "npm"), explicitCacheDir];
	return [join(dataDir, "plugins", "cache", "git"), join(dataDir, "plugins", "cache", "npm")];
}

/** The dirs bb creates for a plugin installed outside a cache. */
export function pluginDirCandidates(dataDir: string): string[] {
	return [
		join(dataDir, "plugins", "provider-pi-durable", "dist", "runner", "index.js"),
		join(dataDir, "plugins", "bb-plugin-provider-pi-durable", "dist", "runner", "index.js"),
	];
}

/** Last resort: a sibling checkout of this repository beside the bundle's own directory (developer machines). */
export function findRunnerBesideSiblings(parentDir: string): string | null {
	try {
		if (!existsSync(parentDir)) return null;
		for (const sibling of readdirSync(parentDir, { withFileTypes: true })) {
			if (!sibling.isDirectory()) continue;
			const found = runnerInPluginRoot(resolve(parentDir, sibling.name));
			if (found) return found;
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") {
			console.warn(`[Paths] Sibling traversal warning for ${parentDir}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return null;
}
