import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCoherentHistory } from '../../src/history/history-projector.ts';

const entry = (id, kind, model, data) => ({ id, conversationId: 61, kind, model: [model], ...(data === undefined ? {} : { data }) });
const user = (id, text) => entry(id, 'pi.user', { role: 'user', content: text });
const assistant = (id, content) => entry(id, 'pi.assistant', { role: 'assistant', content });
const text = value => ({ type: 'text', text: value });
const frame = entries => ({ status: 'completed', entries });

// Same failure shape as the real child: tool-bearing first turn, a non-JSON
// final answer, then another input and an ordinary JSON (not ChildReport) answer.
const history = [
  entry(90, 'pi.system', { role: 'system', content: '' }),
  user(91, 'Inspect available tools'),
  assistant(92, [{ type: 'thinking', thinking: 'private reasoning' },
    { type: 'toolCall', id: 'native-call-1', name: 'bash', arguments: { command: 'printf TOOL_OK' } }]),
  entry(93, 'pi.tool-result', { role: 'toolResult', toolCallId: 'native-call-1', toolName: 'bash', content: [text('TOOL_OK')], isError: false }, { diagnostics: [] }),
  assistant(94, [text('A natural-language final answer, not a report')]),
  user(120, 'Explain what you can do'),
  assistant(125, [text('{"available_tools":["bash"],"can_do":[],"limits":[]}')]),
];

test('projects tool output and both native turns without interpreting answer text as a report', () => {
  const { snapshot, omissions } = projectCoherentHistory(frame(history));
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.items.map(item => item.item.type), ['userMessage', 'toolCall', 'agentMessage', 'userMessage', 'agentMessage']);
  const call = snapshot.items[1];
  assert.deepEqual(call.source, { entryId: '92', messageIndex: 0, blockIndex: 1 });
  assert.equal(call.item.tool, 'bash');
  assert.deepEqual(call.item.arguments, { command: 'printf TOOL_OK' });
  assert.equal(call.item.status, 'completed');
  assert.deepEqual(call.item.result, { output: [text('TOOL_OK')] });
  assert.equal(omissions.length, 1);
  assert.ok(!JSON.stringify(snapshot).includes('private reasoning'));
  assert.equal(snapshot.items.at(-1).item.text, history.at(-1).model[0].content[0].text);
  assert.deepEqual(projectCoherentHistory(frame(history)), { snapshot, omissions });
});

test('active native history exposes accepted inputs and pending tools without terminal success', () => {
  const active = projectCoherentHistory({ status: 'working', reason: 'observed-active', entries: history.slice(0, 3) });
  assert.equal(active.snapshot.status, 'working');
  assert.deepEqual(active.snapshot.items.map(entry => entry.item.type), ['userMessage', 'toolCall']);
  assert.equal(active.snapshot.items[1].item.status, 'pending');
});

test('keeps native tool failure distinct from successful execution', () => {
  const failed = structuredClone(history);
  failed[3].model[0].isError = true;
  const call = projectCoherentHistory(frame(failed)).snapshot.items.find(item => item.item.type === 'toolCall').item;
  assert.equal(call.status, 'failed');
  assert.deepEqual(call.result, { output: [text('TOOL_OK')] });
});

test('refuses orphan/duplicate tool results instead of silently dropping them', () => {
  assert.throws(() => projectCoherentHistory(frame([history[3]])), /tool.*call|orphan/i);
  const duplicate = { ...history[3], id: 95 };
  assert.throws(() => projectCoherentHistory(frame([...history, duplicate])), /tool.*call|duplicate|orphan/i);
});

test('allows native tool call IDs to be reused in later turns without merging calls', () => {
  const repeated = structuredClone(history);
  repeated.splice(-1, 0, { ...history[2], id: 121 }, { ...history[3], id: 122 });
  const calls = projectCoherentHistory(frame(repeated)).snapshot.items.filter(item => item.item.type === 'toolCall');
  assert.equal(calls.length, 2);
  assert.notDeepEqual(calls[0].source, calls[1].source);
  assert.ok(calls.every(call => call.item.status === 'completed'));
});
