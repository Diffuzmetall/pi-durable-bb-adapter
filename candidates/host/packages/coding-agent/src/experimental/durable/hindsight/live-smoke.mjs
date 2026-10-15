#!/usr/bin/env node
// One isolated Durable conversation with real Hindsight tool calls. Never opens
// an existing user's SQLite session. Writes to live memory only with --write.
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness, watchEvents } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createHindsightExtension, resolveContextBinding, bindContextAdmission } from './extension.mjs';
import { resolvePiConfig, resolveHostMemory } from './bridge.mjs';

const cwd = resolve(process.cwd());
const args = process.argv.slice(2);
const write = args.length === 1 && args[0] === '--write';
const verifyId = args.length === 2 && args[0] === '--verify' ? args[1] : undefined;
if (args.length && !write && !verifyId) throw new Error('Usage: node hindsight/live-smoke.mjs [--write | --verify DOCUMENT_ID]');
const { cfg, bankId } = resolvePiConfig(cwd);
if (cfg.disabled || !bankId) throw new Error('Hindsight is disabled for this workspace');
async function waitForDocument(id) {
  const { client } = resolveHostMemory('pi', cwd);
  for (let attempt = 0; attempt < 12; attempt++) {
    if ((await client.listDocumentIds('source:upload')).has(id)) return true;
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}
if (verifyId) {
  const found = await waitForDocument(verifyId);
  console.log(`bank=${bankId} document=${verifyId} ${found ? 'present' : 'not visible after polling'}`);
  if (!found) process.exitCode = 1;
} else {
const runId = randomUUID();
const title = `pi-durable-live-smoke-${runId}`;
const docId = title;
const dbDir = resolve('agent-sessions');
await mkdir(dbDir, { recursive: true });
const database = resolve(dbDir, `hindsight-live-smoke-${runId}.sqlite`);
let stage = 0;
const call = (name, args) => ({ type: 'toolCall', id: `smoke-${stage++}`, name, arguments: args });
const answer = content => ({ role: 'assistant', content, stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(), provider: 'synthetic', model: 'live-smoke', api: 'synthetic', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const models = { getModel: () => ({ provider: 'synthetic', id: 'live-smoke', contextWindow: 100000, maxTokens: 1000 }), streamSimple: () => {
  const message = Promise.resolve(answer(stage === 0
    ? [call('hindsight_diagnose', {}), ...(write ? [call('hindsight_ingest_document', {
      title, content: `Synthetic integration smoke ${runId}: Hindsight tools were invoked through a separate Pi Durable conversation in the pi-durable-playground workspace. This is test evidence, not a product fact.`
    })] : [])]
    : [{ type: 'text', text: 'Tool calls finished; check the receipts, not this synthetic answer.' }]));
  return { async *[Symbol.asyncIterator]() { const result = await message; yield { type: 'done', reason: result.stopReason, message: result }; }, result: () => message };
} };
const registry = createRegistry();
let harness;
let storage;
registry.install(createHindsightExtension({
  getHost: () => ({ session: harness, storage }),
  buildContext: async () => ({ context: '', snapshot: {} }),
}));
// A separate SQLite database is retained for auditing the actual ToolTask results.
storage = await openNodeSqliteStorage(database);
harness = await Harness.open(storage, { registry, models, settings: { compaction: { enabled: false }, retry: { enabled: false } } }, context);
const toolResults = [];
let stream;
try {
  const root = await harness.root(context, { agent: { cwd, model: { provider: 'synthetic', modelId: 'live-smoke' } } });
  const binding = await resolveContextBinding(cwd);
  const requestId = `live-smoke:${runId}`;
  await harness.commit(tx => bindContextAdmission(tx, root.id, requestId, binding), context);
  stream = await watchEvents(harness, root.id, context);
  stream.start(events => {
    for (const event of events) {
      if (event.type === 'tool_execution_start' && event.toolName?.startsWith('hindsight_')) console.log(`CALL ${event.toolName}`);
      if (event.type === 'tool_execution_end' && event.toolName?.startsWith('hindsight_')) {
        toolResults.push({ name: event.toolName, error: Boolean(event.isError) });
        console.log(`RESULT ${event.toolName} ${event.isError ? 'ERROR' : 'returned'}`);
      }
    }
  });
  console.log(`session=${database} bank=${bankId} mode=${write ? 'one live write' : 'read only'}`);
  const settled = await (await root.submit({ type: 'input', content: 'Run the predeclared Hindsight smoke tools.', requestId }, context)).wait(context);
  await harness.waitForIdle(context);
  await new Promise(resolve => setTimeout(resolve, 0));
  console.log(`Durable submission=${settled.status}; Hindsight calls=${toolResults.length}`);
  if (settled.status !== 'done' || toolResults.length !== (write ? 2 : 1) || toolResults.some(r => r.error)) throw new Error('Hindsight tool receipt failed');
  if (write) {
    const found = await waitForDocument(docId);
    console.log(`Bank document receipt=${found ? 'present' : 'not visible after polling'}; doc_id=${docId}`);
    if (!found) throw new Error('Write tool returned, but bank document not visible');
    console.log('Extraction is asynchronous; a document receipt alone does not prove extraction completed.');
  }
} finally {
  stream?.stop?.();
  await harness.close(context);
}
}
