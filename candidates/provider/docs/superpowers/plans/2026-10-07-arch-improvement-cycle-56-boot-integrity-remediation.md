# Architecture Improvement Cycle 56 Plan: Boot Integrity & Lifecycle Remediation

**Cycle:** 56 (Remediation Slice: Runner Discovery, Process Lifecycle & AP-019 Modularization)  
**Date:** 2026-10-07  
**Repo:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**PRD Reference:** `prd/pi-durable-runtime-boot-integrity`  

---

## 1. Goal & Architecture Context Map

Resolve the architectural review findings across runner discovery, process lifecycle safety, argument parsing, file size limits (AP-019), and lockfile parity (D-1/D-2).

### Architecture Map
```
Host Layer:
  - src/host/paths.ts         <-- Multi-tier runner discovery (env, fromDir, ~/.bb/bb.db, git/npm cache)
  - src/host/session.ts       <-- Guaranteed kill() on start() failure/timeout, AP-022 compliant
  - src/host/catalog.ts       <-- Fail-fast startup, onError/onExit hooks, clearTimeout, kill() on reject

Runner Layer:
  - src/runner/cli-args.ts    <-- Non-greedy flag parsing (--cwd, --no-session, positional preservation)
  - src/runner/sessions.ts    <-- D-2: eliminate false .jsonl suffix for directory sessions
  - src/runner/index.ts       <-- D-1: graceful SIGTERM/SIGINT shutdown with await durable.close()
  - src/runner/runtime-types.ts      <-- AP-019: extracted types and view interfaces (< 100 lines)
  - src/runner/runtime-controller.ts <-- AP-019: extracted controller & compaction logic (< 150 lines)
  - src/runner/runtime.ts            <-- AP-019: composition root facade (< 200 lines)
```

---

## 2. Triaged Findings (`fix-now`)

1. **[P0] Real Runner Discovery (`src/host/paths.ts`):** `resolveRunnerPath` fails when host is executed from BB host artifacts (`~/.bb/plugin-host-artifacts/provider-pi-durable/<hash>/host.mjs`). Must resolve via `PI_DURABLE_RUNNER_PATH`, `BB_PI_DURABLE_BRIDGE_COMMAND`, local `fromDir`, BB SQLite database (`~/.bb/bb.db` `plugins.root_dir`), and BB git/npm cache dirs.
2. **[P1] Zombie Process Leak on Session Start Failure (`src/host/session.ts`):** If startup times out or `refreshContextUsage()` throws, child process continues running. Must call `this.kill()` in error/cleanup handler.
3. **[P1] Model Catalog Startup Lifecycle Flaws (`src/host/catalog.ts`):** Swallows startup errors via empty `catch` + `console.warn`, lacks `onError`/`onExit` hooks, leaks timer, does not kill dead runner on failure.
4. **[P2] AP-019 Monolith Violation in `src/runner/runtime.ts` (430 lines):** Hard limit is 250 lines. Split into `runtime-types.ts`, `runtime-controller.ts`, and facade `runtime.ts`.
5. **[P2] CLI Argument Parser Flag Greediness (`src/runner/cli-args.ts`):** Does not support `--cwd <val>`, and unknown flags or boolean flags can consume subsequent arguments or clobber positional cwd.
6. **[P2] D-1 & D-2 Parity:**
   - D-1: SIGTERM/SIGINT handlers in runner must `await durable.close()` to release `proper-lockfile` immediately.
   - D-2: SQLite database sessions must not have `.jsonl` suffix on directory paths.

---

## 3. Implementation Plan & Fix Slices

### Slice 1: CLI Argument Parsing & D-2 Session Path Integrity
- [ ] **Step 1.1 (TDD Red):** Update `tests/cwd-isolation.test.ts`:
  - Test `--cwd /some/path` argument flag parsing.
  - Test boolean flag `--no-session` followed by positional cwd does not swallow positional.
  - Test unknown boolean flag does not consume next argument.
  - Test session directory path does not include `.jsonl` suffix in `resolveSessionFilePath` and `selectSession`.
- [ ] **Step 1.2 (Implementation):**
  - In `src/runner/cli-args.ts`: Refactor parser with explicit `VALUE_FLAGS` and `BOOLEAN_FLAGS` sets, recognize `--cwd`, keep under 80 lines.
  - In `src/host/paths.ts`: Update `resolveSessionFilePath` to return directory path without `.jsonl`.
  - In `src/runner/sessions.ts`: Strip `.jsonl` and `.sqlite` from `targetSession` when computing directory.
- [ ] **Step 1.3 (TDD Green):** Run `tests/cwd-isolation.test.ts`.

### Slice 2: Multi-Tier Runner Discovery (`src/host/paths.ts`)
- [ ] **Step 2.1 (TDD Red):** Update `tests/runner-discovery.test.ts`:
  - Test discovery via `~/.bb/bb.db` SQLite mock database with `root_dir`.
  - Test discovery via git/npm cache directory structures (`~/.bb/plugins/cache/git/...` and `~/.bb/plugins/cache/npm/...`).
  - Test real BB artifact path `/Users/vanya/.bb/plugin-host-artifacts/provider-pi-durable/<hash>`.
  - Test env overrides and spaces in path.
- [ ] **Step 2.2 (Implementation):**
  - In `src/host/paths.ts`: Implement multi-tier resolution:
    1. Env overrides (`PI_DURABLE_RUNNER_PATH`, `BB_PI_DURABLE_BRIDGE_COMMAND`).
    2. Local relative search from `fromDir`.
    3. Query `~/.bb/bb.db` for `root_dir` of `provider-pi-durable` using `node:sqlite` `DatabaseSync`.
    4. Scan `~/.bb/plugins/cache/git/**` and `~/.bb/plugins/cache/npm/**`.
    5. Standard `~/.bb/plugins/provider-pi-durable/dist/runner/index.js`.
  - Ensure file size stays < 150 lines (AP-019).
- [ ] **Step 2.3 (TDD Green):** Run `tests/runner-discovery.test.ts` and verify real path via `node -e`.

### Slice 3: Process Lifecycle & Guaranteed Cleanup (`src/host/session.ts` & `src/host/catalog.ts`)
- [ ] **Step 3.1 (TDD Red):** Update `tests/startup-readiness.test.ts`:
  - Test that `PiThreadSession.start()` calls `kill()` on timeout or RPC error.
  - Test that `ModelCatalog.start()` propagates failure, hooks `onError`/`onExit`, clears timer, and calls `kill()`.
- [ ] **Step 3.2 (Implementation):**
  - In `src/host/session.ts`: In `start()`, wrap in `try/catch` with `this.kill()` and rethrow.
  - In `src/host/catalog.ts`: Add `onError`/`onExit` hooks, proper timer cleanup, remove error swallowing, call `this.runner?.kill()` on failure.
  - Ensure both files stay < 200 lines (AP-019) with AP-022 compliant error handling.
- [ ] **Step 3.3 (TDD Green):** Run `tests/startup-readiness.test.ts`.

### Slice 4: AP-019 Modularization of `src/runner/runtime.ts` & D-1 Parity
- [ ] **Step 4.1 (Implementation - D-1):**
  - In `src/runner/index.ts`: Hook `SIGTERM`/`SIGINT`/`stdin.end` to graceful cleanup `await activeDurable?.close()` releasing `proper-lockfile`.
- [ ] **Step 4.2 (Implementation - AP-019 Modularization):**
  - Extract `src/runner/runtime-types.ts` (< 100 lines) with all view, notice, model, and controller types.
  - Extract `src/runner/runtime-controller.ts` (< 150 lines) with controller methods (submit, compact, thinking, model, tasks, conversation).
  - Refactor `src/runner/runtime.ts` (< 200 lines) to import from submodules and preserve all public exports.
- [ ] **Step 4.3 (Verification):**
  - Check file line counts: all files < 250 lines.
  - Run `npm run build` and `npm test`.

### Slice 5: Verification, Ledger Update & Commit
- [ ] **Step 5.1:** Execute real artifact discovery test.
- [ ] **Step 5.2:** Run `npm run build` and `npm test` (100% passing).
- [ ] **Step 5.3:** Update `docs/arch-improvement/ledger.md`.
- [ ] **Step 5.4:** Local git commit.
