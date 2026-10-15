// Run: node --import ~/.local/share/pi-durable/global-runtime.mjs --test <this file>
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createMultiMcpCodemodeExtension } from './mcp-codemode.ts';

const tool = { name: 'health_check', description: 'Report test health', inputSchema: {
  type: 'object', properties: { project: { type: 'string' } }, required: ['project'], additionalProperties: false,
} };
async function run(code, authorize = () => {}, options = {}) {
  const calls = [];
  const extension = await createMultiMcpCodemodeExtension([{
    server: 'test', allowedTools: ['health_check'], directTools: [], authorize, timeoutMs: options.timeoutMs,
    client: { listTools: async () => [{ ...tool, ...options.tool }], callTool: async (name, args, request) => {
      calls.push({ name, args });
      if (options.clientCall) return options.clientCall(name, args, request);
      return { content: [{ type: 'text', text: 'MCP_HEALTH_OK' }] };
    } },
  }]);
  const registry = createRegistry(); registry.install(CodingTools); registry.install(extension);
  const faux = fauxProvider(); let messages, offered;
  faux.setResponses([
    (transcript) => { offered = transcript.messages.flatMap((m) => m.role === 'system' ? m.toolsAdded ?? [] : []); return fauxAssistantMessage([
      fauxToolCall('codemode', { code }, { id: 'code-test' }),
    ], { stopReason: 'toolUse' }); },
    (transcript) => { messages = transcript.messages; return fauxAssistantMessage('DONE'); },
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const directory = await mkdtemp(join(tmpdir(), 'native-codemode-'));
  const env = new NodeExecutionEnv({ cwd: directory });
  const harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'session.sqlite')),
    { models, registry, env: async () => env }, context);
  try {
    const root = await harness.root(context, { agent: { cwd: directory, model: { provider: 'faux', modelId: 'faux-1' } } });
    const outcome = await (await root.submit({ type: 'input', content: 'Run exact regression' }, context)).wait(context);
    assert.equal(outcome.status, 'done', JSON.stringify(outcome));
    const message = messages?.findLast((m) => m.role === 'toolResult' && m.toolName === 'codemode');
    assert.ok(message, 'model must receive the persisted CodeMode tool result');
    return { message, text: message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'), calls, offered };
  } finally { await harness.close(context); await env.cleanup(context); }
}

test('native CodeMode persists text, console and return for the model', async () => {
  const result = await run('text("CODE_TEXT"); console.log("CODE_CONSOLE"); return "CODE_RETURN";');
  assert.equal(result.message.isError, false);
  for (const marker of ['CODE_TEXT', 'CODE_CONSOLE', 'CODE_RETURN']) assert.ok(result.text.includes(marker), result.text);
});
test('native CodeMode preserves script errors', async () => {
  const result = await run('throw new Error("CODE_ERROR");');
  assert.equal(result.message.isError, true); assert.match(result.text, /CODE_ERROR/);
});
test('discovery and nested MCP use the real Harness executor with per-call authorization', async () => {
  let authorized = 0;
  const result = await run('text(await searchTools("health_check")); text(await describeTool("mcp__test__health_check")); text(await tools.mcp__test__health_check({project:"test"})); text(await tools.mcp__test__health_check({project:"test"}));', () => { authorized++; });
  assert.equal(result.message.isError, false, result.text); assert.match(result.text, /mcp__test__health_check/);
  assert.match(result.text, /MCP_HEALTH_OK/); assert.equal(authorized, 2); assert.equal(result.calls.length, 2);
  assert.ok(!result.offered.some((t) => t.name === 'mcp__test__health_check'), 'codemode-only MCP must stay hidden from model');
});
test('bad arguments and denied identity never reach the MCP client', async () => {
  for (const [args, authorize] of [['{}', () => { throw new Error('schema must reject first'); }],
    ['{project:"other"}', () => { throw new Error('IDENTITY_DENIED'); }]]) {
    const result = await run(`await tools.mcp__test__health_check(${args});`, authorize);
    assert.equal(result.message.isError, true); assert.equal(result.calls.length, 0);
    assert.ok(result.text.length > 0, 'the model must see the rejection');
  }
});
test('CodeMode can call existing coding tools, not only MCP', async () => {
  const result = await run('text(await tools.bash({command:"printf NATIVE_BASH_OK"}));');
  assert.equal(result.message.isError, false, result.text); assert.match(result.text, /NATIVE_BASH_OK/);
});
test('configured deadline cannot be extended by script options and cancels nested MCP', async () => {
  let cancelled = false;
  const result = await run('// @options: {"timeout_ms":100000}\nawait tools.mcp__test__health_check({project:"test"}); text("AFTER_CALL");', undefined, {
    timeoutMs: 800,
    clientCall: (_name, _args, {signal}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({content:[{type:'text',text:'TOO_LATE'}]}), 2500);
      const abort = () => { cancelled = true; clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once:true});
    }),
  });
  assert.equal(result.message.isError, true, result.text); assert.doesNotMatch(result.text, /AFTER_CALL/);
  assert.equal(result.calls.length, 1, 'test must enter the nested MCP call'); assert.equal(cancelled, true);
});
test('MCP structured results retain schema and values, and errors still reject', async () => {
  const outputSchema = {type:'object',properties:{count:{type:'number'}},required:['count']};
  const result = await run('const r=await tools.mcp__test__health_check({project:"test"}); text(r.count);', undefined, {
    tool:{outputSchema}, clientCall:async()=>({content:[{type:'text',text:'MCP_HEALTH_OK'}],structuredContent:{count:7}}),
  });
  assert.equal(result.message.isError,false,result.text); assert.match(result.text,/7/); assert.doesNotMatch(result.text,/undefined/);
  const error = await run('await tools.mcp__test__health_check({project:"test"}); text("NOT_ALLOWED");', undefined, {
    tool:{outputSchema}, clientCall:async()=>({isError:true,content:[{type:'text',text:'MCP_SERVER_DENIED'}],structuredContent:{count:7}}),
  });
  assert.equal(error.message.isError,true,error.text); assert.match(error.text,/MCP_SERVER_DENIED/); assert.doesNotMatch(error.text,/NOT_ALLOWED/);
});
test('tools-only MCP discovery does not advertise an incompatible model tool_search', async () => {
  const result = await run('text(await searchTools("health_check"));');
  assert.equal(result.message.isError,false,result.text); assert.match(result.text,/health_check/);
  assert.ok(!result.offered.some(t=>t.name==='tool_search'));
});
