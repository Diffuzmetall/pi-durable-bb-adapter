# Architecture Improvement Cycle 56 Plan: Boot Integrity & Packaging Parity

**Cycle:** 56 (Stage 1 Foundation Hardening: Zero-Day Boot Slice)  
**Date:** 2026-10-07  
**Repo:** `/Users/vanya/Projects/bb-plugin-provider-pi-durable`  
**Governing Standard:** `arch-rules.md` (AP-010 – AP-071) & `arch-improvement-loop`  
**PRD Reference:** `prd/pi-durable-runtime-boot-integrity`  
**Issues Triaged:** #1, #2, #3  

---

## 1. Goal & Architecture Context Map

Repair the 3 zero-day boot and packaging defects so that `bb-plugin-provider-pi-durable` installs and boots reliably on any machine, strictly preserves project `cwd`, and enforces fail-fast startup semantics.

### Architecture Map
```
Host Bridge: src/host/session.ts <--- AP-012/AP-022: fail-fast start(), timer cleanup, no rogue --session-dir
             src/host/paths.ts   <--- AP-010/AP-027: multi-tier discovery, zero maintainer paths
             src/host/runner-process.ts <--- onExit event handling
                   |
         (IPC stdio + FD 3/4)
                   |
Runner Entry: src/runner/index.ts <--- AP-013/AP-026: strict parseCliArgs, atomic readiness after openDurable
```

---

## 2. Selected Findings (`fix-now`)

1. **[P0] Issue #1 (CWD Hijacking):** `src/host/session.ts` passes `--session-dir <dir>` which `src/runner/index.ts` parser falls through to `args.cwd`.
2. **[P0] Issue #2 (Runner Discovery):** `src/host/paths.ts` fails to find runner in host-cache layout and relies on maintainer-specific `/Users/vanya/...`.
3. **[P1] Issue #3 (Premature Readiness & Swallowed Errors):** `src/runner/index.ts` emits ready before `openDurable()`; `src/host/session.ts` catches and swallows startup/context errors without rejecting.

---

## 3. Implementation Plan & Fix Slices

### Slice 1: Strict CLI Argument Parsing & Project CWD Preservation (Issue #1)
- [ ] **Step 1.1 (TDD Red):** Create `tests/cwd-isolation.test.ts`:
  - Assert that `PiThreadSession` does not pass `--session-dir` in args.
  - Assert that runner's `parseCliArgs` handles `--session-dir` safely without populating `cwd`.
  - Assert that unknown `--options` with values do not clobber `cwd`.
  - Assert that positional `cwd` is only set when explicitly provided as a non-flag argument.
- [ ] **Step 1.2 (Implementation):**
  - In `src/host/session.ts`: Remove `args.push("--session-dir", options.sessionDir)`.
  - In `src/runner/index.ts`: Update `parseCliArgs` to handle `--session-dir` (binding to `args.sessionDir`), skip unknown `--flag <value>` safely, and preserve positional `cwd`.
- [ ] **Step 1.3 (TDD Green):** Run `tests/cwd-isolation.test.ts` to confirm all assertions pass.

### Slice 2: Portable Multi-Tier Runner Discovery (Issue #2)
- [ ] **Step 2.1 (TDD Red):** Create `tests/runner-discovery.test.ts`:
  - Test fixture modeling BB provider cache layout (`cacheRoot/host.mjs` alone, installed plugin in sibling `packageRoot/dist/runner/index.js`).
  - Test path with spaces in directory names.
  - Test explicit `BB_PI_DURABLE_BRIDGE_COMMAND` override.
  - Test explicit `PI_DURABLE_RUNNER_PATH` override.
  - Test genuinely missing runner throwing an actionable error listing all searched paths.
- [ ] **Step 2.2 (Implementation):**
  - In `src/host/paths.ts`: Remove `/Users/vanya/...`.
  - Implement robust multi-tier resolver checking env overrides, relative candidates, sibling cache-layout candidates (`../plugin/dist/runner/index.js`, `../bb-plugin-provider-pi-durable/dist/runner/index.js`), and known BB plugin directories.
- [ ] **Step 2.3 (TDD Green):** Run `tests/runner-discovery.test.ts` to confirm all assertions pass.

### Slice 3: Fail-Fast Startup Handshake & Atomic Readiness (Issue #3)
- [ ] **Step 3.1 (TDD Red):** Create `tests/startup-readiness.test.ts`:
  - Verify that with pending `openDurable()`, active session does NOT emit ready prematurely.
  - Verify that when `openDurable()` fails, the runner exits and no false-positive ready is sent.
  - Verify that `PiThreadSession.start()` rejects when ready check times out or fails (no swallowed error).
  - Verify that `PiThreadSession.start()` rejects when initial context refresh RPC fails.
  - Verify that timer is cleared on resolution/rejection (no 20s hang).
  - Verify that catalogue mode (`--no-session`) emits ready without opening SQLite.
- [ ] **Step 3.2 (Implementation):**
  - In `src/runner/index.ts`: Move active session `ready` notification to AFTER `openDurable()`, `watchEvents.start()`, and RPC reader setup. In `--no-session`, announce ready after model discovery.
  - In `src/host/session.ts`: Refactor `start()` to clear timeout timer properly on both resolve and reject; propagate rejection if readiness fails or runner exits; reject on `refreshContextUsage()` failure.
- [ ] **Step 3.3 (TDD Green):** Run `tests/startup-readiness.test.ts` to confirm all assertions pass.

### Slice 4: Full Verification & AP Compliance
- [ ] **Step 4.1:** Run `npm run build` (builds runner and host).
- [ ] **Step 4.2:** Run full test suite `npm test`.
- [ ] **Step 4.3:** Validate AP-019 line budgets: ensure all modified files are < 250 lines.

### Slice 5: Ledger & Learning
- [ ] **Step 5.1:** Record cycle results in `docs/arch-improvement/ledger.md`.
- [ ] **Step 5.2:** Record durable lessons learned in `MEMORY.md` and project docs.
