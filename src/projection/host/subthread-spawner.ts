import {
	projectNativeChildInBb,
	type NativeChildOwner,
	type NativeChildProjectionResult,
	type RegisterExistingPort,
} from "./native-child-binding.ts";

export interface SubthreadSpawnArgs {
	projectId?: string;
	parentThreadId: string;
	title?: string;
	conversationId?: string;
	providerId?: string;
	sessionId?: string;
	parentProviderThreadId: string;
	requestId?: string;
}

export interface ThreadRegistrationTarget {
	registerThread(threadId: string, conversationId?: string): void;
	registerExisting?: RegisterExistingPort["registerExisting"];
}

export interface SubthreadSpawnerOptions {
	// Retained for existing callers; projection never executes a CLI command.
	execCommand?: (cmd: string, args: string[]) => Promise<string>;
	owner?: NativeChildOwner;
}

export async function projectSubthreadInBb(
	args: SubthreadSpawnArgs,
	owner?: NativeChildOwner,
	port?: RegisterExistingPort,
): Promise<NativeChildProjectionResult> {
	if (!owner) {
		return { status: "projection-unavailable", reason: "invalid-identity" };
	}
	return projectNativeChildInBb({
		providerId: args.providerId ?? "",
		sessionId: args.sessionId ?? "",
		conversationId: args.conversationId ?? "",
		parentProviderThreadId: args.parentProviderThreadId,
		parentThreadId: args.parentThreadId,
		requestId: args.requestId,
		title: args.title,
	}, owner, port);
}

export async function spawnSubthreadInBb(
	args: SubthreadSpawnArgs,
	session: ThreadRegistrationTarget,
	options: SubthreadSpawnerOptions = {},
): Promise<NativeChildProjectionResult> {
	if (!session.registerExisting) {
		return { status: "projection-unavailable", reason: "unsupported-registration-port" };
	}
	const projection = await projectSubthreadInBb(args, options.owner, { registerExisting: session.registerExisting });
	if (projection.status === "registered") {
		session.registerThread(projection.binding.bbThreadId, args.conversationId);
	}
	return projection;
}
