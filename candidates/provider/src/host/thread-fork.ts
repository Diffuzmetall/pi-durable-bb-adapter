import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { resolveSessionFilePath } from "./paths.ts";

export interface ForkSessionOptions {
	sourceProviderThreadId: string;
	targetProviderThreadId: string;
	checkpointId?: string | number;
	env?: NodeJS.ProcessEnv;
}

export function forkSessionDatabase(options: ForkSessionOptions): void {
	let sourceDir: string;
	if (
		(options.sourceProviderThreadId.includes("/") || options.sourceProviderThreadId.includes("\\")) &&
		existsSync(options.sourceProviderThreadId)
	) {
		sourceDir = resolve(options.sourceProviderThreadId);
	} else {
		sourceDir = resolveSessionFilePath(options.sourceProviderThreadId, options.env);
	}

	if (!existsSync(join(sourceDir, "session.sqlite"))) {
		if (existsSync(join(options.sourceProviderThreadId, "session.sqlite"))) {
			sourceDir = resolve(options.sourceProviderThreadId);
		}
	}

	const sourceDb = join(sourceDir, "session.sqlite");
	if (!existsSync(sourceDir) || !existsSync(sourceDb)) {
		throw new Error(`Cannot fork: source session database not found for "${options.sourceProviderThreadId}"`);
	}

	let targetDir: string;
	if (options.targetProviderThreadId.includes("/") || options.targetProviderThreadId.includes("\\")) {
		targetDir = resolve(options.targetProviderThreadId);
	} else {
		targetDir = resolveSessionFilePath(options.targetProviderThreadId, options.env);
	}

	mkdirSync(targetDir, { recursive: true });

	const dbFiles = ["session.sqlite", "session.sqlite-wal", "session.sqlite-shm"];
	for (const file of dbFiles) {
		const srcPath = join(sourceDir, file);
		if (existsSync(srcPath)) {
			copyFileSync(srcPath, join(targetDir, file));
		}
	}

	const targetDb = join(targetDir, "session.sqlite");
	const db = new DatabaseSync(targetDb);
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		if (options.checkpointId !== undefined) {
			const entryId = Number(options.checkpointId);
			if (Number.isFinite(entryId) && entryId > 0) {
				const hasEntries = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", "entries");
				if (hasEntries) {
					db.prepare("DELETE FROM entries WHERE id > ?").run(entryId);
				}
			}
		}
	} finally {
		db.close();
	}

	const targetLockDir = `${targetDir}.lock`;
	if (existsSync(targetLockDir)) {
		rmSync(targetLockDir, { recursive: true, force: true });
	}
	if (existsSync(targetDir)) {
		const entries = readdirSync(targetDir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.endsWith(".lock") || entry.name === ".lock") {
				rmSync(join(targetDir, entry.name), { recursive: true, force: true });
			}
		}
	}
}
