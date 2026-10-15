# Arch Improvement Plan: Cycle 64 — Server Manifest Entry Point & Live Settings Activation

**Target:** `bb-plugin-provider-pi-durable`  
**Governing Standards:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Prior Cycle:** Cycle 63 (`v0.2.8`, commit `0129bf5`)  
**Target Version:** `v0.2.9`

---

## 1. Finding from Cycle 63 Audit

| Finding | Target File | Severity | Rule | Resolution Plan |
|---|---|---|---|---|
| **F-64-1** | `package.json` (`manifest.bb.server`) | **P1** | **AP-010, AP-032 (Self-contained and repeatable build):** `package.json` declares `"server": "./dist/server.js"` instead of source `"./server.ts"`. `bb plugin build` bundles from `bb.server`, causing a self-referential build that ignores `server.ts` and leaves settings uncompiled in `dist/server.js`. | Change `"server": "./dist/server.js"` to `"server": "./server.ts"` in `package.json`. Rebuild bundles with `bb plugin build`. Verify `dist/server.js` contains `settings.define` and `deriveProviderOptions`. Reload plugin and verify `bb plugin config provider-pi-durable` outputs the settings. |

---

## 2. Implementation Slices

### Slice 1: Manifest Entry Point Correction
- In `package.json`:
  - Change `"server": "./dist/server.js"` to `"server": "./server.ts"`.

### Slice 2: Bundle Rebuild & Live CLI Verification
- Run `node scripts/build-runner.mjs && bb plugin build`.
- Verify `dist/server.js` contains `bb.settings.define`, `openThinkingByDefault`, `hideThinking`, and `deriveProviderOptions`.
- Reload plugin: `bb plugin reload provider-pi-durable`.
- Verify CLI: run `bb plugin config provider-pi-durable` and confirm it lists `openThinkingByDefault` and `hideThinking`.

### Slice 3: Integration Tests
- Run `npm test` (all 59 tests pass).

### Slice 4: Verification, Version Bump & Release
- Bump version to `0.2.9` in `package.json`.
- Update `docs/arch-improvement/ledger.md` with Cycle 64 entry.
- Commit & tag:
  `git add . && git commit -m "fix(build): correct manifest server entrypoint to activate settings (cycle 64, v0.2.9)" && git tag v0.2.9`
- Reload plugin: `bb plugin reload provider-pi-durable`.
