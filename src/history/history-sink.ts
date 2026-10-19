import type { HistoricalSnapshot } from './history-projector.ts';
export type { HistoricalSnapshot } from './history-projector.ts';

export interface CoreResult { threadId: string; digest: string | null; changed: boolean; deferred?: true }
export type HistoryRequester = (method: string, params: {
  threadId: string; snapshot?: HistoricalSnapshot; expectedDigest?: string | null;
}) => Promise<unknown>;

function receipt(value: unknown, threadId: string, mutation: boolean): CoreResult {
  const result = value as CoreResult | null;
  if (!result || result.threadId !== threadId || typeof result.changed !== "boolean" ||
    !(result.digest === null || (typeof result.digest === "string" && /^[a-f0-9]{64}$/.test(result.digest))) ||
    (result.deferred !== undefined && (result.deferred !== true || result.changed || !mutation)) ||
    (mutation ? result.digest === null && !result.deferred : result.changed)) {
    throw new Error("Invalid history reconciliation acknowledgement");
  }
  return { threadId, digest: result.digest, changed: result.changed, ...(result.deferred ? { deferred: true as const } : {}) };
}

/**
 * Await opening BEFORE native observation/capture: Core authorizes this digest read.
 * Producers must await each apply before producing the next snapshot; no queue exists.
 * Core authorizes and checks provenance before identical-content no-op, BEFORE CAS.
 * Its current RPC rejection is generic (conflict and lost ACK are indistinguishable).
 * After any rejection only an explicit identical retry is allowed, never read/rebase.
 */
export async function openHistorySink({ threadId, request }: {
  threadId: string; request: HistoryRequester;
}): Promise<{ apply(snapshot: HistoricalSnapshot): Promise<CoreResult> }> {
  if (typeof threadId !== "string" || !threadId || threadId.length > 200 || typeof request !== "function") {
    throw new Error("History threadId and existing RPC requester are required");
  }
  const method = "thread/reconcileExisting";
  let expectedDigest = receipt(await request(method, { threadId }), threadId, false).digest;
  let busy = false;
  let pending: { json: string; cause: unknown } | undefined;

  return {
    async apply(snapshot) {
      if (busy) throw new Error("Concurrent history apply refused; await the preceding apply");
      // Own the wire payload, not the caller's mutable objects. Retain at most one attempt.
      const json = JSON.stringify(snapshot);
      if (!json) throw new Error("History snapshot is required");
      if (pending && pending.json !== json) {
        throw new Error("History sink frozen after unacknowledged apply; retry identical snapshot only", { cause: pending.cause });
      }
      busy = true;
      try {
        const result = receipt(await request(method, {
          threadId, snapshot: JSON.parse(json) as HistoricalSnapshot, expectedDigest,
        }), threadId, true);
        if (result.deferred && result.digest !== expectedDigest) throw new Error('Deferred history response changed its digest');
        expectedDigest = result.digest; // ACK only; deferral explicitly has no mutation.
        pending = undefined;
        return result;
      } catch (cause) {
        pending = { json, cause };
        throw cause;
      } finally {
        busy = false;
      }
    },
  };
}
