import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { HistoricalSnapshot } from '../../src/bb-compat/native-history-contract.ts';
export type { HistoricalSnapshot } from '../../src/bb-compat/native-history-contract.ts';

export const HISTORY_PLUGIN = "bb.core.native-history";
export const REGISTRATION_PLUGIN = "bb.core.native-registration";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Inject existing BB repository helpers so the same implementation runs in matched bundles. */
export interface NativeHistoryCore {
  getThread: typeof import("@bb/db").getThread;
  getEnvironment: typeof import("@bb/db").getEnvironment;
  getThreadPluginMetadata: typeof import("@bb/db").getThreadPluginMetadata;
  appendStoredThreadEventsInTransaction: typeof import("@bb/db").appendStoredThreadEventsInTransaction;
  events: typeof import("@bb/db").events;
  threads: typeof import("@bb/db").threads;
  parseStoredThreadEvent: typeof import("@bb/domain").parseStoredThreadEvent;
  toStoredThreadEventData: (event: ReturnType<NativeHistoryCore["parseStoredThreadEvent"]>) => Record<string, unknown>;
  threadSearchSegments: typeof import("@bb/db").threadSearchSegments;
  threadPluginMetadata: typeof import("@bb/db").threadPluginMetadata;
  eq: typeof import("drizzle-orm").eq;
  and: typeof import("drizzle-orm").and;
  inArray: typeof import("drizzle-orm").inArray;
  bumpThreadEventRewriteGeneration: (threadId: string) => void;
}

export interface NativeHistoryInput {
  threadId: string;
  providerId: string;
  providerThreadId: string;
  expectedDigest?: string | null;
  snapshot?: HistoricalSnapshot;
}
export interface NativeHistoryResult { threadId: string; digest: string | null; changed: boolean; deferred?: true; turnId?: string }
export class NativeHistoryError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** Provenance only, after Core authorization; this predicate grants no rights. */
export function nativeControlWasAdmitted(control: { requestId: string; input: unknown }, snapshot: HistoricalSnapshot): boolean {
  const receipt = snapshot.inputs?.find(receipt => receipt.requestId === `bb-child:${control.requestId}`);
  const nativeText = receipt && snapshot.items.filter(item => item.source.entryId === receipt.entryId && item.item.type === 'userMessage')
    .flatMap(item => item.item.type === 'userMessage' ? item.item.content.map(block => block.text) : []).join('\n').trim();
  const controlText = Array.isArray(control.input) && control.input.every(block => block?.type === 'text' && typeof block.text === 'string')
    ? control.input.map(block => block.text).join('\n').trim() : undefined;
  return receipt !== undefined && nativeText === controlText;
}

export function reconcileNativeHistory(
  db: import("@bb/db").DbConnection,
  hostId: string,
  input: NativeHistoryInput,
  core: NativeHistoryCore,
): NativeHistoryResult {
  const { eq, inArray, events, threadSearchSegments } = core;
  const result = db.transaction((tx) => {
    // All identity/ownership checks happen inside the write transaction, before history reads.
    const thread = core.getThread(tx, input.threadId);
    const binding = core.getThreadPluginMetadata(tx, input.threadId, REGISTRATION_PLUGIN);
    const b = binding.metadata;
    const parent = typeof b.parentThreadId === "string" ? core.getThread(tx, b.parentThreadId) : undefined;
    const environment = thread?.environmentId ? core.getEnvironment(tx, thread.environmentId) : undefined;
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null || binding.corrupt ||
      b.kind !== "native-existing" || b.hostId !== hostId || b.providerId !== input.providerId ||
      input.providerThreadId !== `${b.sessionId}:${b.conversationId}` ||
      thread.providerId !== input.providerId || !parent || parent.deletedAt !== null || parent.archivedAt !== null ||
      thread.parentThreadId !== parent.id || thread.environmentId !== parent.environmentId ||
      !environment || environment.hostId !== hostId) {
      throw new NativeHistoryError(404, "Registered native child not found in requester scope");
    }
    const receipt = core.getThreadPluginMetadata(tx, input.threadId, HISTORY_PLUGIN);
    const old = receipt.metadata;
    if (receipt.corrupt || (old.digest !== undefined && (typeof old.digest !== "string" || old.version !== 1))) {
      throw new NativeHistoryError(409, "Corrupt native history ownership metadata");
    }
    const digest = typeof old.digest === "string" ? old.digest : null;
    const stored = tx.select().from(events).where(eq(events.threadId, input.threadId)).orderBy(events.sequence).all();
    const controlRows: typeof stored = [];
    const rejectedRequests = new Set<string>();
    // Core records transport loss without consulting the external native owner.
    // Retain that exact lifecycle batch, but never mistake its synthetic turn
    // interruption for native transcript mutation or native execution outcome.
    const lifecycleData = (row: typeof stored[number]): Record<string, unknown> | undefined => {
      const hostDisconnect = row.type === 'system/thread/interrupted' && row.scopeKind === 'thread';
      if ((row.environmentId !== thread.environmentId && !(hostDisconnect && row.environmentId === null))
        || (row.providerThreadId !== null && row.providerThreadId !== input.providerThreadId) || row.itemId !== null || row.itemKind !== null || row.parentToolCallId !== null) return;
      if (row.scopeKind !== 'thread' && row.scopeKind !== 'turn' || row.scopeKind === 'thread' && row.turnId !== null
        || row.scopeKind === 'turn' && !row.turnId) return;
      try {
        const data = JSON.parse(row.data);
        const scope = row.scopeKind === 'thread' ? { kind: 'thread' as const } : { kind: 'turn' as const, turnId: row.turnId! };
        const event = core.parseStoredThreadEvent({ type: row.type, threadId: input.threadId, scope, data });
        if (('providerThreadId' in event && event.providerThreadId !== input.providerThreadId)
          || !isDeepStrictEqual(data, core.toStoredThreadEventData(event))) return;
        return data;
      } catch { return; }
    };
    const disconnects = stored.filter(row => row.type === 'system/thread/interrupted' && row.scopeKind === 'thread'
      && lifecycleData(row)?.reason === 'host-daemon-restarted');
    const disconnectTimes = new Set(disconnects.map(row => Number(row.createdAt)).filter(Number.isSafeInteger));
    const disconnectErrors = stored.filter(row => {
      if (row.type !== 'system/error' || !disconnectTimes.has(Number(row.createdAt))) return false;
      const data = lifecycleData(row);
      return data?.code === 'thread_command_failed' && data.message === 'Thread interrupted because the host daemon disconnected'
        && data.detail === 'Please retry the thread to continue.';
    });
    const interruptedTurns = new Set(disconnectErrors.filter(row => row.scopeKind === 'turn')
      .map(row => JSON.stringify([Number(row.createdAt), row.turnId])));
    const lifecycleIds = new Set([...disconnects, ...disconnectErrors, ...stored.filter(row => row.type === 'turn/completed'
      && interruptedTurns.has(JSON.stringify([Number(row.createdAt), row.turnId])) && lifecycleData(row)?.status === 'interrupted')].map(row => row.id));
    const rows = stored.filter((row) => {
      if (lifecycleIds.has(row.id)) return false;
      let commandError = false;
      if (row.type === 'system/error') {
        try { commandError = JSON.parse(row.data).code === 'thread_command_failed'; } catch { /* Mixed malformed rows remain protected. */ }
      }
      if (row.type === 'client/turn/requested' || row.type === 'client/turn/rejected' || commandError) {
        if (row.environmentId !== thread.environmentId || (row.providerThreadId !== null && row.providerThreadId !== input.providerThreadId)
          || row.scopeKind !== 'thread' || row.turnId !== null || row.itemId !== null || row.itemKind !== null || row.parentToolCallId !== null)
          throw new NativeHistoryError(409, 'Foreign native control bookkeeping');
        try {
          const data = JSON.parse(row.data);
          const event = core.parseStoredThreadEvent({ type: row.type, threadId: input.threadId, scope: { kind: 'thread' }, data });
          const canonical = core.toStoredThreadEventData(event);
          // Core's client-event writer omits decoder defaults (mentions/system
          // labels). Validate its schema, but don't require absent defaults.
          if (Object.keys(data).some(key => !Object.hasOwn(canonical, key))) throw Error('Unknown control fields');
        } catch { throw new NativeHistoryError(409, 'Malformed native control bookkeeping'); }
        if (row.type === 'client/turn/requested') controlRows.push(row);
        if (row.type === 'client/turn/rejected') rejectedRequests.add(JSON.parse(row.data).requestId);
        return false;
      }
      // Only these exact canonical, correctly scoped non-transcript events may coexist.
      // A prefix or parse failure must never turn unknown/live data into bookkeeping.
      if (row.type !== "thread/identity" && row.type !== "provider.env-resolved") return true;
      if (row.environmentId !== thread.environmentId || row.providerThreadId !== input.providerThreadId ||
        row.scopeKind !== "thread" || row.turnId !== null || row.itemId !== null ||
        row.itemKind !== null || row.parentToolCallId !== null) {
        throw new NativeHistoryError(409, "Malformed or foreign history bookkeeping");
      }
      try {
        const data: Record<string, unknown> = JSON.parse(row.data);
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Nonobject bookkeeping");
        const event = core.parseStoredThreadEvent({ type: row.type, threadId: input.threadId,
          scope: { kind: "thread" }, data });
        if (!("providerThreadId" in event) || event.providerThreadId !== input.providerThreadId ||
          !isDeepStrictEqual(data, core.toStoredThreadEventData(event))) throw new Error("Noncanonical bookkeeping");
      } catch {
        throw new NativeHistoryError(409, "Malformed or foreign history bookkeeping");
      }
      return false;
    });
    // Both getDigest and apply validate the owned transcript fingerprint. Bookkeeping
    // remains byte-for-byte untouched and does not change the transcript CAS domain.
    if ((digest === null && rows.length !== 0) ||
      (digest !== null && (old.rowCount !== rows.length || old.rowsDigest !== hash(rows)))) {
      throw new NativeHistoryError(409, "Mixed or modified history cannot be replaced");
    }
    if (input.snapshot === undefined) return { threadId: input.threadId, digest, changed: false };
    const snapshot = input.snapshot;
    const identity = [b.hostId, b.providerId, b.sessionId, b.conversationId, input.threadId];
    const nextDigest = hash([identity, snapshot, "historical-origin-v3"]);
    const lastInput = snapshot.items.findLast(entry => entry.item.type === 'userMessage')?.source.entryId ?? null;
    const turnId = `nh-t-${hash([identity, lastInput])}`; // BB presentation, not a native run ID.
    if (digest === nextDigest && !controlRows.length) return { threadId: input.threadId, digest, changed: false, turnId };
    if (input.expectedDigest !== digest) throw new NativeHistoryError(409, "Native history changed; stale snapshot refused");
    // Core records the UI command before native admission. Never remove it or
    // clear active status until the native receipt AND exact input agree.
    const admittedControls: typeof stored = [];
    for (const row of controlRows) {
      const control = JSON.parse(row.data);
      if (nativeControlWasAdmitted(control, snapshot)) admittedControls.push(row);
      else if (!rejectedRequests.has(control.requestId)) return { threadId: input.threadId, digest, changed: false, deferred: true };
      // Rejected/unconfirmed attempts stay verbatim, including their errors.
      // Only an actual native receipt can replace their original UI request.
    }
    if (digest === nextDigest && !admittedControls.length) return { threadId: input.threadId, digest, changed: false, turnId };
    if (!["pending", "idle", "error"].includes(thread.status)
      && !(thread.status === 'active' && (admittedControls.length > 0 || old.nativeStatus === 'working'))) {
      throw new NativeHistoryError(409, "Cannot replace history of an executing BB thread");
    }
    const scope = { kind: "turn" as const, turnId };
    const base = { threadId: input.threadId, environmentId: thread.environmentId, providerThreadId: input.providerThreadId, scope };
    const eventArgs: Parameters<NativeHistoryCore["appendStoredThreadEventsInTransaction"]>[1][number][] = [];
    if (snapshot.items.length > 0) {
      eventArgs.push({ ...base, type: "turn/started", data: { providerThreadId: input.providerThreadId } });
      for (const entry of snapshot.items) {
        const id = `nh-i-${hash([identity, entry.source.entryId, entry.source.messageIndex, entry.source.blockIndex])}`;
        const item = { ...entry.item, id, ...(entry.item.type === "userMessage" ? { origin: "historical" as const } : {}) };
        eventArgs.push({ ...base, type: entry.item.type === 'toolCall' && entry.item.status === 'pending' ? 'item/started' : 'item/completed',
          data: { providerThreadId: input.providerThreadId, item } });
      }
      if (snapshot.status !== 'working') eventArgs.push({ ...base, type: "turn/completed", data: { providerThreadId: input.providerThreadId, status: snapshot.status } });
    }
    const reasoning = snapshot.agent?.thinkingLevel === 'off' ? 'none' : snapshot.agent?.thinkingLevel;
    tx.update(core.threads).set({ status: snapshot.status === 'working' ? 'active' : snapshot.status === "failed" ? "error" : "idle",
      // A registered child has no synthetic thread/start execution. Use its
      // authoritative native model for Core's composer/dispatch metadata only.
      ...(snapshot.agent ? { modelOverride: snapshot.agent.model } : {}),
      ...(reasoning && ['none', 'low', 'medium', 'high', 'xhigh', 'ultracode', 'max', 'ultra'].includes(reasoning)
        ? { reasoningLevelOverride: reasoning } : {}),
    }).where(eq(core.threads.id, input.threadId)).run();
    // Append before removal retains increasing sequence numbers for changed nonempty snapshots.
    core.appendStoredThreadEventsInTransaction(tx, eventArgs);
    const replaced = [...rows, ...admittedControls];
    if (replaced.length > 0) {
      tx.delete(threadSearchSegments).where(core.and(eq(threadSearchSegments.threadId, input.threadId),
        inArray(threadSearchSegments.sourceSeq, replaced.map((row) => row.sequence)))).run();
      tx.delete(events).where(inArray(events.id, replaced.map((row) => row.id))).run();
    }
    const retained = new Set(stored.filter((row) => !replaced.includes(row)).map((row) => row.id));
    const finalRows = tx.select().from(events).where(eq(events.threadId, input.threadId)).orderBy(events.sequence).all()
      .filter((row) => !retained.has(row.id));
    // Same existing namespace upsert as patchThreadPluginMetadata, but inside this transaction.
    // Its public helper takes DbConnection, not DbTransaction; the bounded receipt is <1KiB.
    const metadataJson = JSON.stringify({ version: 1, digest: nextDigest, nativeStatus: snapshot.status, rowCount: finalRows.length, rowsDigest: hash(finalRows) });
    tx.insert(core.threadPluginMetadata).values({ threadId: input.threadId, pluginId: HISTORY_PLUGIN, metadataJson })
      .onConflictDoUpdate({ target: [core.threadPluginMetadata.threadId, core.threadPluginMetadata.pluginId], set: { metadataJson } }).run();
    return { threadId: input.threadId, digest: nextDigest, changed: true, turnId };
  }, { behavior: "immediate" });
  // No live event ingestion/effects, queue admission, or model callbacks.
  if (result.changed) core.bumpThreadEventRewriteGeneration(input.threadId);
  return result;
}
