# Architecture Improvement Plan — Cycle 58: Tool Execution Telemetry & Steer Protocol Integrity

**Cycle:** 58  
**Date:** 2026-10-07  
**Issues:** #5, #6  
**Standards:** AP-010 – AP-071, `arch-rules.md`, `@bb/provider-bridge-protocol`  

---

## 1. Goal

Eliminate tool invisibility and steer freezing in `bb-plugin-provider-pi-durable`:
1. Ensure all `edit` and `write` tool executions emit schema-compliant `fileChange` deltas (`kind: "add" | "update"` instead of `"create" | "modify"`) with diff payloads so tool cards appear in BB chat.
2. Fix `turn/steer` input acceptance by omitting invalid `providerTurnId` so BB host daemon attaches acceptance to the active turn without 409 conflict, eliminating permanent "Steer pending".
3. Provide reconciliation for affected legacy threads like `thr_ixcw5bus8c`.

---

## 2. Architecture Context & Invariants

- **BB File Change Schema Contract:** In `@bb/provider-bridge-protocol` (and `daemon-bundle.mjs`), `fileChange` items require `changes: Array<{ path: string, kind: "add" | "update" | "delete", oldText?: string, newText?: string, diff?: string }>`. Any unknown `kind` (such as `"create"` or `"modify"`) fails Zod validation and causes the entire delta batch to be silently dropped.
- **BB Steer Acceptance Contract:** In BB's Provider Bridge Protocol, `input.accepted` acknowledges receipt of a client turn request. When steering an active turn, `providerTurnId` must NOT be populated with a BB turn ID (`expectedTurnId`), as host daemon treats non-null `providerTurnId` as an unmapped ID, mints a conflicting new turn ID, and is rejected with 409 `MissingStoredTurnStartedError`.
- **AP-019 (Modular Boundaries):** All modified files strictly remain under 250 lines.

---

## 3. Tasks & Implementation Steps

### Task 1: Failing Tests for `fileChange` Schema & Steer Acceptance (TDD)
- [ ] Add unit test in `tests/tool-delta-translator.test.ts` verifying:
  - `write` maps to `kind: "add"` with `newText` populated.
  - `edit` maps to `kind: "update"` with `edits` mapped to `oldText`/`newText`.
  - Multiple edit blocks map to multiple changes.
- [ ] Add unit test in `tests/bridge-steer.test.ts` verifying:
  - `turn/steer` emits `input.accepted` with `clientRequestId` and without `providerTurnId`.

### Task 2: Implement Fixes
- [ ] Update `src/host/tool-delta-translator.ts`:
  - Change `kind` mapping: `"write"` -> `"add"`, `"edit"` -> `"update"`.
  - Extract `newText` from `args.content` for `write`.
  - Extract `edits` from `args.edits` for `edit` to produce granular changes.
- [ ] Update `src/host/bridge.ts`:
  - In `turn/steer`, remove `providerTurnId: params.expectedTurnId` from `input.accepted` delta.

### Task 3: Verification & Legacy Thread Reconcile
- [ ] Run `npm test` and `npx tsc --noEmit`.
- [ ] Run `npm run build`.
- [ ] Reconcile `thr_ixcw5bus8c` so that stuck pending requests and context indicator are settled.
- [ ] Update `docs/arch-improvement/ledger.md` for Cycle 58.
