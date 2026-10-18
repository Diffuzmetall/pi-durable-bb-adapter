import { setupRunnerModels } from "./model-setup.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { openDurable, type OpenDurableOptions, type OpenDurableResult } from "./runtime.ts";
import { BBEventAdapter } from "./bridge/bb-event-adapter.ts";
import type { BBWireEvent } from "./bridge/contracts.ts";
import { parseCliArgs } from "./cli-args.ts";
import { handleActiveSessionCommand, type RunnerCommandPayload } from "./session-commands.ts";
import { getPiDurableVersion } from "./version.ts";
import { sharedHostSocket, runSharedHost } from "./shared-host.ts";
import { createBridgeSender, initBridgeInboundChannel } from "./bridge-channel.ts";
import { startSubagentWatcher, type SubagentWatcherController } from "./subagent-watcher.ts";
import { startTaskGraphBridge } from "./task-graph-bridge.ts";

const argv = process.argv.slice(2);

// Handle --version flag dynamically (Defect D-9, AP-027)
if (argv.includes("--version") || argv.includes("-v")) {
	console.log(getPiDurableVersion());
	process.exit(0);
}

const args = parseCliArgs(argv);

function output(data: unknown): void {
	process.stdout.write(serializeJsonLine(data));
}

const sendToBridge = createBridgeSender();

async function main() {
	// Explicit attachment fails closed rather than opening a second SQLite owner.
	const socket = !args.noSession && await sharedHostSocket(args.session);
	if (socket) {
		await runSharedHost(socket, args.cwd ?? process.cwd(), process.stdin, output, sendToBridge);
		return;
	}
	let activeDurable: OpenDurableResult | null = null;
	let activeWatcher: SubagentWatcherController | null = null;
	let isTerminating = false;

	const handleExit = async (signalOrReason: string) => {
		if (isTerminating) return;
		isTerminating = true;
		if (activeWatcher) {
			try {
				activeWatcher.close();
			} catch (err) {
				console.warn(`[Runner] Error closing subagent watcher on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (activeDurable) {
			try {
				await activeDurable.close();
			} catch (err) {
				console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
			}
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => { void handleExit("SIGTERM"); });
	process.on("SIGINT", () => { void handleExit("SIGINT"); });
	process.stdin.on("end", () => { void handleExit("stdin.end"); });

	const cwd = args.cwd ?? process.cwd();
	const {
		modelRuntime,
		scopedModelList,
		defaultModel,
		defaultThinkingLevel,
		modelScope,
	} = await setupRunnerModels(cwd, args);

	// Notify bridge of model scope over FD 3
	sendToBridge({ kind: "model-scope", ...modelScope });
	initBridgeInboundChannel(modelScope, sendToBridge);

	const success = (id: string | undefined, command: string, data?: unknown) => {
		output({ id, type: "response", command, success: true, data });
	};

	const error = (id: string | undefined, command: string, message: string) => {
		output({ id, type: "response", command, success: false, error: message });
	};

	// Handle probe / catalog mode (--no-session)
	if (args.noSession) {
		sendToBridge({ ready: true, kind: "ready" });
		attachJsonlLineReader(process.stdin, (line) => {
			if (!line.trim()) return;
			try {
				const cmd = JSON.parse(line);
				if (cmd.type === "get_available_models") {
					success(cmd.id, "get_available_models", { models: scopedModelList });
				} else if (cmd.type === "get_state") {
					success(cmd.id, "get_state", {
						model: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id, modelId: defaultModel.id } : null,
						thinkingLevel: defaultThinkingLevel,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "one-at-a-time",
						followUpMode: "one-at-a-time",
						sessionId: "catalog",
						autoCompactionEnabled: true,
						messageCount: 0,
						pendingMessageCount: 0,
					});
				} else {
					success(cmd.id, cmd.type, {});
				}
			} catch (err) {
				error(undefined, "unknown", err instanceof Error ? err.message : String(err));
			}
		});
		return;
	}

	// Active durable session mode
	const durableOptions: OpenDurableOptions = {
		cwd: args.cwd,
		continueSession: args.continueSession,
		session: args.session,
		cli: args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : undefined,
		prompt: {
			systemPromptPath: args.systemPromptPath,
			appendSystemPromptPath: args.appendSystemPromptPath,
		},
	};

	const durable = await openDurable(durableOptions);
	activeDurable = durable;

	// Setup native Pi Durable event stream adapter with subagent multiplexing
	const adapter = new BBEventAdapter(
		(evt: BBWireEvent) => output(evt),
		(provider, modelId) => {
			const p = provider ?? args.provider;
			const m = modelId ?? args.model;
			return p && m ? modelRuntime.getModel(p, m)?.contextWindow : undefined;
		},
	);
	const watcher = await startSubagentWatcher(durable.harness, adapter, () => durable.view.current());
	activeWatcher = watcher;
	startTaskGraphBridge(durable.view, output);

	// Handle stdin RPC commands in active session
	attachJsonlLineReader(process.stdin, async (line) => {
		let cmd: RunnerCommandPayload;
		try {
			cmd = JSON.parse(line) as RunnerCommandPayload;
		} catch (e) {
			error(undefined, "parse", `Invalid JSON: ${e}`);
			return;
		}

		try {
			await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
		} catch (err) {
			error(cmd.id, cmd.type ?? "unknown", err instanceof Error ? err.message : String(err));
		}
	});

	// Signal active session readiness only after SQLite store, event stream and stdin listener are active
	sendToBridge({ ready: true, kind: "ready" });
}

main().catch((err) => {
	console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
	process.exit(1);
});
