import assert from 'node:assert/strict';
import type { SessionRegistry } from "../../src/provider/host/session-registry.ts";

export function seedManagedSession(registry: SessionRegistry, threadId: string, session: object, providerThreadId?: string): void {
  const managed = session as {
    controlledObservation?: boolean;
    options?: { providerThreadId?: string };
    authorizeObservationThread?: (...args: string[]) => Promise<void>;
    observeThread?: (...args: string[]) => Promise<void>;
  };
  assert.ok(!managed.controlledObservation, 'Managed test fixture must not stub observation authority');
  managed.authorizeObservationThread ??= async () => {};
  managed.observeThread ??= async () => {};
  const bindings = (registry as unknown as { sessions: Map<string, { session: object; providerThreadId: string }> }).sessions;
  bindings.set(threadId, { session, providerThreadId: providerThreadId ?? managed.options?.providerThreadId ?? 'pi_managed_fixture' });
}
