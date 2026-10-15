# Implementation Plan: Arch Improvement Cycle 71 (Orphan Eviction, Worker Teardown & Multi-DataDir Runner Discovery, D-20 & Issue #7)

**Cycle:** 71  
**Target Release:** `v0.2.17`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Target Repository:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Target Divergences & Issues:** D-20 (Session Lock Contention & Orphan Process Leaks), GitHub Issue #7 (Install Portability on Custom `--data-dir`)  

---

## 1. Problem Statement & Primary Sources

### 1.1 The Session Lock Contention & Orphan Runner Bug (D-20)
During live development, background rebuilds (`npm run build`), artifact directory switches (`~/.bb/plugin-host-artifacts/provider-pi-durable/<hash>`), or worker restarts by the BB host daemon:
1. The old worker process (`bb-provider-bridge-worker.mjs`) is killed or disconnected, but child `RunnerProcess` instances remain alive as orphaned processes (PPID 1).
2. The orphaned runner holds an exclusive lock via `proper-lockfile` on `session.sqlite` in the session directory. Because `proper-lockfile` periodically touches mtime, the lock is never considered stale by subsequent runs.
3. When a new turn starts in BB (`turn/start`), the new runner attempts to acquire the lock. After 12 seconds of blind polling, it fails with:
   ```
   Session is already open in another process: ...
   ```
   The thread crashes with HTTP 502 / exit code 1, permanently blocking the user until manual `kill -9` in terminal.

### 1.2 Missing Host Worker Lifecycle Teardown (AP-027)
In `src/host/index.ts`:
The host entry point lacks lifecycle listeners for `process.on("disconnect")`, `SIGTERM`, and `SIGINT`. When the parent host daemon terminates or reloads the bridge worker, the worker exits abruptly without calling `bridge.shutdown()`, leaving active runner children unmanaged.

### 1.3 Harsh Process Termination in `RunnerProcess.kill()`
In `src/host/runner-process.ts`:
`kill()` immediately issues `SIGKILL`. This prevents the runner from executing its graceful termination hook (`activeDurable.close()`) to unlock the SQLite directory and checkpoint the WAL.

### 1.4 Hardcoded `~/.bb` Data Directory in Runner Discovery (GitHub Issue #7)
In `src/host/paths.ts`:
`resolveRunnerPath()` probes only `homedir()/.bb/...` for `bb.db` and plugin cache. On BB installations launched with an explicit data directory (`bb-app --data-dir /path`), the environment variable `BB_DATA_DIR=/path` is set, but the plugin ignores it. The runner bundle is not found, returning an empty models list. Furthermore, probing an existing legacy `~/.bb/bb.db` introduces risks of reading stale entries from old installations.

---

## 2. Canonical Architecture & Proposed Solution

### Layer A: Host Worker Disconnect & Signal Teardown (`src/host/index.ts`)
- Register listeners on `process.on("disconnect")`, `process.on("SIGTERM")`, and `process.on("SIGINT")`.
- When triggered, invoke `await bridge.shutdown()` (which calls `registry.stopAll()`) to ensure all runners are given a clean shutdown signal before calling `process.exit(0)`.
- Guard with `isShuttingDown` flag to ensure idempotency.

### Layer B: Process Ownership Tracking via `session.owner.json` (`src/runner/upstream/session-storage.ts`)
- Upon acquiring the session directory lock, atomically write `session.owner.json` containing:
  ```json
  {
    "pid": 12345,
    "id": "thr_abc123",
    "cwd": "/path/to/project",
    "startedAt": 1791403151585
  }
  ```
- Upon session release, cleanly remove `session.owner.json` before releasing `proper-lockfile`.

### Layer C: Orphan Eviction & Graceful Takeover (`src/runner/upstream/session-storage.ts`)
- When `lockfile.lock` fails:
  1. Inspect `session.owner.json` in the session directory.
  2. If the PID is dead (`!isProcessAlive(pid)`): force unlock stale lockfile, delete `session.owner.json`, and re-acquire lock.
  3. If the PID is alive and belongs to an orphaned runner (`owner.pid !== process.pid`):
     - Send `SIGTERM` to the holding process.
     - Poll for up to 3000ms for clean exit.
     - If the process exits, remove owner file, release lock, and acquire ownership.
  4. If takeover still fails: throw `SessionLockedError` with clear diagnostics identifying the holding PID.

### Layer D: Dual-Stage Termination in `RunnerProcess.kill()` (`src/host/runner-process.ts`)
- First send `SIGTERM` to allow the child runner to run `activeDurable.close()` and remove lockfiles.
- Schedule a fallback `SIGKILL` timer (500ms) unreferenced via `unref()`.

### Layer E: `BB_DATA_DIR` Runner Discovery & Portability (`src/host/paths.ts`)
- Implement `getBbDataDir(env)`: reads `env.BB_DATA_DIR?.trim()`, falls back to `join(homedir(), ".bb")`.
- Use `dataDir` to resolve `bbDbPath`, plugin cache roots, and default session storage directory.
- Preserve fallback checks to ensure backwards compatibility.

---

## 3. File Budget & AP Compliance

| File | Proposed Changes | Est. Lines | Limit (AP-019) | Status |
|---|---|---|---|---|
| `src/host/index.ts` | Disconnect/SIGTERM/SIGINT teardown | ~55 lines | 250 | PASS |
| `src/host/runner-process.ts` | Dual-stage `SIGTERM` -> `SIGKILL` | ~150 lines | 250 | PASS |
| `src/host/paths.ts` | `getBbDataDir` & data-dir propagation | ~165 lines | 250 | PASS |
| `src/runner/upstream/session-storage.ts` | `session.owner.json` & orphan eviction | ~220 lines | 250 | PASS |
| `tests/session-lock-eviction.test.ts` | Tests for dead process cleanup and takeover | ~120 lines | 250 | PASS |
| `tests/worker-teardown.test.ts` | Tests for graceful SIGTERM termination | ~90 lines | 250 | PASS |
| `tests/runner-discovery.test.ts` | Tests for `BB_DATA_DIR` resolution | ~110 lines | 250 | PASS |

---

## 4. Execution Plan (TDD Steps)

1. **Step 1:** Implement `getBbDataDir` in `src/host/paths.ts` and add unit test for `BB_DATA_DIR` in `tests/runner-discovery.test.ts`.
2. **Step 2:** Implement `session.owner.json` and orphan eviction in `src/runner/upstream/session-storage.ts`, verify with `tests/session-lock-eviction.test.ts`.
3. **Step 3:** Implement dual-stage termination in `src/host/runner-process.ts` and worker lifecycle teardown in `src/host/index.ts`, verify with `tests/worker-teardown.test.ts`.
4. **Step 4:** Run full test suite (`npm test`), verify all tests pass.
5. **Step 5:** Build bundle (`npm run build:runner && npm run build:host`), verify cleanly.
