# Arch Improvement Plan: Cycle 69 — Packaging Integrity & Production Dependency Quarantine

**Goal:** Eliminate the duplicate `@get-bb/plugin-sdk` entry from `devDependencies` in `package.json` (F-69-1) so that clean production installations (`npm install --omit=dev`) by BB IDE 0.45+ retain `node_modules/@get-bb/plugin-sdk`, allowing `bb plugin build` to resolve `@get-bb/plugin-sdk/provider-bridge` and `@get-bb/plugin-sdk/host` cleanly. Add automated regression verification for package manifest integrity.

**Governing Standard:** `arch-rules.md` (AP-010 – AP-071), `arch-improvement-review`, `arch-rules-implementation-review`  
**Marketplace Review Blocker:** https://github.com/get-bb/marketplace/pull/501 (SawyerHood review)  
**Target Release:** `v0.2.14`

---

## 1. Findings Triage

| ID | Issue / Review Finding | Severity | Rule | Disposition | Root Cause & Resolution |
|---|---|---|---|---|---|
| **F-69-1** | Duplicate `@get-bb/plugin-sdk` in `devDependencies` breaks clean marketplace install | **P0** | AP-010, AP-026, AP-027 | `fix-now` | `package.json` contains `@get-bb/plugin-sdk: 0.6.15` in both `dependencies` and `devDependencies`. When BB IDE installs plugins via `npm install --omit=dev`, npm classifies the package as development-only and omits `node_modules/@get-bb/plugin-sdk`. Subsequent `bb plugin build` fails with `[plugin: provide-public-host-sdk-runtime] "@get-bb/plugin-sdk/host" is not installed` and `Could not resolve "@get-bb/plugin-sdk/provider-bridge"`. **Fix:** Remove `@get-bb/plugin-sdk` from `devDependencies`. Keep strictly in `dependencies`. |
| **F-69-2** | Missing automated regression test for package manifest integrity | **P2** | AP-028 | `fix-now` | No test verifies that dependencies and devDependencies are strictly disjoint and that manifest entry points point to valid canonical source files. **Fix:** Create `tests/package-integrity.test.ts` asserting disjoint dependency sets, presence of SDK in production dependencies, and valid entrypoints. |

---

## 2. Implementation Slices

### Slice 1: Regression Test Suite (TDD)
- Create `tests/package-integrity.test.ts`.
- Test 1: Asserts `dependencies` and `devDependencies` share zero common keys.
- Test 2: Asserts `@get-bb/plugin-sdk` is present in `dependencies` and absent from `devDependencies`.
- Test 3: Asserts `bb.server` points to `./server.ts` and `bb.host` points to `./src/host/index.ts`.
- Test 4: Verifies manifest engines compatibility (`bb >= 0.45`).

### Slice 2: Manifest Correction (`package.json`)
- Remove `"@get-bb/plugin-sdk": "0.6.15"` from `devDependencies`.
- Bump version to `0.2.14`.

### Slice 3: Isolated Production Reproduction & Bundle Verification
- In a clean directory, run `npm install --omit=dev` and verify `node_modules/@get-bb/plugin-sdk` exists.
- Run `bb plugin build` in the clean reproduction to confirm zero esbuild errors.
- Run full suite: `npm test` and `npm run build`.

### Slice 4: Architecture Verification & Ledger Update
- Check file size limits (AP-019) and zero `as any` (AP-029).
- Record Cycle 69 in `docs/arch-improvement/ledger.md`.
