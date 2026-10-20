import { nativeHistoryRequestSchema } from '../../src/bb-compat/native-history-contract.ts';
import { rootRecoveryRequestSchema } from '../../src/bb-compat/native-root-recovery-contract.ts';
import { recoverNativeRoot } from './native-root-recovery.ts';
export { nativeHistoryRequestSchema } from '../../src/bb-compat/native-history-contract.ts';
import type { Hono, Context } from "hono";
import {
  NativeHistoryError, reconcileNativeHistory, type NativeHistoryCore,
} from './native-history-store.ts';

export function registerNativeHistoryRoutes(
  app: Hono, deps: { db: Parameters<typeof reconcileNativeHistory>[0];
    hub: { notifyThread(threadId: string, changes: ('history-rewritten' | 'status-changed')[], metadata: { projectId: string }): unknown } }, core: NativeHistoryCore,
  authenticatedDaemon: (context: Context) => { hostId: string },
): void {
  app.post('/hosts/threads/recover-native-root', async (context) => {
    const daemon = authenticatedDaemon(context);
    const raw = await context.req.text();
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) return context.json({ error: 'Root recovery request too large' }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = rootRecoveryRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Invalid root recovery request' }, 400);
    try {
      const result = recoverNativeRoot(deps.db, daemon.hostId, parsed.data, core);
      if (result.status === 'recovered' && result.changed) {
        const thread = core.getThread(deps.db, result.threadId)!;
        deps.hub.notifyThread(result.threadId, ['history-rewritten', 'status-changed'], { projectId: thread.projectId });
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof NativeHistoryError) return context.json({ error: error.message }, error.status);
      throw error;
    }
  });
  app.post("/hosts/threads/reconcile-existing", async (context) => {
    const daemon = authenticatedDaemon(context);
    // Bounded canonical historical DTO; tools are inert data, never execution.
    const raw = await context.req.text();
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024) return context.json({ error: "History snapshot too large" }, 413);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return context.json({ error: "Invalid JSON" }, 400); }
    const parsed = nativeHistoryRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid historical projection" }, 400);
    try {
      const result = reconcileNativeHistory(deps.db, daemon.hostId, parsed.data, core);
      if (result.changed) {
        const thread = core.getThread(deps.db, result.threadId)!;
        deps.hub.notifyThread(result.threadId, ["history-rewritten", "status-changed"], { projectId: thread.projectId });
      }
      return context.json(result);
    } catch (error) {
      if (error instanceof NativeHistoryError) return context.json({ error: error.message }, error.status);
      throw error;
    }
  });
}
