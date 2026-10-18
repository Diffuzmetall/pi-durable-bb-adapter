export interface ParsedProviderThreadId {
	sessionKey: string;
	conversationId?: string;
}

/**
 * Parses an opaque providerThreadId into sessionKey and optional child conversationId.
 * Format: `${sessionKey}:${conversationId}` or bare `${sessionKey}`.
 */
export function parseProviderThreadId(providerThreadId: string): ParsedProviderThreadId {
	const colonIndex = providerThreadId.indexOf(":");
	if (colonIndex === -1) {
		return { sessionKey: providerThreadId };
	}
	const sessionKey = providerThreadId.slice(0, colonIndex);
	const conversationId = providerThreadId.slice(colonIndex + 1);
	if (!conversationId) {
		return { sessionKey };
	}
	return { sessionKey, conversationId };
}

/**
 * Formats sessionKey and optional child conversationId into a composite providerThreadId.
 */
export function formatProviderThreadId(sessionKey: string, conversationId?: string): string {
	if (!conversationId) return sessionKey;
	return `${sessionKey}:${conversationId}`;
}
