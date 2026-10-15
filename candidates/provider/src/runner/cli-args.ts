import type { ModelThinkingLevel } from "./harness-setup.ts";

export interface CliArgs {
	mode?: string;
	session?: string;
	sessionDir?: string;
	continueSession?: boolean;
	noSession?: boolean;
	provider?: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	cwd?: string;
	systemPromptPath?: string;
	appendSystemPromptPath?: string;
	extension?: string;
}

export function parseCliArgs(argv: string[]): CliArgs {
	const args: CliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode" && i + 1 < argv.length) args.mode = argv[++i];
		else if (arg === "--session" && i + 1 < argv.length) args.session = argv[++i];
		else if (arg === "--session-dir" && i + 1 < argv.length) args.sessionDir = argv[++i];
		else if (arg === "--continue") args.continueSession = true;
		else if (arg === "--no-session") args.noSession = true;
		else if (arg === "--provider" && i + 1 < argv.length) args.provider = argv[++i];
		else if (arg === "--model" && i + 1 < argv.length) args.model = argv[++i];
		else if (arg === "--thinking" && i + 1 < argv.length) args.thinking = argv[++i] as ModelThinkingLevel;
		else if (arg === "--system-prompt" && i + 1 < argv.length) args.systemPromptPath = argv[++i];
		else if (arg === "--append-system-prompt" && i + 1 < argv.length) args.appendSystemPromptPath = argv[++i];
		else if (arg === "--cwd" && i + 1 < argv.length) args.cwd = argv[++i];
		else if (arg === "--extension" && i + 1 < argv.length) args.extension = argv[++i];
		else if (arg.startsWith("-")) {
			// Skip unknown options and consume their parameter if present
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				i++;
			}
		} else if (!args.cwd) {
			args.cwd = arg;
		}
	}
	return args;
}
