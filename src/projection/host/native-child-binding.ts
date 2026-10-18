export interface NativeChildIdentity {
	providerId: string;
	sessionId: string;
	conversationId: string;
}

export interface NativeChildDescriptor extends NativeChildIdentity {
	parentProviderThreadId: string;
	parentThreadId?: string;
	requestId?: string;
	title?: string;
}

export interface NativeChildOwner {
	providerId: string;
	sessionId: string;
	parentProviderThreadId: string;
	parentThreadId: string;
}

export interface RegisterExistingRequest {
	requestId: string;
	sessionId: string;
	conversationId: string;
	parentProviderThreadId: string;
	providerId?: string;
	parentThreadId?: string;
	title?: string;
}

export interface RegisterExistingPort {
	registerExisting(request: RegisterExistingRequest): Promise<{ threadId: string }>;
}

export type NativeChildProjectionResult =
	| {
			status: "registered";
			key: string;
			binding: Readonly<NativeChildIdentity & { parentThreadId: string; bbThreadId: string }>;
	  }
	| {
			status: "projection-unavailable";
			reason: "invalid-identity" | "owner-mismatch" | "unsupported-registration-port" | "registration-unconfirmed";
		};

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function nativeChildKey(identity: NativeChildIdentity): string {
	if (![identity.providerId, identity.sessionId, identity.conversationId].every(validId)) {
		throw new TypeError("Native child identity requires provider, session and conversation IDs");
	}
	return JSON.stringify([identity.providerId, identity.sessionId, identity.conversationId]);
}

function validateOwner(child: NativeChildDescriptor, owner: NativeChildOwner): NativeChildProjectionResult | undefined {
	if (![child.providerId, child.sessionId, child.conversationId, child.parentProviderThreadId,
		owner.providerId, owner.sessionId, owner.parentProviderThreadId, owner.parentThreadId].every(validId) ||
		(child.parentThreadId !== undefined && !validId(child.parentThreadId))) {
		return { status: "projection-unavailable", reason: "invalid-identity" };
	}
	if (child.providerId !== owner.providerId || child.sessionId !== owner.sessionId ||
		child.parentProviderThreadId !== owner.parentProviderThreadId ||
		(child.parentThreadId !== undefined && child.parentThreadId !== owner.parentThreadId)) {
		return { status: "projection-unavailable", reason: "owner-mismatch" };
	}
	return undefined;
}

export function nativeChildRegistrationRequestId(child: NativeChildDescriptor): string {
	if (![child.providerId, child.sessionId, child.conversationId, child.parentProviderThreadId].every(validId)) {
		throw new TypeError("Native child registration request requires provider, session, conversation and mapped parent provider thread IDs");
	}
	if (child.requestId !== undefined) {
		if (!validId(child.requestId) || child.requestId.length > 200) throw new TypeError("Native child registration requestId is invalid");
		return child.requestId;
	}
	return JSON.stringify([child.providerId, child.sessionId, child.conversationId, child.parentProviderThreadId]);
}

// The authenticated Core route, not this routing tuple, decides whether the caller may register the conversation.
export async function projectNativeChildInBb(
	child: NativeChildDescriptor,
	owner: NativeChildOwner,
	port?: RegisterExistingPort,
): Promise<NativeChildProjectionResult> {
	const invalid = validateOwner(child, owner);
	if (invalid) return invalid;
	if (!port) return { status: "projection-unavailable", reason: "unsupported-registration-port" };

	try {
		const { threadId } = await port.registerExisting({
			requestId: nativeChildRegistrationRequestId(child),
			sessionId: child.sessionId,
			conversationId: child.conversationId,
			parentProviderThreadId: child.parentProviderThreadId,
			providerId: child.providerId,
			...(child.parentThreadId ? { parentThreadId: child.parentThreadId } : {}),
			...(validId(child.title) ? { title: child.title } : {}),
		});
		if (!validId(threadId)) return { status: "projection-unavailable", reason: "registration-unconfirmed" };
		return {
			status: "registered",
			key: nativeChildKey(child),
			binding: Object.freeze({
				providerId: child.providerId,
				sessionId: child.sessionId,
				conversationId: child.conversationId,
				parentThreadId: owner.parentThreadId,
				bbThreadId: threadId,
			}),
		};
	} catch {
		// A lost response may follow a committed registration; stable requestId makes retry safe.
		return { status: "projection-unavailable", reason: "registration-unconfirmed" };
	}
}
