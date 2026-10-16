export interface NativeChildIdentity {
	backendId: string;
	sessionId: string;
	conversationId: string;
}

export interface NativeChildDescriptor extends NativeChildIdentity {
	parentThreadId: string;
	title: string;
}

export interface NativeChildOwner {
	backendId: string;
	sessionId: string;
	parentThreadId: string;
}

export type NativeChildProjectionResult = {
	status: "projection-unavailable";
	reason: "invalid-identity" | "owner-mismatch" | "unsupported-registration-port";
	binding?: Readonly<NativeChildIdentity & { parentThreadId: string; bbThreadId: null }>;
	key?: string;
};

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function nativeChildKey(identity: NativeChildIdentity): string {
	if (![identity.backendId, identity.sessionId, identity.conversationId].every(validId)) {
		throw new TypeError("Native child identity requires backend, session and conversation IDs");
	}
	return JSON.stringify([identity.backendId, identity.sessionId, identity.conversationId]);
}

// No supported zero-input BB registration port is proven. Identity is routing data, not authorization.
export function projectNativeChildInBb(
	child: NativeChildDescriptor,
	owner: NativeChildOwner,
): NativeChildProjectionResult {
	if (![child.backendId, child.sessionId, child.conversationId, child.parentThreadId,
		owner.backendId, owner.sessionId, owner.parentThreadId].every(validId)) {
		return { status: "projection-unavailable", reason: "invalid-identity" };
	}
	if (child.backendId !== owner.backendId || child.sessionId !== owner.sessionId ||
		child.parentThreadId !== owner.parentThreadId) {
		return { status: "projection-unavailable", reason: "owner-mismatch" };
	}
	return {
		status: "projection-unavailable",
		reason: "unsupported-registration-port",
		key: nativeChildKey(child),
		binding: Object.freeze({
			backendId: child.backendId,
			sessionId: child.sessionId,
			conversationId: child.conversationId,
			parentThreadId: child.parentThreadId,
			bbThreadId: null,
		}),
	};
}
