/**
 * Session directory management, SQLite path resolution, and lockfile locking.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export function getAgentDir(): string {
	const override = process.env.PI_AGENT_DIR;
	if (override && override.trim().length > 0) return resolve(override.trim());
	return join(homedir(), ".pi", "agent");
}

export interface SessionOwnerInfo {
	pid: number;
	id: string;
	cwd: string;
	startedAt: number;
}

export function isProcessAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function logUnexpectedErr(err: unknown, allowedCode: string, context: string): void {
	if ((err as NodeJS.ErrnoException)?.code !== allowedCode) {
		console.warn(`[SessionStorage] ${context}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function writeOwnerFile(directory: string, owner: SessionOwnerInfo): Promise<void> {
	await writeFile(join(directory, "session.owner.json"), JSON.stringify(owner, null, 2), "utf8");
}

async function readOwnerFile(directory: string): Promise<SessionOwnerInfo | null> {
	try {
		const content = await readFile(join(directory, "session.owner.json"), "utf8");
		return JSON.parse(content) as SessionOwnerInfo;
	} catch (err) {
		logUnexpectedErr(err, "ENOENT", `Corrupted or unreadable session.owner.json in ${directory}`);
		return null;
	}
}

async function removeOwnerFile(directory: string): Promise<void> {
	await rm(join(directory, "session.owner.json"), { force: true }).catch((err) =>
		logUnexpectedErr(err, "ENOENT", `Failed to remove owner file in ${directory}`)
	);
}

async function forceUnlock(directory: string): Promise<void> {
	await lockfile.unlock(directory, { realpath: false }).catch((err) =>
		logUnexpectedErr(err, "ENOENT", `unlock warning for ${directory}`)
	);
	await rm(`${directory}.lock`, { recursive: true, force: true }).catch((err) =>
		logUnexpectedErr(err, "ENOENT", `lockfile cleanup warning for ${directory}`)
	);
}

async function acquireSessionLock(directory: string, cwd: string, id: string): Promise<() => Promise<void>> {
	const lockOpts = { realpath: false, retries: { retries: 2, minTimeout: 100, maxTimeout: 200 } };

	let rawRelease: () => Promise<void>;
	try {
		rawRelease = await lockfile.lock(directory, lockOpts);
	} catch (initialErr) {
		let owner = await readOwnerFile(directory);
		if (!owner) {
			await new Promise((r) => setTimeout(r, 100));
			owner = await readOwnerFile(directory);
		}
		if (!owner) {
			throw new Error(`Session is already open in another process: ${directory}`, { cause: initialErr });
		}

		if (!isProcessAlive(owner.pid)) {
			await forceUnlock(directory);
			await removeOwnerFile(directory);
			try {
				rawRelease = await lockfile.lock(directory, lockOpts);
			} catch (retryErr) {
				throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: retryErr });
			}
		} else if (owner.pid !== process.pid) {
			try {
				process.kill(owner.pid, "SIGTERM");
			} catch (err) {
				logUnexpectedErr(err, "ESRCH", `Failed to send SIGTERM to PID ${owner.pid}`);
			}

			const deadline = Date.now() + 3000;
			while (Date.now() < deadline && isProcessAlive(owner.pid)) {
				await new Promise((r) => setTimeout(r, 100));
			}

			if (!isProcessAlive(owner.pid)) {
				await forceUnlock(directory);
				await removeOwnerFile(directory);
				try {
					rawRelease = await lockfile.lock(directory, lockOpts);
				} catch (retryErr) {
					throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: retryErr });
				}
			} else {
				throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: initialErr });
			}
		} else {
			throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: initialErr });
		}
	}

	await writeOwnerFile(directory, { pid: process.pid, id, cwd, startedAt: Date.now() });

	let released = false;
	return async () => {
		if (released) return;
		released = true;
		try {
			await removeOwnerFile(directory);
		} finally {
			await rawRelease();
		}
	};
}

/** One session directory holding `session.sqlite`, locked by this process. */
export interface SessionLocation {
	id: string;
	directory: string;
	database: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
}

/** A new session for `cwd`, its newest one with `continueSession`, or a specific session. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	targetSession?: string,
): Promise<SessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(getAgentDir(), "experimental", "durable-sessions", createHash("sha256").update(cwd).digest("hex").slice(0, 24));
	await mkdir(root, { recursive: true });

	let directory: string;
	let created = false;
	if (targetSession) {
		const clean = targetSession.endsWith(".sqlite") ? resolve(targetSession, "..") : targetSession;
		directory = (clean.includes("/") || clean.includes("\\")) ? resolve(clean) : join(root, clean);
		try {
			await mkdir(directory, { recursive: true });
			const entries = await readdir(directory);
			if (!entries.includes("session.sqlite")) {
				created = true;
			}
		} catch (err) {
			logUnexpectedErr(err, "ENOENT", `Directory inspection failed in ${directory}`);
		}
	} else if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No durable session exists for ${cwd}`);
		directory = join(root, newest);
	} else {
		directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(directory);
		created = true;
	}

	const id = basename(directory);
	const release = await acquireSessionLock(directory, cwd, id);
	return { id, directory, database: join(directory, "session.sqlite"), cwd, created, release };
}
