# Arch Improvement Plan: Cycle 66 — Retirement of Unsupported `openThinkingByDefault` Setting

**Target:** `bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Prior Cycle:** Cycle 65 (`v0.2.10`, commit `e9aa12e`)  
**Target Version:** `v0.2.11`

---

## 1. Findings from Forensic Investigation & Upstream Audit

| Finding | Target File | Severity | Rule | Resolution Plan |
|---|---|---|---|---|
| **F-66-1** | `server.ts` | **P1** | **AP-010, AP-026:** Dead/unsupported declarative setting `openThinkingByDefault` promises auto-expanded thoughts in the chat timeline, but BB IDE core presentation protocol (`threadEventItemPresentationSchema`) and UI (`workspace-checkout-display`) hardcode reasoning operations to collapsed-by-default with no auto-expand hook. | Remove `openThinkingByDefault` descriptor from `bb.settings.define` and from `deriveProviderOptions(ctx)` in `server.ts`. Retain `hideThinking` (which genuinely maps to `presentation.suppress = true`). |
| **F-66-2** | `tests/thinking-presentation.test.ts` | **P2** | **AP-028:** Test suite asserts `openThinkingByDefault` registration and default value, cementing a non-functional contract in unit tests. | Realign test `"server.ts: registers settings and deriveProviderOptions forwards settings correctly"` to verify only `hideThinking` is registered and derived, and assert `openThinkingByDefault` is `undefined`. |

---

## 2. Forensic Evidence & Upstream Parity Analysis

1. **Protocol Schema Invariant:**
   - In `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/start-server.js` (line 571531), `threadEventItemPresentationSchema` defines:
     `{ label, icon, title, detail, suppress, tint, badge }`.
   - Fields for default expansion (`open`, `expanded`, `defaultOpen`) do not exist.
2. **Frontend Invariant:**
   - In `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist/assets/workspace-checkout-display-DPXg7ihz.js`:
     `let M = b && (x || (w ?? (y || C || E)));`
   - Completed reasoning rows have `status: "completed"` and never match `$S(e)` (`status === "pending"`), so they are never in `liveAutoExpandedRowIds`.
   - Active stream `Rd` completely omits `autoExpanded`.
   - Reasonings are collapsed by default by design in BB IDE.
3. **Reference Provider Parity:**
   - Upstream native `bb-plugin-provider-pi` (`server/dist/builtin-plugins/provider-pi/dist/server.js`) declares zero thinking settings.
   - Thoughts are collapsed by default in native `provider-pi`.
   - `bb-plugin-provider-pi-durable` already possesses 100% full parity with native `provider-pi`.

---

## 3. Implementation Slices

### Slice 1: Retire `openThinkingByDefault` in `server.ts`
- In `server.ts`:
  - Remove `openThinkingByDefault` definition from `bb.settings.define`.
  - In `deriveProviderOptions(ctx)`, return only `{ hideThinking: Boolean(ctx?.settings?.hideThinking ?? false) }`.

### Slice 2: Realign Unit Test Suite (`tests/thinking-presentation.test.ts`)
- In `tests/thinking-presentation.test.ts`:
  - Update `server.ts: registers settings and deriveProviderOptions forwards settings correctly` to test that `hideThinking` is present, `openThinkingByDefault` is undefined, and derived options only carry `hideThinking`.

### Slice 3: Verification, Version Bump & Release
- Verify all 63 tests pass: `npm test`.
- Rebuild runner and plugin: `node scripts/build-runner.mjs && bb plugin build`.
- Verify line counts: all `.ts` files < 250 lines (AP-019).
- Bump version to `0.2.11` in `package.json`.
- Update `docs/arch-improvement/ledger.md`.
- Reload plugin: `bb plugin reload provider-pi-durable`.
- Verify CLI config: `bb plugin config provider-pi-durable` displays only `hideThinking`.
