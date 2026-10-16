import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToolOutputType } from '@earendil-works/pi-codemode/declarations';
import { createCodemodeDescription, createCodemodeToolDefinition } from './tool.ts';
import { authorizeAgentMail } from '../../experimental/durable/mcp.ts';
import { Type } from 'typebox';
import { adaptExtensionTool } from '/home/ubuntu/Projects/pi-durable-bb-adapter/candidates/provider/src/runner/tool-adapter.ts';

const schema = {
  type: 'object',
  properties: {
    content: { type: 'array', items: { type: 'object', properties: {
      type: { const: 'text' }, text: { type: 'string' },
    }, required: ['type', 'text'] } },
    structuredContent: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
    isError: { type: 'boolean' },
  },
  required: ['content'],
};
const fixture = { name: 'mcp_fixture', description: 'Synthetic MCP result',
  parameters: { type: 'object', properties: {} }, outputSchema: schema };

test('MCP output declarations use the resolved public CodeMode schema renderer', () => {
  const description = createCodemodeDescription([fixture]);
  assert.ok(description.includes(`Promise<${renderToolOutputType(schema)}>`));
  assert.match(description, /structuredContent\?: \{ result: number; \}/);
  assert.match(description, /isError\?: boolean/);
  assert.match(description, /content: Array</);
  assert.doesNotMatch(description, /Shared MCP Types|McpCallToolResult/);
});

test('default on-mode direct loadout preserves nested output types outside the catalog', () => {
  const loadout = { declared: [fixture], callable: [fixture],
    getExposure: () => 'direct', getNamespace: () => undefined };
  const changes = createCodemodeToolDefinition().prepareLoadout(loadout);
  const direct = changes.descriptions.mcp_fixture;
  assert.match(direct, /structuredContent\?: \{ result: number; \}/);
  assert.match(direct, /content: Array<\{ text: string; type: "text"; \}>/);
  assert.match(direct, /isError\?: boolean/);
  assert.ok(direct.includes(renderToolOutputType(schema)));
  assert.doesNotMatch(changes.descriptions.codemode, /Synthetic MCP result/);
  assert.deepEqual(changes.hiddenDeclarations, []);
});

test('existing provider adapter policy still blocks before execution', async () => {
  let effects = 0, guards = 0;
  const tool = { name: 'mcp_bb0_synthetic_fixture', description: 'Private guard probe',
    parameters: Type.Object({ deny: Type.Boolean() }),
    execute: async () => { effects++; return { content: [{ type: 'text', text: 'allowed-control' }] }; } };
  const policy = { hasHandlers: type => type === 'tool_call', emitToolCall: async event => {
    guards++; return event.input.deny ? { block: true, reason: 'bb0-synthetic-denied' } : undefined;
  } };
  const adapted = adaptExtensionTool(tool, async () => { throw Error('Unexpected nested execution'); }, undefined, () => policy);
  const blocked = await adapted.execute({ deny: true }, { callId: 'bb0-denied', output() {} }, {});
  assert.equal(blocked.isError, true);
  assert.match(blocked.output[0].text, /bb0-synthetic-denied/);
  assert.equal(effects, 0);
  const allowed = await adapted.execute({ deny: false }, { callId: 'bb0-allowed', output() {} }, {});
  assert.equal(effects, 1);
  assert.equal(guards, 2);
  assert.equal(allowed.isError, undefined);
});

test('text output and deferred catalog behavior are preserved', () => {
  assert.match(createCodemodeDescription([{ ...fixture, outputSchema: undefined }]), /Promise<string>/);
  assert.doesNotMatch(createCodemodeDescription([fixture], { deferred: new Set(['mcp_fixture']) }), /Synthetic MCP result/);
});

test('actual production Agent Mail authorization denies before synthetic side effects', () => {
  let effects = 0;
  const project = '/bb0-synthetic-work', actor = 'BB0Synthetic';
  const invoke = (name, args) => { authorizeAgentMail(name, args, project, actor); effects++; };
  assert.throws(() => invoke('send_message', { project_key: '/foreign', sender_name: actor }), /project mismatch/);
  assert.throws(() => invoke('send_message', { project_key: project, sender_name: 'ForeignActor' }), /identity mismatch/);
  assert.throws(() => invoke('force_release_file_reservation', { project_key: project, agent_name: actor }), /separate operator approval/);
  assert.equal(effects, 0);
  invoke('send_message', { project_key: project, sender_name: actor });
  assert.equal(effects, 1);
});
