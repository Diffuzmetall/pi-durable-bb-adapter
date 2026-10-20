import { createHash } from 'node:crypto';
import { rootRecoveryDigest, rootRecoveryRequestSchema, rootRecoveryReceiptSchema, type RootRecoveryBackup, type RootRecoveryRequest } from '../../src/bb-compat/native-root-recovery-contract.ts';
import { NativeHistoryError, type NativeHistoryCore } from './native-history-store.ts';

export const ROOT_RECOVERY_PLUGIN = 'bb.core.native-root-recovery';

/** Explicit operator repair, not normal attach. The existing Core remains the only writer. */
export function recoverNativeRoot(db: import('@bb/db').DbConnection, hostId: string,
  raw: RootRecoveryRequest, core: NativeHistoryCore) {
  const input = rootRecoveryRequestSchema.parse(raw);
  const result = db.transaction(tx => {
    const thread = core.getThread(tx, input.threadId);
    const environment = thread?.environmentId ? core.getEnvironment(tx, thread.environmentId) : undefined;
    const canonical = `pi_durable_bb_${createHash('sha256').update(input.threadId).digest('hex')}`;
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null || thread.parentThreadId !== null ||
      thread.providerId !== 'pi-durable' || input.providerThreadId !== canonical || !environment || environment.hostId !== hostId)
      throw new NativeHistoryError(404, 'Native root not found in requester scope');
    if (!['idle', 'error'].includes(thread.status)) throw new NativeHistoryError(409, 'Root recovery requires a non-executing BB thread');
    const rows = tx.select().from(core.events).where(core.eq(core.events.threadId, input.threadId)).orderBy(core.events.sequence).all();
    const data = (row: typeof rows[number]): Record<string, any> => {
      if (row.threadId !== thread.id || (row.environmentId !== null && row.environmentId !== thread.environmentId) ||
        (row.providerThreadId !== null && row.providerThreadId !== input.providerThreadId))
        throw new NativeHistoryError(409, 'Foreign root history cannot be repaired');
      try {
        const value = JSON.parse(row.data);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
        if (value.providerThreadId !== undefined && value.providerThreadId !== input.providerThreadId) throw Error();
        return value;
      } catch { throw new NativeHistoryError(409, 'Invalid root history'); }
    };
    const decoded = rows.map(row => ({ row, data: data(row) }));
    if (!decoded.some(entry => entry.row.type === 'thread/identity' && entry.data.providerThreadId === input.providerThreadId))
      throw new NativeHistoryError(409, 'Persisted native root identity required');
    const receipt = core.getThreadPluginMetadata(tx, input.threadId, ROOT_RECOVERY_PLUGIN);
    if (receipt.corrupt || (Object.keys(receipt.metadata).length && !rootRecoveryReceiptSchema.safeParse(receipt.metadata).success))
      throw new NativeHistoryError(409, 'Corrupt root recovery receipt');
    const backup: RootRecoveryBackup = { protocol: 'bb-native-root-recovery-backup/v1', hostId,
      threadId: input.threadId, providerThreadId: input.providerThreadId, thread, events: rows, metadata: receipt.metadata };
    const backupDigest = rootRecoveryDigest(backup);
    if (input.operation === 'prepare') return { status: 'prepared' as const, threadId: input.threadId, backupDigest, backup };

    const snapshotDigest = rootRecoveryDigest(input.snapshot);
    const stateDigest = () => rootRecoveryDigest([core.getThread(tx, input.threadId),
      tx.select().from(core.events).where(core.eq(core.events.threadId, input.threadId)).orderBy(core.events.sequence).all()]);
    const old = receipt.metadata;
    if (old.backupDigest === input.backupDigest && old.snapshotDigest === snapshotDigest && old.afterStateDigest === stateDigest())
      return { status: 'recovered' as const, threadId: input.threadId, changed: false, turnId: String(old.turnId), itemId: String(old.itemId) };
    if (input.backupDigest !== backupDigest) throw new NativeHistoryError(409, 'Root changed after backup; no automatic rebase');

    const turn = decoded.findLast(entry => entry.row.type === 'turn/started' && entry.row.scopeKind === 'turn' && entry.row.turnId);
    if (!turn) throw new NativeHistoryError(409, 'Existing BB turn required; recovery never creates a new turn');
    const turnId = turn.row.turnId!;
    const accepted = new Map<string, { turnId: string; text: string }>();
    for (const entry of decoded.filter(entry => entry.row.type === 'turn/input/accepted')) {
      const requestId = entry.data.clientRequestId;
      const requests = decoded.filter(candidate => candidate.row.type === 'client/turn/requested' && candidate.data.requestId === requestId);
      const chunks = requests[0]?.data.input;
      if (typeof requestId !== 'string' || requests.length !== 1 || entry.row.scopeKind !== 'turn' || !entry.row.turnId ||
        !Array.isArray(chunks) || !chunks.length || chunks.some(chunk => chunk?.type !== 'text' || typeof chunk.text !== 'string'))
        throw new NativeHistoryError(409, 'Unprovable accepted root input lineage');
      const value = { turnId: entry.row.turnId, text: chunks.map(chunk => chunk.text).join('\n').trim() };
      const previous = accepted.get(requestId);
      if (previous && (previous.turnId !== value.turnId || previous.text !== value.text))
        throw new NativeHistoryError(409, 'Conflicting accepted root input');
      accepted.set(requestId, value);
    }
    const lineage = [...accepted.values()];
    // Root input RPC has no native admission receipt. Refuse repeated text rather than guessing
    // which identical request ran; compacted/external/missing native inputs also refuse recovery.
    if (!lineage.length || lineage.at(-1)!.turnId !== turnId || lineage.length !== input.snapshot.inputs.length ||
      new Set(lineage.map(value => value.text)).size !== lineage.length ||
      lineage.some((value, index) => value.text !== input.snapshot.inputs[index].text))
      throw new NativeHistoryError(409, 'Native input lineage does not uniquely match accepted BB requests');

    // Repair an unfinished matching text item in place; never erase an earlier completed answer or tool history.
    const messages = new Map<string, { text: string; complete: boolean }>();
    for (const entry of decoded.filter(entry => entry.row.turnId === turnId && entry.row.parentToolCallId === null)) {
      const { type } = entry.row, item = entry.data.item;
      if (['item/started', 'item/completed'].includes(type) && item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string')
        messages.set(item.id, { text: item.text, complete: type === 'item/completed' });
      if (type === 'item/agentMessage/delta' && typeof entry.data.itemId === 'string' && typeof entry.data.delta === 'string') {
        const previous = messages.get(entry.data.itemId);
        if (!previous || previous.complete) throw new NativeHistoryError(409, 'Ambiguous streamed root message');
        previous.text += entry.data.delta;
      }
    }
    const candidates = [...messages.entries()].filter(([, value]) => value.text === input.snapshot.answerText ||
      (!value.complete && value.text.length > 0 && input.snapshot.answerText.startsWith(value.text)));
    const last = [...messages.entries()].at(-1);
    if (candidates.length > 1 || (candidates.length === 1 && candidates[0][0] !== last?.[0]))
      throw new NativeHistoryError(409, 'Ambiguous root answer item; no automatic replacement');
    const matching = candidates.length === 1;
    const itemId = matching ? last![0] : `nr-i-${rootRecoveryDigest([hostId, input.providerThreadId, turnId, input.snapshot.sessionId, input.snapshot.answerEntryId])}`;
    const base = { threadId: input.threadId, environmentId: thread.environmentId, providerThreadId: input.providerThreadId,
      scope: { kind: 'turn' as const, turnId } };
    const appended: Parameters<NativeHistoryCore['appendStoredThreadEventsInTransaction']>[1][number][] = [];
    if (!matching || !last![1].complete) appended.push({ ...base, type: 'item/completed',
      data: { providerThreadId: input.providerThreadId, item: { type: 'agentMessage', id: itemId, text: input.snapshot.answerText } } });
    const completed = decoded.findLast(entry => entry.row.turnId === turnId && entry.row.type === 'turn/completed');
    if (!completed || completed.data.status !== input.snapshot.status) appended.push({ ...base, type: 'turn/completed',
      data: { providerThreadId: input.providerThreadId, status: input.snapshot.status } });
    // No removal, input acceptance, dispatch, queue drain or model callback. Backup protects the original status too.
    core.appendStoredThreadEventsInTransaction(tx, appended);
    tx.update(core.threads).set({ status: input.snapshot.status === 'failed' ? 'error' : 'idle' }).where(core.eq(core.threads.id, input.threadId)).run();
    const metadataJson = JSON.stringify({ version: 1, backupDigest: input.backupDigest, snapshotDigest,
      afterStateDigest: stateDigest(), turnId, itemId });
    tx.insert(core.threadPluginMetadata).values({ threadId: input.threadId, pluginId: ROOT_RECOVERY_PLUGIN, metadataJson })
      .onConflictDoUpdate({ target: [core.threadPluginMetadata.threadId, core.threadPluginMetadata.pluginId], set: { metadataJson } }).run();
    return { status: 'recovered' as const, threadId: input.threadId, changed: true, turnId, itemId };
  }, { behavior: 'immediate' });
  if (result.status === 'recovered' && result.changed) core.bumpThreadEventRewriteGeneration(input.threadId);
  return result;
}
