import { defineDoc, type ConversationId, type JsonObject, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export type DurableBinding = {
	readonly providerId: string;
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly bbThreadId: string;
	readonly parentThreadId?: string;
};

type StoredBinding = {
	readonly providerId: string;
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly bbThreadId: string;
	readonly parentThreadId: string | null;
};

type BindingState = JsonObject & { binding: StoredBinding | null };
type BindingIndex = JsonObject & { byIdentity: Record<string, ConversationId> };

const BindingDoc = defineDoc<BindingState>({
	kind: "bb.native-child-binding",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ binding: null }),
});

const BindingIndexDoc = defineDoc<BindingIndex>({
	kind: "bb.native-child-binding-index",
	version: 1,
	scope: "session",
	initial: () => ({ byIdentity: {} }),
});

export type DurableBindingIdentity = Pick<DurableBinding, "providerId" | "sessionId" | "bbThreadId">;

export interface DurableBindingReader {
	get(conversationId: ConversationId): Promise<DurableBinding | undefined>;
	findByThread(identity: DurableBindingIdentity): Promise<DurableBinding | undefined>;
}

export interface DurableBindingStore extends DurableBindingReader {
	put(binding: DurableBinding): Promise<void>;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateBinding(value: DurableBinding): void {
	if (
		!value ||
		!nonEmpty(value.providerId) ||
		!nonEmpty(value.sessionId) ||
		!Number.isSafeInteger(value.conversationId) ||
		value.conversationId <= 0 ||
		!nonEmpty(value.bbThreadId) ||
		(value.parentThreadId !== undefined && !nonEmpty(value.parentThreadId))
	) {
		throw new TypeError("Invalid durable child binding");
	}
}

function toStoredBinding(binding: DurableBinding): StoredBinding {
	return {
		providerId: binding.providerId,
		sessionId: binding.sessionId,
		conversationId: binding.conversationId,
		bbThreadId: binding.bbThreadId,
		parentThreadId: binding.parentThreadId ?? null,
	};
}

function fromStoredBinding(value: unknown, expectedConversationId: ConversationId): DurableBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Corrupt durable child binding");
	}
	const binding = value as StoredBinding;
	if (
		binding.conversationId !== expectedConversationId ||
		!nonEmpty(binding.providerId) ||
		!nonEmpty(binding.sessionId) ||
		!nonEmpty(binding.bbThreadId) ||
		(binding.parentThreadId !== null && !nonEmpty(binding.parentThreadId))
	) {
		throw new Error("Corrupt durable child binding");
	}
	const result: DurableBinding = {
		providerId: binding.providerId,
		sessionId: binding.sessionId,
		conversationId: binding.conversationId,
		bbThreadId: binding.bbThreadId,
		...(binding.parentThreadId === null ? {} : { parentThreadId: binding.parentThreadId }),
	};
	validateBinding(result);
	return result;
}

function identityKey(binding: DurableBindingIdentity): string {
	return JSON.stringify([binding.providerId, binding.sessionId, binding.bbThreadId]);
}

function sameBinding(left: StoredBinding, right: StoredBinding): boolean {
	return left.providerId === right.providerId &&
		left.sessionId === right.sessionId &&
		left.conversationId === right.conversationId &&
		left.bbThreadId === right.bbThreadId &&
		left.parentThreadId === right.parentThreadId;
}

/** Read-only persistence capability; callers must authorize before revealing a binding or history. */
export function createDurableBindingReader(api: Pick<ToolExecutionApi, "snapshot">, context: Context): DurableBindingReader {
	return {
		async get(conversationId) {
			if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
				throw new TypeError("Invalid Durable conversation ID");
			}
			const state = await api.snapshot(BindingDoc, conversationId, context);
			if (state === undefined || state.binding === null) return undefined;
			return fromStoredBinding(state.binding, conversationId);
		},
		async findByThread(identity) {
			if (!identity || !nonEmpty(identity.providerId) || !nonEmpty(identity.sessionId) || !nonEmpty(identity.bbThreadId)) {
				throw new TypeError("Invalid BB thread identity");
			}
			const key = identityKey(identity);
			const conversationId = (await api.snapshot(BindingIndexDoc, context))?.byIdentity[key];
			if (conversationId === undefined || !Number.isSafeInteger(conversationId) || conversationId <= 0) return undefined;
			const state = await api.snapshot(BindingDoc, conversationId, context);
			if (state === undefined || state.binding === null) return undefined;
			const binding = fromStoredBinding(state.binding, conversationId);
			if (identityKey(binding) !== key) return undefined;
			return binding;
		},
	};
}

/**
 * Persistence only, not an authorization boundary. Construct inside a registered tool's active execute() callback
 * with that invocation's public ToolExecutionApi and Context; do not retain it after the invocation ends.
 */
export function createDurableBindingStore(api: Pick<ToolExecutionApi, "commit" | "snapshot">, context: Context): DurableBindingStore {
	return {
		async put(binding) {
			validateBinding(binding);
			const stored = toStoredBinding(binding);
			await api.commit(async (tx) => {
				if (!(await tx.conversation(binding.conversationId))) {
					throw new Error(`Conversation ${binding.conversationId} does not exist`);
				}
				const index = await tx.doc(BindingIndexDoc);
				const key = identityKey(stored);
				const indexedConversation = index.byIdentity[key];
				if (indexedConversation !== undefined && indexedConversation !== binding.conversationId) {
					throw new Error(`BB thread ${binding.bbThreadId} is already bound to another Durable conversation`);
				}
				const state = await tx.doc(BindingDoc, binding.conversationId);
				if (state.binding === null) {
					state.binding = stored;
					index.byIdentity[key] = binding.conversationId;
					return;
				}
				if (!sameBinding(state.binding, stored)) {
					throw new Error(`Conversation ${binding.conversationId} already has a different BB binding`);
				}
				index.byIdentity[key] = binding.conversationId;
			}, context);
		},
		...createDurableBindingReader(api, context),
	};
}
