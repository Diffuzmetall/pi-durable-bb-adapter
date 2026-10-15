import test from "node:test";
import assert from "node:assert/strict";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import {
	translateMessageUpdate,
	REASONING_PRESENTATION,
} from "../src/host/message-delta-translator.ts";
import plugin from "../server.ts";

test("DeltaTranslator: thinking_delta emits item.open with Brain icon presentation on first chunk and item.textDelta", () => {
	const translator = new DeltaTranslator();
	const event = {
		type: "message_update",
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: "Analyzing problem...",
		},
	};

	const deltas = translator.translate(event, { threadId: "thr-1" });
	assert.equal(deltas.length, 2);

	const [openDelta, textDelta] = deltas;
	assert.deepEqual(openDelta, {
		kind: "item.open",
		key: { channel: "thinking-0" },
		item: { type: "reasoning", summary: [], content: [] },
		presentation: {
			...REASONING_PRESENTATION,
		},
	});
	assert.deepEqual(textDelta, {
		kind: "item.textDelta",
		key: { channel: "thinking-0" },
		channel: "reasoningText",
		text: "Analyzing problem...",
	});
	assert.equal(REASONING_PRESENTATION.icon.glyph, "Brain");
	assert.equal(REASONING_PRESENTATION.label.pending, "Thinking");
	assert.equal(REASONING_PRESENTATION.label.completed, "Thought");
});

test("DeltaTranslator: subsequent thinking_delta chunks do not re-emit item.open", () => {
	const translator = new DeltaTranslator();
	translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Chunk 1",
			},
		},
		{ threadId: "thr-1" },
	);

	const deltas2 = translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: " Chunk 2",
			},
		},
		{ threadId: "thr-1" },
	);

	assert.equal(deltas2.length, 1);
	assert.deepEqual(deltas2[0], {
		kind: "item.textDelta",
		key: { channel: "thinking-0" },
		channel: "reasoningText",
		text: " Chunk 2",
	});
});

test("DeltaTranslator: thinking_end closes channel with item.textClose and cleans up", () => {
	const translator = new DeltaTranslator();
	translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Chunk 1",
			},
		},
		{ threadId: "thr-1" },
	);

	const endDeltas = translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_end",
				contentIndex: 0,
				content: "Full thought text",
			},
		},
		{ threadId: "thr-1" },
	);

	assert.equal(endDeltas.length, 1);
	assert.deepEqual(endDeltas[0], {
		kind: "item.textClose",
		key: { channel: "thinking-0" },
		channel: "reasoningText",
		text: "Full thought text",
	});
});

test("DeltaTranslator: hideThinking: true injects suppress: true into item.open presentation", () => {
	const translator = new DeltaTranslator();
	const deltas = translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Secret thinking",
			},
		},
		{
			threadId: "thr-1",
			providerOptions: { hideThinking: true },
		},
	);

	assert.equal(deltas.length, 2);
	const [openDelta] = deltas;
	assert.deepEqual(openDelta, {
		kind: "item.open",
		key: { channel: "thinking-0" },
		item: { type: "reasoning", summary: [], content: [] },
		presentation: {
			...REASONING_PRESENTATION,
			suppress: true,
		},
	});
});

test("server.ts: registers settings and deriveProviderOptions forwards settings correctly", () => {
	let registeredSettings: Record<string, unknown> | undefined;
	let registeredProvider: any;

	const mockBb = {
		settings: {
			define(schema: Record<string, unknown>) {
				registeredSettings = schema;
				return schema;
			},
		},
		providers: {
			register(options: any) {
				registeredProvider = options;
				return options;
			},
		},
		onDispose() {},
	};

	plugin(mockBb);

	assert.ok(registeredSettings);
	assert.equal((registeredSettings as any).openThinkingByDefault, undefined);
	assert.ok((registeredSettings as any).hideThinking);
	assert.equal((registeredSettings as any).hideThinking.default, false);

	assert.ok(registeredProvider);
	assert.equal(typeof registeredProvider.deriveProviderOptions, "function");

	// Default context settings
	const defaultDerived = registeredProvider.deriveProviderOptions({});
	assert.deepEqual(defaultDerived, {
		hideThinking: false,
	});

	// Custom context settings
	const customDerived = registeredProvider.deriveProviderOptions({
		settings: {
			hideThinking: true,
		},
	});
	assert.deepEqual(customDerived, {
		hideThinking: true,
	});
});

test("DeltaTranslator: fallback closure closes unclosed thinking channel when text_delta arrives", () => {
	const translator = new DeltaTranslator();
	// Emit thinking_delta without explicit thinking_end
	translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Open thinking chunk",
			},
		},
		{ threadId: "thr-1" },
	);

	// Now text_delta arrives directly
	const deltas = translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				delta: "Direct answer",
			},
		},
		{ threadId: "thr-1" },
	);

	assert.equal(deltas.length, 2);
	assert.deepEqual(deltas[0], {
		kind: "item.textClose",
		key: { channel: "thinking-0" },
		channel: "reasoningText",
		text: "",
	});
	assert.deepEqual(deltas[1], {
		kind: "item.textDelta",
		key: { channel: "agentMessage" },
		channel: "agentMessage",
		text: "Direct answer",
	});
});

test("DeltaTranslator: fallback closure closes unclosed thinking channel when message_end arrives", () => {
	const translator = new DeltaTranslator();
	translator.translate(
		{
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "Open thinking chunk",
			},
		},
		{ threadId: "thr-1" },
	);

	const deltas = translator.translate(
		{
			type: "message_end",
			message: {
				content: [{ type: "text", text: "Answer from message_end" }],
			},
		},
		{ threadId: "thr-1" },
	);

	assert.equal(deltas.length, 2);
	assert.deepEqual(deltas[0], {
		kind: "item.textClose",
		key: { channel: "thinking-0" },
		channel: "reasoningText",
		text: "",
	});
	assert.deepEqual(deltas[1], {
		kind: "item.textClose",
		key: { channel: "agentMessage" },
		channel: "agentMessage",
		text: "Answer from message_end",
	});
});
