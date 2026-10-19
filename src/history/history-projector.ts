import type { SnapshotEvent } from '@earendil-works/pi-durable';
import type { CoherentOutcome } from "../outcome/coherent.ts";

import type { HistoricalItem, HistoricalSnapshot } from '../bb-compat/native-history-contract.ts';
export type { HistoricalItem, HistoricalSnapshot } from '../bb-compat/native-history-contract.ts';
type ThinkingOmission = { source: HistoricalItem['source']; kind: 'thinking' };
export type CoherentHistoryProjection = {
  snapshot: HistoricalSnapshot;
  omissions: readonly ThinkingOmission[];
};

function unsupported(reason: string): never {
  throw new Error(`Unsupported child history: ${reason}`);
}
function record(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unsupported(`${location} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) unsupported(`${location} must be an array`);
  return value;
}
function nativeId(value: unknown, location: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) unsupported(`${location} must be a positive safe native ID`);
  return value;
}

function terminalStatus(value: unknown): HistoricalSnapshot['status'] {
  if (value !== 'completed' && value !== 'failed' && value !== 'interrupted') unsupported('explicit terminal status is required');
  return value;
}

/**
 * Full immutable transcript projection, not effective model context or live state.
 * pi.system positional prompt/tool declarations are deliberately not chat items:
 * public SystemEntry is [SystemMessage] with empty content. All other unsupported
 * entries/roles/blocks fail the WHOLE projection rather than returning partial text.
 * Usage, timestamps, provider metadata and byTaskId are not transcript content.
 */
export function projectChildHistory(
  snapshot: SnapshotEvent,
  explicitTerminalStatus: HistoricalSnapshot['status'],
): HistoricalSnapshot {
  const status = terminalStatus(explicitTerminalStatus);
  const input = record(snapshot, 'snapshot');
  if (input.type !== 'snapshot') unsupported('expected SnapshotEvent');
  // No absent-run inference. Also refuse to label an unfinished partial as history.
  if (input.run !== undefined || input.generation !== undefined || input.compactionFailure !== undefined) unsupported('snapshot contains live run/generation or compaction failure');
  for (const key of ['tools', 'nestedTools', 'compactions', 'inbox']) {
    if (array(input[key], `snapshot.${key}`).length) unsupported(`snapshot.${key} is not settled`);
  }
  return projectEntries(array(input.entries, 'snapshot.entries'), status);
}

/**
 * Project this capture only. Known assistant thinking is explicitly excluded from
 * presentation with source-only accounting; raw frame entries remain untouched.
 */
export function projectCoherentHistory(frame: CoherentOutcome): CoherentHistoryProjection {
  const input = record(frame, 'coherent frame');
  const status = input.status === 'working' ? 'working' : terminalStatus(input.status);
  const omissions: ThinkingOmission[] = [];
  const snapshot = projectEntries(array(input.entries, 'coherent frame.entries'), status, omissions);
  if (input.agent !== undefined) {
    const agent = record(input.agent, 'native agent');
    if (typeof agent.model !== 'string' || !agent.model.trim() || typeof agent.thinkingLevel !== 'string' || !agent.thinkingLevel.trim())
      unsupported('invalid native model metadata');
    snapshot.agent = { model: agent.model as string, thinkingLevel: agent.thinkingLevel as string };
  }
  if (input.inputs !== undefined) {
    const seen = new Set<string>();
    snapshot.inputs = array(input.inputs, 'coherent frame.inputs').map(value => {
      const receipt = record(value, 'input receipt');
      if (typeof receipt.entryId !== 'string' || typeof receipt.requestId !== 'string' || !receipt.requestId.trim()
        || seen.has(receipt.requestId) || !snapshot.items.some(item => item.source.entryId === receipt.entryId && item.item.type === 'userMessage'))
        unsupported('input receipt does not identify a unique native user entry');
      seen.add(receipt.requestId as string);
      return { entryId: receipt.entryId as string, requestId: receipt.requestId as string };
    });
  }
  return { snapshot, omissions };
}

// Only the coherent path supplies an accumulator. Legacy conversion stays strict.
function projectEntries(entries: readonly unknown[], status: HistoricalSnapshot['status'], omissions?: ThinkingOmission[]): HistoricalSnapshot {
  const items: HistoricalItem[] = [];
  const ids = new Set<number>();
  const pendingTools = new Map<string, Extract<HistoricalItem['item'], { type: 'toolCall' }>>();
  for (const value of entries) {
    const entry = record(value, 'entry');
    const id = nativeId(entry.id, 'entry.id');
    nativeId(entry.conversationId, `entry ${id}.conversationId`);
    if (ids.has(id)) unsupported(`duplicate entry ID ${id}`);
    ids.add(id);
    const location = `entry ${id}`;
    const toolResult = omissions !== undefined && entry.kind === 'pi.tool-result';
    // Native tool result data is execution metadata, not another chat message.
    if (entry.data !== undefined) {
      if (!toolResult) unsupported(`${location} has application data`);
      const data = record(entry.data, `${location}.data`);
      if (Object.keys(data).some(key => key !== 'diagnostics') || !Array.isArray(data.diagnostics)) unsupported(`${location} has unsupported tool metadata`);
      // SDK renders diagnostics into model.content; don't duplicate them.
    }
    if (entry.head !== undefined || entry.edits !== undefined) unsupported(`${location} has context head/edits`);
    if (!['pi.user', 'pi.assistant', 'pi.system'].includes(entry.kind as string) && !toolResult) unsupported(`${location} kind is not supported`);
    const messages = array(entry.model, `${location}.model`);
    if (!messages.length) unsupported(`${location} has no messages`);
    if (entry.kind === 'pi.system' && messages.length !== 1) unsupported(`${location} pi.system must contain one positional system message`);
    for (const [messageIndex, value] of messages.entries()) {
      const at = `${location} message ${messageIndex}`;
      const message = record(value, at);
      if (entry.kind === 'pi.system') {
        if (message.role !== 'system' || message.content !== '') unsupported(`${at} is not an empty-content positional pi.system message`);
        continue;
      }
      if (toolResult) {
        if (messages.length !== 1 || message.role !== 'toolResult' || typeof message.toolCallId !== 'string'
          || typeof message.toolName !== 'string' || typeof message.isError !== 'boolean') unsupported(`${at} is not a native tool result`);
        const call = pendingTools.get(message.toolCallId as string);
        if (!call || call.tool !== message.toolName) unsupported(`${at} has an orphan or duplicate tool call result`);
        const output = array(message.content, `${at}.content`).map((value, blockIndex) => {
          const block = record(value, `${at} block ${blockIndex}`);
          if (block.type !== 'text' || typeof block.text !== 'string') unsupported(`${at} block ${blockIndex} is not a supported tool output`);
          return { type: 'text' as const, text: block.text as string };
        });
        call.status = message.isError ? 'failed' : 'completed';
        call.result = { output };
        pendingTools.delete(message.toolCallId as string);
        continue;
      }
      const role = entry.kind === 'pi.user' ? 'user' : 'assistant';
      if (message.role !== role) unsupported(`${at} role must be ${role}`);
      if ((message.errorMessage !== undefined && (!omissions || role !== 'assistant' || typeof message.errorMessage !== 'string')) || message.deferred !== undefined ||
        (message.diagnostics !== undefined && array(message.diagnostics, `${at}.diagnostics`).length)) unsupported(`${at} has non-text error/deferred/diagnostic content`);
      const blocks = typeof message.content === 'string' && role === 'user'
        ? [{ type: 'text', text: message.content }]
        : array(message.content, `${at}.content`);
      if (!blocks.length && message.errorMessage === undefined) unsupported(`${at} has no text blocks`);
      let presentableBlocks = 0;
      for (const [blockIndex, value] of blocks.entries()) {
        const block = record(value, `${at} block ${blockIndex}`);
        const source = { entryId: String(id), messageIndex, blockIndex };
        if (omissions && role === 'assistant' && block.type === 'thinking') {
          // Public SDK ThinkingContent: never copy opaque thinking/signatures into
          // chat, accounting or errors; unfamiliar payload shapes still fail closed.
          if (typeof block.thinking !== 'string' ||
            (block.thinkingSignature !== undefined && typeof block.thinkingSignature !== 'string') ||
            (block.redacted !== undefined && typeof block.redacted !== 'boolean') ||
            Object.keys(block).some(key => !['type', 'thinking', 'thinkingSignature', 'redacted'].includes(key))) {
            unsupported(`${at} block ${blockIndex} is malformed ThinkingContent`);
          }
          omissions.push({ source, kind: 'thinking' });
          continue;
        }
        if (omissions && role === 'assistant' && block.type === 'toolCall') {
          if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name
            || pendingTools.has(block.id)) unsupported(`${at} block ${blockIndex} has an invalid or duplicate tool call`);
          const item: Extract<HistoricalItem['item'], { type: 'toolCall' }> = { type: 'toolCall', tool: block.name,
            arguments: record(block.arguments, `${at} block ${blockIndex}.arguments`), status: status === 'working' ? 'pending' : 'interrupted' };
          pendingTools.set(block.id, item);
          items.push({ source, item });
          presentableBlocks++;
          continue;
        }
        if (block.type !== 'text' || typeof block.text !== 'string') unsupported(`${at} block ${blockIndex} is not text`);
        presentableBlocks++;
        items.push({
          source,
          item: role === 'user'
            ? { type: 'userMessage', content: [{ type: 'text', text: block.text }] }
            : { type: 'agentMessage', text: block.text },
        });
      }
      if (omissions && typeof message.errorMessage === 'string') {
        items.push({ source: { entryId: String(id), messageIndex, blockIndex: blocks.length },
          item: { type: 'agentMessage', text: `Native model error: ${message.errorMessage}` } });
        presentableBlocks++;
      }
      if (!presentableBlocks && !omissions) unsupported(`${at} has no text blocks for presentation`);
    }
  }
  if (pendingTools.size && status === 'completed') unsupported('completed history contains an unsettled tool call');
  return { status, items };
}
