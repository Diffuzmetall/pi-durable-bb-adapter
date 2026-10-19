import { z } from 'zod';

// BB-only wire contract shared by the adapter and the existing Core history port.
// Historical tools are inert data: no attachment ownership or executable payloads.
const source = z.object({ entryId: z.string().min(1).max(200),
  messageIndex: z.number().int().min(0).max(10000), blockIndex: z.number().int().min(0).max(10000) }).strict();
const text = z.string().max(512 * 1024); // Native read/bash commonly return 50KB blocks; whole request remains bounded.
const textBlock = z.object({ type: z.literal('text'), text }).strict();
const item = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agentMessage'), text }).strict(),
  z.object({ type: z.literal('userMessage'), content: z.array(textBlock).min(1).max(32) }).strict(),
  z.object({ type: z.literal('toolCall'), tool: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()),
    status: z.enum(['completed', 'failed', 'interrupted', 'pending']),
    result: z.object({ output: z.array(textBlock).max(32) }).strict().optional() }).strict(),
]);
export const nativeHistoryRequestSchema = z.object({
  threadId: z.string().min(1).max(200), providerId: z.string().min(1).max(200),
  providerThreadId: z.string().min(1).max(1025),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  snapshot: z.object({ status: z.enum(['completed', 'failed', 'interrupted', 'working']),
    agent: z.object({ model: z.string().min(1).max(1024), thinkingLevel: z.string().min(1).max(32) }).strict().optional(),
    inputs: z.array(z.object({ entryId: z.string().min(1).max(200), requestId: z.string().min(1).max(1024) }).strict()).max(1000).optional(),
    items: z.array(z.object({ source, item }).strict()).max(1000) }).strict().optional(),
}).strict().superRefine((request, context) => {
  if (request.snapshot && request.expectedDigest === undefined)
    context.addIssue({ code: 'custom', message: 'expectedDigest is required for mutation' });
  const keys = request.snapshot?.items.map(entry => JSON.stringify(entry.source)) ?? [];
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate native item identity' });
  const inputs = request.snapshot?.inputs ?? [];
  if (new Set(inputs.map(input => input.requestId)).size !== inputs.length || new Set(inputs.map(input => input.entryId)).size !== inputs.length
    || inputs.some(input => !request.snapshot?.items.some(item => item.source.entryId === input.entryId && item.item.type === 'userMessage')))
    context.addIssue({ code: 'custom', message: 'Invalid native input receipt identity' });
});
export type HistoricalSnapshot = NonNullable<z.infer<typeof nativeHistoryRequestSchema>['snapshot']>;
export type HistoricalItem = HistoricalSnapshot['items'][number];
