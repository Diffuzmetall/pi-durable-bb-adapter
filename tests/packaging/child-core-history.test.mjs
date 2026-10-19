import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeHistoryRequestSchema } from '../../src/bb-compat/native-history-contract.ts';
import { nativeControlWasAdmitted } from '../../compat/source/native-history-store.ts';
import { openHistorySink } from '../../src/history/history-sink.ts';
const request = { threadId: 'child', providerId: 'pi-durable', providerThreadId: 'session:61', expectedDigest: null,
  snapshot: { status: 'completed', items: [{ source: { entryId: '92', messageIndex: 0, blockIndex: 1 },
    item: { type: 'toolCall', tool: 'bash', arguments: { command: 'printf OK' }, status: 'completed', result: { output: [{ type: 'text', text: 'OK' }] } } }] } };

test('Core history port admits canonical completed tool cards with text output', () => {
  assert.deepEqual(nativeHistoryRequestSchema.parse(request), request);
});
test('Core admits an ordinary 50KB native tool result without clipping', () => {
  const large = structuredClone(request);
  large.snapshot.items[0].item.result.output[0].text = 'x'.repeat(50 * 1024);
  assert.equal(nativeHistoryRequestSchema.parse(large).snapshot.items[0].item.result.output[0].text.length, 50 * 1024);
});

test('Core only replaces a UI request after its native receipt and exact text match', () => {
  const snapshot = { status: 'working', inputs: [{ entryId: '108', requestId: 'bb-child:creq_23456789ab' }],
    items: [{ source: { entryId: '108', messageIndex: 0, blockIndex: 0 }, item: { type: 'userMessage', content: [{ type: 'text', text: 'follow-up' }] } }] };
  const control = { requestId: 'creq_23456789ab', input: [{ type: 'text', text: 'follow-up' }] };
  assert.equal(nativeControlWasAdmitted(control, snapshot), true);
  assert.equal(nativeControlWasAdmitted({ ...control, requestId: 'creq_98765432ab' }, snapshot), false);
  assert.equal(nativeControlWasAdmitted({ ...control, input: [{ type: 'text', text: 'different' }] }, snapshot), false);
  assert.equal(nativeControlWasAdmitted({ ...control, input: [{ type: 'image', url: 'foreign' }] }, snapshot), false);
  assert.equal(nativeControlWasAdmitted(control, { ...snapshot, inputs: [] }), false);
  assert.equal(nativeHistoryRequestSchema.safeParse({ ...request, snapshot }).success, true);
  assert.equal(nativeHistoryRequestSchema.safeParse({ ...request, snapshot: { ...snapshot, inputs: [...snapshot.inputs, ...snapshot.inputs] } }).success, false);
});

test('explicit Core deferral neither advances CAS nor freezes subsequent native frames', async () => {
  const attempts = [];
  const sink = await openHistorySink({ threadId: 'child', async request(_method, params) {
    attempts.push(params);
    return { threadId: 'child', digest: attempts.length < 3 ? null : 'a'.repeat(64), changed: attempts.length === 3,
      ...(attempts.length === 2 ? { deferred: true } : {}) };
  } });
  assert.equal((await sink.apply({ status: 'working', items: [] })).deferred, true);
  assert.equal((await sink.apply(request.snapshot)).changed, true);
  assert.equal(attempts[2].expectedDigest, null);
});

test('Core port still rejects executable/foreign payload fields and duplicate identities', () => {
  const executable = structuredClone(request);
  executable.snapshot.items[0].item.execute = 'do not execute this';
  assert.equal(nativeHistoryRequestSchema.safeParse(executable).success, false);
  const duplicate = structuredClone(request);
  duplicate.snapshot.items.push(duplicate.snapshot.items[0]);
  assert.equal(nativeHistoryRequestSchema.safeParse(duplicate).success, false);
  const unbounded = structuredClone(request);
  unbounded.snapshot.items[0].item.result.output[0].text = 'x'.repeat(512 * 1024 + 1);
  assert.equal(nativeHistoryRequestSchema.safeParse(unbounded).success, false);
});
