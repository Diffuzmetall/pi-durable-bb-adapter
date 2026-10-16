import {
	projectNativeChildInBb,
	type NativeChildOwner,
	type NativeChildProjectionResult,
} from "./native-child-binding.ts";

export interface SubthreadSpawnArgs {
	projectId?: string;
	parentThreadId: string;
	title: string;
	task: string;
	conversationId?: string;
	backendId?: string;
	sessionId?: string;
}

export interface ThreadRegistrationTarget {
	registerThread(threadId: string, conversationId?: string): void;
}

export interface SubthreadSpawnerOptions {
	// Retained for existing callers; projection never executes a CLI command.
	execCommand?: (cmd: string, args: string[]) => Promise<string>;
	owner?: NativeChildOwner;
}

export function projectSubthreadInBb(
	args: SubthreadSpawnArgs,
	owner?: NativeChildOwner,
): NativeChildProjectionResult {
	if (!owner) {
		return { status: "projection-unavailable", reason: "unsupported-registration-port" };
	}
	return projectNativeChildInBb({
		backendId: args.backendId ?? "",
		sessionId: args.sessionId ?? "",
		conversationId: args.conversationId ?? "",
		parentThreadId: args.parentThreadId,
		title: args.title,
	}, owner);
}

export async function spawnSubthreadInBb(
	args: SubthreadSpawnArgs,
	_session: ThreadRegistrationTarget,
	options: SubthreadSpawnerOptions = {},
): Promise<string | undefined> {
	const result = projectSubthreadInBb(args, options.owner);
	console.warn(`[SubthreadSpawner] ${result.status}: ${result.reason}`);
	return undefined;
}
