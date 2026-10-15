import type { SessionOptions, ThreadDelta } from "./types.ts";

export interface SessionStats {
	tokens: number | null;
	contextWindow: number;
}

export interface ReadyDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (err: Error) => void;
}

export function createReadyDeferred(): ReadyDeferred {
	let settled = false;
	let resolveFn!: () => void;
	let rejectFn!: (err: Error) => void;

	const promise = new Promise<void>((resolve, reject) => {
		resolveFn = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		rejectFn = (err: Error) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		};
	});
	// Retain error trace if startup rejects before caller awaits start()
	promise.catch((err: unknown) => {
		if (process.env.DEBUG_STARTUP) {
			console.debug(`[SessionTelemetry] Early startup rejection: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	return { promise, resolve: resolveFn, reject: rejectFn };
}

export async function waitForReady(readyPromise: Promise<void>, timeoutMs = 45000): Promise<void> {
	let timer: NodeJS.Timeout | null = null;
	try {
		await Promise.race([
			readyPromise,
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Runner startup ready timed out")), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== null) {
			clearTimeout(timer);
		}
	}
}

export function buildRunnerArgs(options: SessionOptions): string[] {
	const args = ["--mode", "rpc"];
	if (options.noSession) {
		args.push("--no-session");
	} else {
		args.push("--session", options.sessionFilePath);
	}
	args.push("--extension", options.extensionPath);

	if (options.model) {
		args.push("--provider", options.model.provider, "--model", options.model.id);
	}
	if (options.thinkingLevel) {
		args.push("--thinking", options.thinkingLevel);
	}
	if (options.appendSystemPrompt) {
		args.push("--append-system-prompt", options.appendSystemPrompt);
	}
	return args;
}

export function extractSessionStats(res: unknown): SessionStats {
	const raw = res as {
		contextUsage?: { tokens?: number; contextWindow?: number };
		data?: { contextUsage?: { tokens?: number; contextWindow?: number } };
		tokens?: number;
		contextWindow?: number;
	} | undefined;

	const usage = raw?.contextUsage ?? raw?.data?.contextUsage ?? raw;
	return {
		tokens: typeof usage?.tokens === "number" ? usage.tokens : null,
		contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : 0,
	};
}

export function createContextWindowDelta(stats: SessionStats): ThreadDelta | null {
	if (typeof stats.contextWindow === "number" && stats.contextWindow > 0) {
		return {
			kind: "contextWindow",
			used: stats.tokens,
			size: stats.contextWindow,
			estimated: true,
			attach: "currentOrLast",
		};
	}
	return null;
}
