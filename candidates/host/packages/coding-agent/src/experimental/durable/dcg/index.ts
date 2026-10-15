import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import * as chord from "@earendil-works/chord";
import * as contexts from "@earendil-works/chord/context";
import type {
	ExecutionEnv,
	ExecutionError,
	Result,
	ShellExecOptions,
	ShellExecResult,
} from "@earendil-works/pi-durable/env";
import * as envApi from "@earendil-works/pi-durable/env";
import * as nodeEnv from "@earendil-works/pi-durable/env/node";
import { createJiti } from "jiti";
import { getAgentDir } from "../../../config.ts";

export interface HostDcgEnvironmentFactoryOptions {
	/** Trusted absolute native addon entry; never an ordinary Pi extension selection. */
	addonPath?: string;
	defaultCwd?: string;
	/** Trusted startup binary, otherwise startup DCG_BIN or ~/.local/bin/dcg. */
	binaryPath?: string;
	timeoutMs?: number;
	envSource?: () => Readonly<Record<string, string | undefined>>;
}

export interface HostDcgEnvironmentFactory {
	env(target: { cwd?: string }, context: Context): Promise<ExecutionEnv>;
	cleanup(context: Context): Promise<void>;
}

interface NativeFactory {
	env(target: { cwd?: string }, context: Context): ExecutionEnv;
	cleanup(context: Context): Promise<void>;
}
interface NativeAddon {
	DURABLE_DCG_ABI_VERSION: 1;
	createDcgEnvironmentFactory(options: {
		defaultCwd: string;
		evaluatorOptions: {
			binaryPath: string;
			timeoutMs?: number;
			envSource?: () => Readonly<Record<string, string | undefined>>;
		};
	}): NativeFactory;
}

function validateContext(context: Context): void {
	if (
		!context ||
		typeof context !== "object" ||
		(context.abortSignal !== undefined && !(context.abortSignal instanceof AbortSignal))
	)
		throw new TypeError("Unsupported DCG execution context.");
}
function localPath(path: string, base: string): string {
	if (typeof path !== "string" || path.includes("\0") || !path.isWellFormed())
		throw new TypeError("Unsupported local cwd.");
	let normalized = path;
	if (normalized === "~") normalized = homedir();
	else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\")))
		normalized = join(homedir(), normalized.slice(2));
	else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			throw new TypeError("Unsupported local file URL cwd.");
		}
	} else if (
		/^[a-z][a-z\d+.-]*:/i.test(normalized) &&
		!(process.platform === "win32" && /^[a-z]:[\\/]/i.test(normalized))
	)
		throw new TypeError("Unsupported remote or custom cwd.");
	if (normalized.startsWith("\\\\")) throw new TypeError("Unsupported remote cwd.");
	return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized);
}

/** Failure-only local FS provider. There is deliberately no route to the inherited executor. */
class UnavailableNode extends nodeEnv.NodeExecutionEnv {
	#closing: Promise<void> | undefined;
	override async exec(
		_command: string | readonly string[],
		_options: ShellExecOptions | undefined,
		_context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return envApi.err(
			new envApi.ExecutionError(
				"unknown",
				"DCG_UNAVAILABLE: shell not executed. Native addon could not be loaded or constructed; check trusted startup configuration.",
			),
		);
	}
	override cleanup(context: Context): Promise<void> {
		this.#closing ??= Promise.resolve().then(() => super.cleanup(context));
		return this.#closing;
	}
}

/** Trusted startup loader only. No embedded policy, repository discovery, reload adapter, or unguarded fallback. */
export function createHostDcgEnvironmentFactory(
	options: HostDcgEnvironmentFactoryOptions = {},
): HostDcgEnvironmentFactory {
	// Capture selection and every host option synchronously, before load or any await.
	const addonPath =
		options.addonPath ??
		process.env.PI_DURABLE_DCG_EXTENSION ??
		join(getAgentDir(), "durable-extensions", "durable-dcg", "index.ts");
	const binaryPath = options.binaryPath ?? process.env.DCG_BIN ?? join(homedir(), ".local", "bin", "dcg");
	const base = localPath(options.defaultCwd ?? process.cwd(), process.cwd());
	const evaluatorOptions = { binaryPath, timeoutMs: options.timeoutMs, envSource: options.envSource };
	const failures = new Map<string, UnavailableNode>();
	let loading: Promise<NativeFactory | undefined> | undefined;
	let native: NativeFactory | undefined;
	let closed = false;
	let closing: Promise<void> | undefined;

	function load(): Promise<NativeFactory | undefined> {
		loading ??= Promise.resolve().then(async () => {
			try {
				if (
					typeof addonPath !== "string" ||
					!isAbsolute(addonPath) ||
					addonPath.includes("\0") ||
					!addonPath.isWellFormed()
				)
					return undefined;
				const jiti = createJiti(import.meta.url, {
					moduleCache: false,
					fsCache: false,
					tryNative: false,
					virtualModules: {
						"@earendil-works/chord": chord,
						"@earendil-works/chord/context": contexts,
						"@earendil-works/pi-durable/env": envApi,
						"@earendil-works/pi-durable/env/node": nodeEnv,
					},
				});
				const candidate = await jiti.import<Partial<NativeAddon> | undefined>(addonPath);
				if (candidate?.DURABLE_DCG_ABI_VERSION !== 1 || typeof candidate.createDcgEnvironmentFactory !== "function")
					return undefined;
				const factory = candidate.createDcgEnvironmentFactory({ defaultCwd: base, evaluatorOptions });
				if (!factory || typeof factory.env !== "function" || typeof factory.cleanup !== "function")
					return undefined;
				native = factory;
				return factory;
			} catch {
				return undefined;
			} // Fixed failure category: never expose raw errors, paths, or environment.
		});
		return loading;
	}

	return {
		async env(target, context) {
			if (closed) throw new Error("DCG environment factory is closed.");
			validateContext(context);
			if (!target || typeof target !== "object" || Array.isArray(target))
				throw new TypeError("Unsupported local environment target.");
			const cwd = target.cwd === undefined ? base : localPath(target.cwd, base);
			const factory = await load();
			if (closed) throw new Error("DCG environment factory is closed.");
			if (factory) {
				try {
					return factory.env({ cwd }, context);
				} catch {
					/* Per-invocation unavailable; retain factory cleanup ownership. */
				}
			}
			let env = failures.get(cwd);
			if (!env) {
				env = new UnavailableNode({ cwd });
				failures.set(cwd, env);
			}
			return env;
		},
		cleanup(context) {
			if (!closing) {
				closed = true;
				const mandatory =
					context && typeof context.value === "function"
						? contexts.withoutAbortSignal(context)
						: contexts.BACKGROUND_CONTEXT;
				// Invoke known cleanups synchronously: the native factory closes its exec boundary before returning.
				const owned: Promise<void>[] = [];
				const { promise, resolve: finish, reject } = Promise.withResolvers<void>();
				closing = promise; // Reentrant cleanup shares this same shutdown.
				for (const resource of [...failures.values(), ...(native ? [native] : [])]) {
					try {
						owned.push(resource.cleanup(mandatory));
					} catch (error) {
						owned.push(Promise.reject(error));
					}
				}
				if (loading && !native)
					owned.push(
						loading.then(async (factory) => {
							await factory?.cleanup(mandatory);
						}),
					);
				Promise.allSettled(owned).then((results) => {
					failures.clear();
					const errors = results
						.filter((result) => result.status === "rejected")
						.map((result) => result.reason as unknown);
					if (errors.length) reject(new AggregateError(errors, "DCG startup factory cleanup failed."));
					else finish();
				});
			}
			return closing;
		},
	};
}
