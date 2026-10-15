# Implementation Plan: Arch Improvement Cycle 69 (Thread Fork via Checkpoint ID & ACID State Copy)

**Cycle:** 69  
**Target Release:** `v0.2.15`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences:** D-11 extension (Full `thread/fork` RPC parity with checkpoint rewinding)  

---

## 1. Problem Statement & Primary Sources

### 1.1 The Blank Slate Bug in `thread/fork`
In Beyond Boundaries IDE:
When a user forks a thread (either via the "Fork" button in the UI or by branching from an earlier message in thread history), BB sends JSON-RPC `thread/fork`:
```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "thread/fork",
  "params": {
    "threadId": "thr_child123",
    "sourceProviderThreadId": "pi_durable_parent",
    "sourceProviderCheckpointId": "102",
    "cwd": "/path/to/project",
    "options": { ... }
  }
}
```
Currently in `src/host/bridge.ts` (lines 86–91):
```typescript
case "thread/fork": {
    const threadId = params.threadId;
    const providerThreadId = `pi_durable_${Date.now()}`;
    await this.registry.createOrGet(threadId, providerThreadId, params);
    this.sendResult(id, { providerThreadId, sessionRestorable: true });
    break;
}
```
**Defect:** `params.sourceProviderThreadId` and `params.sourceProviderCheckpointId` are completely ignored!
The forked thread starts with an empty database. All context, earlier messages, tools, and thoughts from the parent thread are lost.

### 1.2 Primary Source Parity (`provider-pi` and `@earendil-works/pi-durable`)
1. In `provider-pi` (`host.js:514`): `handleThreadFork` validates that `sourceFile` exists, copies session data into `targetFile` up to `checkpointId`, and registers the child session.
2. In `@earendil-works/pi-durable`: Conversation entries are stored in `entries` table (`id INTEGER PRIMARY KEY`, `conversation_id`). The checkpoint ID emitted on `turn.boundary` in Cycle 68 is the exact numerical tail `EntryId`.
3. With Node.js 22's built-in `node:sqlite`, we can perform atomic database copy and checkpoint pruning safely and deterministically without external tools.

---

## 2. Step-by-Step Implementation Slices

### Slice 1: Database Fork Service (`src/host/thread-fork.ts`)
Create `src/host/thread-fork.ts` (< 150 lines, AP-019):
- `export interface ForkSessionOptions { sourceProviderThreadId: string; targetProviderThreadId: string; checkpointId?: string; env?: NodeJS.ProcessEnv; }`
- Resolves source session directory via `resolveSessionFilePath(sourceProviderThreadId)` and handles legacy `.jsonl` fallback.
- Validates that source directory and `session.sqlite` exist (throws typed error if missing).
- Creates target session directory.
- Copies `session.sqlite` (and `session.sqlite-wal` / `-shm` if present) to target directory.
- Opens target database via `DatabaseSync` (`node:sqlite`):
  - Runs `PRAGMA wal_checkpoint(TRUNCATE)` to merge any active WAL pages into the main file.
  - If `checkpointId` is specified and is a valid number:
    `DELETE FROM entries WHERE id > ?`
  - Removes any stale `.lock` files in the target directory to ensure clean acquisition.

### Slice 2: Wire `thread/fork` in `Bridge` (`src/host/bridge.ts`)
- In `case "thread/fork"`:
  ```typescript
  case "thread/fork": {
      const threadId = params.threadId;
      const sourceProviderThreadId = params.sourceProviderThreadId;
      const checkpointId = params.sourceProviderCheckpointId;
      const targetProviderThreadId = `pi_durable_${Date.now()}`;

      try {
          if (sourceProviderThreadId) {
              forkSessionDatabase({
                  sourceProviderThreadId,
                  targetProviderThreadId,
                  checkpointId,
              });
          }
          await this.registry.createOrGet(threadId, targetProviderThreadId, params);
          this.sendResult(id, { providerThreadId: targetProviderThreadId, sessionRestorable: true });
      } catch (err) {
          this.sendError(id, -32000, err instanceof Error ? err.message : String(err));
      }
      break;
  }
  ```

### Slice 3: Deterministic Test Suite (`tests/thread-fork.test.ts`)
Create `tests/thread-fork.test.ts` (< 200 lines, AP-028):
1. **Tip Fork:** Fork without checkpoint preserves all parent entries in the child database.
2. **Checkpoint Fork:** Fork with `checkpointId` prunes entries after `checkpointId`.
3. **Missing Parent Fail-Fast:** Forking from non-existent parent throws descriptive error.
4. **RPC Integration:** Calling `Bridge` with `method: "thread/fork"` yields `{ providerThreadId, sessionRestorable: true }`.

### Slice 4: Verification, Version Bump & Tag
1. Run `npm test` and ensure all 79+ tests pass.
2. Verify AP-019 line limits (< 250 lines).
3. Verify AP-029 strict TypeScript (zero `as any`).
4. Bump `package.json` to `"version": "0.2.15"`.
5. Record Cycle 69 in `docs/arch-improvement/ledger.md`.
6. Commit & tag `v0.2.15`.
7. Reload plugin: `bb plugin reload provider-pi-durable`.
